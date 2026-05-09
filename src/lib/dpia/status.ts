import { createHash } from "node:crypto";
import { superDb } from "@/lib/db";
import { canonicalJson } from "@/lib/audit";
import type { DPIAAttestation } from "@prisma/client";

/**
 * DPIA lifecycle (PRD §12.2).
 *
 * Each tenant has a versioned chain of DPIAAttestation rows. The latest row
 * controls. An attestation is `CURRENT` while:
 *   - now < expiresAt
 *   - the snapshot of tenant scope captured at sign-off still matches the
 *     live scope (channels, performance opt-ins, sentiment opt-ins, etc.)
 *
 * Scope drift triggers a re-attestation requirement per PRD: "On any feature
 * change that materially affects the DPIA scope (e.g. new channel enabled,
 * performance dashboard turned on, Sales Identifier turned on), the system
 * blocks activation until re-attestation."
 *
 * Annual re-attestation: every 365 days. After expiry, a 30-day grace window
 * applies before "graceful service degradation: drafting continues; dashboards
 * and Sales Identifier features are paused."
 */

export type DpiaState =
  | "NEVER"
  | "CURRENT"
  | "SCOPE_DRIFT"
  | "EXPIRING_SOON"
  | "WITHIN_GRACE"
  | "DEGRADED";

export const ATTESTATION_TTL_DAYS = 365;
export const POST_EXPIRY_GRACE_DAYS = 30;
export const EXPIRING_SOON_DAYS = 30;

export type DpiaScopeSnapshot = {
  jurisdiction: string;
  retentionDays: number;
  channelKinds: string[];
  perfDashOptInUserCount: number;
  sentimentOutOptInUserCount: number;
  salesIdentifierEnabled: boolean;
  hash: string;
};

export type DpiaStatus = {
  state: DpiaState;
  attestation: DPIAAttestation | null;
  expiresAt: Date | null;
  daysUntilExpiry: number | null;
  /** True while the firm has a current, non-drift attestation. */
  isCurrent: boolean;
  /** Per PRD: dashboards and SI pause once we cross the post-expiry grace cliff. */
  dashboardsAllowed: boolean;
  salesIdentifierAllowed: boolean;
  /** Suggested banner copy. Null for CURRENT. */
  banner: { tone: "info" | "warn" | "alert"; message: string } | null;
  /** Snapshot of live tenant scope (whatever we'd hash today). */
  liveScope: DpiaScopeSnapshot;
  /** Snapshot the latest attestation captured (null if NEVER). */
  attestedScope: DpiaScopeSnapshot | null;
};

/**
 * Compute the live scope of the tenant for DPIA-drift comparison. Anything
 * that materially changes a Client's DPA review goes here. Adding a new
 * channel, turning on perf dashboards for an extra User, or enabling SI all
 * change the hash and trigger re-attestation.
 */
export async function computeLiveScope(tenantId: string): Promise<DpiaScopeSnapshot> {
  const [tenant, channels, perfOptIns, sentOptIns, oppCount] = await Promise.all([
    superDb.tenant.findUnique({
      where: { id: tenantId },
      select: { jurisdiction: true, retentionDays: true },
    }),
    superDb.channel.findMany({
      where: { tenantId, status: { not: "INACTIVE" } },
      select: { kind: true },
    }),
    superDb.membership.count({
      where: { tenantId, status: "ACTIVE", perfDashOptIn: true },
    }),
    superDb.membership.count({
      where: { tenantId, status: "ACTIVE", sentimentOutOptIn: true },
    }),
    superDb.opportunityCandidate.count({ where: { tenantId } }),
  ]);
  if (!tenant) throw new Error(`computeLiveScope: tenant ${tenantId} not found`);

  const channelKinds = Array.from(new Set(channels.map((c) => c.kind))).sort();
  const snapshot = {
    jurisdiction: tenant.jurisdiction,
    retentionDays: tenant.retentionDays,
    channelKinds,
    perfDashOptInUserCount: perfOptIns,
    sentimentOutOptInUserCount: sentOptIns,
    salesIdentifierEnabled: oppCount > 0,
  };
  return { ...snapshot, hash: hashScope(snapshot) };
}

export function hashScope(s: Omit<DpiaScopeSnapshot, "hash">): string {
  return createHash("sha256").update(canonicalJson(s)).digest("hex").slice(0, 32);
}

