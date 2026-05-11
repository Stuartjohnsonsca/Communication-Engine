import type { Tenant } from "@prisma/client";
import { superDb } from "@/lib/db";
import { verifyAuditChain, writeAuditEvent } from "@/lib/audit";
import { reportError } from "@/lib/observability";

/**
 * Background audit-chain verification (post-PRD hardening item 23).
 *
 * `runChainVerificationPass()` iterates every tenant that has an audit
 * chain (status in ACTIVE/SANDBOX/TERMINATING — even a terminating
 * tenant's chain must be auditable until hard-delete; PRD §12.5 retention
 * keeps the audit row even past tenant deletion). For each:
 *
 *   1. Create an `AuditChainVerification` row with status=RUNNING.
 *   2. Call the existing pure `verifyAuditChain(tenantId)` which loads
 *      every event ordered by seq asc and recomputes hashes from genesis.
 *   3. Update the row with status=OK/TAMPERED/ERRORED + timing.
 *   4. On TAMPERED: write `AUDIT_CHAIN_TAMPERED` audit on the AFFECTED
 *      tenant's chain (so the tenant's own DPO can see "your chain was
 *      tampered") AND on the Acumon operator chain (so platform operators
 *      see the incident); dispatch immediate notification to FIRM_ADMIN +
 *      ACUMON_ADMIN of both sides. The new audit row is the LAST entry
 *      in the affected chain — verification stopped at `failedAtSeq` so
 *      the chain after that point is already untrusted; the new event
 *      legitimately extends from `last.hash` (the current physical tip)
 *      and the next pass will reaffirm the new event chains correctly
 *      from that tip.
 *   5. On ERRORED (verification crashed — DB timeout etc.): record the
 *      error message but do NOT alert; transient errors aren't tamper.
 *
 * Dedupe: alerts fire ONCE per (tenantId, failedAtSeq) pair. If the same
 * tamper persists across daily runs, only the first day notifies; the
 * row still records the outcome so /admin/audit reflects the persistent
 * problem. A NEW failedAtSeq (tamper extended to a different event)
 * re-alerts immediately. After 7 days an unchanged tamper re-alerts
 * (operator escalation path — chain has been broken for a week and
 * nobody has fixed it).
 *
 * Concurrency: `verifyAuditChain` is read-only; we don't lock the chain.
 * If a new event is appended while we verify, it shows up at the end and
 * is verified along with everything else. The DB-level immutability
 * trigger blocks UPDATE/DELETE so the verification can never race
 * against a tamper that's happening during the pass.
 *
 * Safe to invoke concurrently with itself — every pass writes its OWN
 * `AuditChainVerification` row keyed by the cuid, and the dedupe is
 * driven off `notifiedAt` so two passes that both detect the same
 * tamper write two rows but only one alerts.
 */

const TAMPER_RE_ALERT_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export type RunPassResult = {
  evaluated: number;
  ok: number;
  tampered: number;
  errored: number;
  /** Per-tenant outcomes; useful for the cron response log. */
  outcomes: Array<{
    tenantId: string;
    tenantSlug: string;
    status: "OK" | "TAMPERED" | "ERRORED";
    eventCount: number;
    failedAtSeq: bigint | null;
    tookMs: number;
    notified: boolean;
  }>;
};

export async function runChainVerificationPass(): Promise<RunPassResult> {
  const tenants = await superDb.tenant.findMany({
    where: {
      status: { in: ["ACTIVE", "SANDBOX", "TERMINATING"] },
    },
    select: { id: true, slug: true, name: true, status: true },
  });

  const outcomes: RunPassResult["outcomes"] = [];
  let ok = 0;
  let tampered = 0;
  let errored = 0;

  for (const tenant of tenants) {
    const outcome = await verifyOneTenant(tenant);
    outcomes.push(outcome);
    if (outcome.status === "OK") ok += 1;
    else if (outcome.status === "TAMPERED") tampered += 1;
    else errored += 1;
  }

  return {
    evaluated: tenants.length,
    ok,
    tampered,
    errored,
    outcomes,
  };
}

