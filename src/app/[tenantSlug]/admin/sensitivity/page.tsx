import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { hasPermission, requirePermission } from "@/lib/rbac";
import { writeAuditEvent } from "@/lib/audit";
import {
  PLATFORM_DEFAULTS,
  BOUNDS,
  mergeWithDefaults,
  validateOverrideInput,
  type CronThresholdKey,
} from "@/lib/cron-thresholds/resolve";

/**
 * Post-PRD hardening item 100 — per-tenant cron threshold overrides.
 *
 * Five knobs across the firm-wide governance crons. NULL row = use
 * the platform default exported from each cron's lib module. Save
 * builds a diff vs the previously-stored row and audits only the
 * keys that actually changed.
 */

const KEYS: ReadonlyArray<{
  key: CronThresholdKey;
  label: string;
  unit: string;
  description: string;
}> = [
  {
    key: "adherenceThreshold",
    label: "FCG-window adherence threshold",
    unit: "fraction",
    description:
      "Below this rate, the daily firm-adherence cron fires the firm_adherence_below_threshold alert. Default 0.80 (80%).",
  },
  {
    key: "ackRateThreshold",
    label: "Escalation ack-rate threshold (sentiment + adherence)",
    unit: "fraction",
    description:
      "Below this rate, the daily firm-ack crons fire firm_*_ack_rate_below_threshold. Same knob covers both pillars per the symmetric mental model. Default 0.75 (75%).",
  },
  {
    key: "staleThresholdHours",
    label: "Stale-escalation hours (sentiment + adherence)",
    unit: "hours",
    description:
      "Hourly stale-sweep crons + the sidebar stale-tone badge + the per-row red-text countdown all use this threshold. Lower = more aggressive nudges. Default 4.",
  },
  {
    key: "minDeadlinedSends",
    label: "Volume floor for FCG-window adherence alert",
    unit: "sends",
    description:
      "Tenants with fewer than this many deadlined sends in the 7-day window skip the firm-adherence alert (so a 2-of-3 sample doesn't trip false alarms). Default 10.",
  },
  {
    key: "minEscalatedForAlert",
    label: "Volume floor for ack-rate alerts",
    unit: "escalations",
    description:
      "Tenants with fewer than this many escalations in the 7-day window skip the firm_*_ack_rate alerts. Default 5.",
  },
];

export default async function SensitivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantSlug: string }>;
  searchParams?: Promise<{ saved?: string; error?: string }>;
}) {
  const { tenantSlug } = await params;
  const sp = (await searchParams) ?? {};
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "tenant:configure-cron-thresholds")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const row = await superDb.tenantCronThreshold.findUnique({
    where: { tenantId: ctx.tenant.id },
  });
  const effective = mergeWithDefaults(row);

  async function saveAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    requirePermission(inner.membership.role, "tenant:configure-cron-thresholds");

    const next: Record<CronThresholdKey, number | null> = {
      adherenceThreshold: null,
      ackRateThreshold: null,
      staleThresholdHours: null,
      minDeadlinedSends: null,
      minEscalatedForAlert: null,
    };
    try {
      for (const { key } of KEYS) {
        const raw = formData.get(key);
        const parsed = validateOverrideInput(
          key,
          typeof raw === "string" ? raw : null,
        );
        next[key] = parsed;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "validation failed";
      redirect(
        `/${tenantSlug}/admin/sensitivity?error=${encodeURIComponent(msg)}`,
      );
    }

    const prior = await superDb.tenantCronThreshold.findUnique({
      where: { tenantId: inner.tenant.id },
    });
    const priorMap: Record<CronThresholdKey, number | null> = {
      adherenceThreshold: prior?.adherenceThreshold ?? null,
      ackRateThreshold: prior?.ackRateThreshold ?? null,
      staleThresholdHours: prior?.staleThresholdHours ?? null,
      minDeadlinedSends: prior?.minDeadlinedSends ?? null,
      minEscalatedForAlert: prior?.minEscalatedForAlert ?? null,
    };
    const changes: Array<{
      key: CronThresholdKey;
      prior: number | null;
      next: number | null;
    }> = [];
    for (const { key } of KEYS) {
      if (priorMap[key] !== next[key]) {
        changes.push({ key, prior: priorMap[key], next: next[key] });
      }
    }
    if (changes.length === 0) {
      // No-op save — don't pollute the chain or bump updatedAt for a
      // form re-submit that didn't actually change anything.
      revalidatePath(`/${tenantSlug}/admin/sensitivity`);
      redirect(`/${tenantSlug}/admin/sensitivity?saved=1`);
    }

    await superDb.tenantCronThreshold.upsert({
      where: { tenantId: inner.tenant.id },
      create: {
        tenantId: inner.tenant.id,
        ...next,
        updatedByMembershipId: inner.membership.id,
      },
      update: {
        ...next,
        updatedByMembershipId: inner.membership.id,
      },
    });

    await writeAuditEvent({
      tenantId: inner.tenant.id,
      eventType: "TENANT_CRON_THRESHOLDS_CHANGED",
      actorMembershipId: inner.membership.id,
      subjectType: "Tenant",
      subjectId: inner.tenant.id,
      payload: { changes },
    });

    revalidatePath(`/${tenantSlug}/admin/sensitivity`);
    redirect(`/${tenantSlug}/admin/sensitivity?saved=1`);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Cron alert sensitivity</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Per-tenant overrides for the governance cron alert thresholds + volume
          floors. Empty input = use the platform default. All five cron families
          read these values at run time; saves are audited (who, when, prior +
          next per knob). Tightening can spam the inbox; loosening can mask a
          real governance gap — change with care.
        </p>
      </header>

      {sp.saved === "1" && (
        <div className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300">
          Saved.
        </div>
      )}
      {sp.error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          {sp.error}
        </div>
      )}

      <form action={saveAction} className="space-y-5">
        {KEYS.map(({ key, label, unit, description }) => {
          const platformDefault = PLATFORM_DEFAULTS[key];
          const stored = row ? (row[key] as number | null) : null;
          const effectiveValue = effective[key];
          const isOverride = stored !== null;
          const { min, max } = BOUNDS[key];
          const isRate = key === "adherenceThreshold" || key === "ackRateThreshold";
          const step = isRate ? "0.01" : "1";
          return (
            <div
              key={key}
              className="rounded border border-zinc-200 p-4 dark:border-zinc-800"
            >
              <label className="block text-sm font-medium" htmlFor={key}>
                {label}
              </label>
              <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                {description}
              </p>
              <div className="mt-3 flex items-center gap-3">
                <input
                  id={key}
                  name={key}
                  type="number"
                  step={step}
                  min={min}
                  max={max}
                  defaultValue={stored !== null ? String(stored) : ""}
                  placeholder={`Default ${platformDefault} ${unit}`}
                  className="w-44 rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                />
                <span className="text-xs text-zinc-500">
                  Effective: <strong>{effectiveValue}</strong> {unit}
                  {isOverride ? " (override)" : " (platform default)"}
                </span>
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                Allowed range: {min} – {max}
              </p>
            </div>
          );
        })}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Save
          </button>
          <p className="text-xs text-zinc-500">
            Empty an input to revert that knob to the platform default.
          </p>
        </div>
      </form>
    </div>
  );
}