export async function getDpiaStatus(tenantId: string, now = new Date()): Promise<DpiaStatus> {
  const [latest, liveScope] = await Promise.all([
    superDb.dPIAAttestation.findFirst({
      where: { tenantId },
      orderBy: { version: "desc" },
    }),
    computeLiveScope(tenantId),
  ]);

  if (!latest) {
    return {
      state: "NEVER",
      attestation: null,
      expiresAt: null,
      daysUntilExpiry: null,
      isCurrent: false,
      dashboardsAllowed: false,
      salesIdentifierAllowed: false,
      banner: {
        tone: "alert",
        message:
          "No DPIA attested for this tenant. Dashboards and Sales Identifier are paused until a Firm Administrator completes the DPIA Helper.",
      },
      liveScope,
      attestedScope: null,
    };
  }

  const attestedScope = readAttestedScope(latest);
  const expiresAt = latest.expiresAt ?? addDays(latest.signedAt, ATTESTATION_TTL_DAYS);
  const expired = expiresAt.getTime() <= now.getTime();
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysUntilExpiry = Math.round((expiresAt.getTime() - now.getTime()) / msPerDay);
  const drift = !attestedScope || attestedScope.hash !== liveScope.hash;

  if (expired) {
    const daysOver = Math.round((now.getTime() - expiresAt.getTime()) / msPerDay);
    if (daysOver > POST_EXPIRY_GRACE_DAYS) {
      return {
        state: "DEGRADED",
        attestation: latest,
        expiresAt,
        daysUntilExpiry,
        isCurrent: false,
        dashboardsAllowed: false,
        salesIdentifierAllowed: false,
        banner: {
          tone: "alert",
          message: `DPIA expired ${daysOver} days ago. Per PRD §12.2 dashboards and Sales Identifier are paused; drafting continues. Re-attest in DPIA.`,
        },
        liveScope,
        attestedScope,
      };
    }
    return {
      state: "WITHIN_GRACE",
      attestation: latest,
      expiresAt,
      daysUntilExpiry,
      isCurrent: false,
      dashboardsAllowed: true,
      salesIdentifierAllowed: true,
      banner: {
        tone: "warn",
        message: `DPIA expired ${daysOver} day${daysOver === 1 ? "" : "s"} ago. ${POST_EXPIRY_GRACE_DAYS - daysOver} day${POST_EXPIRY_GRACE_DAYS - daysOver === 1 ? "" : "s"} remain before dashboards and Sales Identifier auto-pause. Re-attest in DPIA.`,
      },
      liveScope,
      attestedScope,
    };
  }

  if (drift) {
    return {
      state: "SCOPE_DRIFT",
      attestation: latest,
      expiresAt,
      daysUntilExpiry,
      isCurrent: false,
      dashboardsAllowed: true,
      salesIdentifierAllowed: true,
      banner: {
        tone: "warn",
        message:
          "Tenant scope has changed since the DPIA was last attested (channel, opt-in or feature change). Re-attestation required before further activation. Open DPIA.",
      },
      liveScope,
      attestedScope,
    };
  }

  if (daysUntilExpiry <= EXPIRING_SOON_DAYS) {
    return {
      state: "EXPIRING_SOON",
      attestation: latest,
      expiresAt,
      daysUntilExpiry,
      isCurrent: true,
      dashboardsAllowed: true,
      salesIdentifierAllowed: true,
      banner: {
        tone: "info",
        message: `DPIA expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}. Annual re-attestation due — open DPIA when ready.`,
      },
      liveScope,
      attestedScope,
    };
  }

  return {
    state: "CURRENT",
    attestation: latest,
    expiresAt,
    daysUntilExpiry,
    isCurrent: true,
    dashboardsAllowed: true,
    salesIdentifierAllowed: true,
    banner: null,
    liveScope,
    attestedScope,
  };
}

function readAttestedScope(att: DPIAAttestation): DpiaScopeSnapshot | null {
  const raw = att.scope as unknown;
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const snap = obj.snapshot as Record<string, unknown> | undefined;
  if (!snap) return null;
  const hash = typeof snap.hash === "string" ? snap.hash : null;
  if (!hash) return null;
  return {
    jurisdiction: String(snap.jurisdiction ?? ""),
    retentionDays: Number(snap.retentionDays ?? 0),
    channelKinds: Array.isArray(snap.channelKinds) ? (snap.channelKinds as string[]) : [],
    perfDashOptInUserCount: Number(snap.perfDashOptInUserCount ?? 0),
    sentimentOutOptInUserCount: Number(snap.sentimentOutOptInUserCount ?? 0),
    salesIdentifierEnabled: Boolean(snap.salesIdentifierEnabled),
    hash,
  };
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}