async function verifyOneTenant(
  tenant: Pick<Tenant, "id" | "slug" | "name">,
): Promise<RunPassResult["outcomes"][number]> {
  const row = await superDb.auditChainVerification.create({
    data: {
      tenantId: tenant.id,
      status: "RUNNING",
    },
  });

  const startedAt = Date.now();
  try {
    const result = await verifyAuditChain(tenant.id);
    const latest = await superDb.auditEvent.findFirst({
      where: { tenantId: tenant.id },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    const eventCount = latest ? Number(latest.seq) : 0;
    const tookMs = Date.now() - startedAt;

    if (result.ok) {
      await superDb.auditChainVerification.update({
        where: { id: row.id },
        data: {
          status: "OK",
          finishedAt: new Date(),
          eventCount,
          tookMs,
        },
      });
      return {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        status: "OK",
        eventCount,
        failedAtSeq: null,
        tookMs,
        notified: false,
      };
    }

    // TAMPERED — record + decide alert.
    const failedAtSeq = result.failedAt ?? null;
    await superDb.auditChainVerification.update({
      where: { id: row.id },
      data: {
        status: "TAMPERED",
        finishedAt: new Date(),
        eventCount,
        failedAtSeq: failedAtSeq,
        tookMs,
      },
    });
    const notified = await fireTamperAlertIfDue(tenant, row.id, failedAtSeq);
    return {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      status: "TAMPERED",
      eventCount,
      failedAtSeq,
      tookMs,
      notified,
    };
  } catch (err) {
    const tookMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    await superDb.auditChainVerification.update({
      where: { id: row.id },
      data: {
        status: "ERRORED",
        finishedAt: new Date(),
        tookMs,
        errorMessage: message.slice(0, 500),
      },
    });
    reportError(err, {
      tags: { kind: "audit-chain-verify", tenantId: tenant.id, slug: tenant.slug },
    });
    return {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      status: "ERRORED",
      eventCount: 0,
      failedAtSeq: null,
      tookMs,
      notified: false,
    };
  }
}

/**
 * Decide whether to write the AUDIT_CHAIN_TAMPERED audit event(s) +
 * dispatch notifications for this tamper.
 *
 * Returns true iff we alerted. Dedupe: if a recent (within
 * TAMPER_RE_ALERT_AFTER_MS) AuditChainVerification row exists for the
 * SAME tenant with the SAME failedAtSeq AND it has notifiedAt set, skip.
 * Otherwise fire + stamp `notifiedAt` on THIS row.
 *
 * `failedAtSeq=null` shouldn't reach this path (we only call it when
 * status=TAMPERED), but guard anyway.
 */
async function fireTamperAlertIfDue(
  tenant: Pick<Tenant, "id" | "slug" | "name">,
  verificationId: string,
  failedAtSeq: bigint | null,
): Promise<boolean> {
  if (failedAtSeq === null) return false;

  const cutoff = new Date(Date.now() - TAMPER_RE_ALERT_AFTER_MS);
  const recentlyAlerted = await superDb.auditChainVerification.findFirst({
    where: {
      tenantId: tenant.id,
      id: { not: verificationId },
      status: "TAMPERED",
      failedAtSeq: failedAtSeq,
      notifiedAt: { gte: cutoff, not: null },
    },
    orderBy: { startedAt: "desc" },
  });
  if (recentlyAlerted) return false;

  // Stamp THIS row first so a racing second pass can't double-fire.
  // Atomic: only succeeds if notifiedAt was null when we read it.
  const claim = await superDb.auditChainVerification.updateMany({
    where: { id: verificationId, notifiedAt: null },
    data: { notifiedAt: new Date() },
  });
  if (claim.count !== 1) return false;

  try {
    await emitTamperAudit(tenant, failedAtSeq);
    await emitTamperNotification(tenant, failedAtSeq);
    return true;
  } catch (err) {
    reportError(err, {
      tags: { kind: "audit-chain-tamper-alert", tenantId: tenant.id, slug: tenant.slug },
    });
    return false;
  }
}

async function emitTamperAudit(
  tenant: Pick<Tenant, "id" | "slug" | "name">,
  failedAtSeq: bigint,
): Promise<void> {
  // Affected tenant's chain — DPO-visible.
  await writeAuditEvent({
    tenantId: tenant.id,
    eventType: "AUDIT_CHAIN_TAMPERED",
    subjectType: "AuditChain",
    subjectId: tenant.id,
    payload: {
      tenantSlug: tenant.slug,
      failedAtSeq: Number(failedAtSeq),
      detectedBy: "audit-chain-verify-cron",
    },
  });

  // Mirror on Acumon operator chain — platform incident visibility.
  const operator = await superDb.tenant.findUnique({
    where: { slug: "acumon" },
    select: { id: true },
  });
  if (operator && operator.id !== tenant.id) {
    await writeAuditEvent({
      tenantId: operator.id,
      eventType: "AUDIT_CHAIN_TAMPERED",
      subjectType: "AuditChain",
      subjectId: tenant.id,
      payload: {
        affectedTenantSlug: tenant.slug,
        affectedTenantName: tenant.name,
        failedAtSeq: Number(failedAtSeq),
        detectedBy: "audit-chain-verify-cron",
      },
    });
  }
}

async function emitTamperNotification(
  tenant: Pick<Tenant, "id" | "slug" | "name">,
  failedAtSeq: bigint,
): Promise<void> {
  // Lazy import to avoid a circular load chain — notifications/index pulls
  // in audit + adherence + sentiment etc. Direct import from immediate.
  const { dispatchAuditChainTampered } = await import("@/lib/notifications/immediate");
  await dispatchAuditChainTampered({
    affectedTenantId: tenant.id,
    affectedTenantSlug: tenant.slug,
    affectedTenantName: tenant.name,
    failedAtSeq: Number(failedAtSeq),
  });
}
