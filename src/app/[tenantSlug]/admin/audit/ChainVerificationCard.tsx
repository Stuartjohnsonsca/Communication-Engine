import type { AuditChainVerification } from "@prisma/client";
import {
  latestVerificationForTenant,
  recentVerificationsForTenant,
} from "@/lib/audit-verify";

const STATUS_PILL: Record<AuditChainVerification["status"], string> = {
  RUNNING: "bg-sky-100 text-sky-800",
  OK: "bg-emerald-100 text-emerald-800",
  TAMPERED: "bg-red-100 text-red-800",
  ERRORED: "bg-amber-100 text-amber-900",
};

const STATUS_LABEL: Record<AuditChainVerification["status"], string> = {
  RUNNING: "Running",
  OK: "OK",
  TAMPERED: "TAMPERED",
  ERRORED: "Errored",
};

/**
 * Surfaces the background chain-verification status on /admin/audit so a
 * FIRM_ADMIN or FCT_MEMBER can see at a glance whether the daily
 * cron-driven verifier last passed.
 *
 * Server component — fetches inside the request because the page is
 * already dynamic (audit filtering uses URL params).
 */
export default async function ChainVerificationCard({
  tenantId,
}: {
  tenantId: string;
}) {
  const [latest, recent] = await Promise.all([
    latestVerificationForTenant(tenantId),
    recentVerificationsForTenant(tenantId, 5),
  ]);

  if (!latest) {
    return (
      <div className="card text-xs text-ink/60">
        <div className="font-medium text-ink">Background chain verification</div>
        <p className="mt-1">
          No daily verification pass has run yet. Wire <code>/api/cron/audit-verify</code> on
          your scheduler (recommended 02:30 UTC daily) — until then the chain integrity is
          only checked when an admin clicks &ldquo;Verify chain&rdquo; above.
        </p>
      </div>
    );
  }

  const isWarn = latest.status === "TAMPERED" || latest.status === "ERRORED";
  const containerClass = isWarn
    ? "card border-red-300 bg-red-50/30"
    : "card";

  return (
    <div className={containerClass}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Background chain verification</h2>
            <span className={`tag ${STATUS_PILL[latest.status]}`}>{STATUS_LABEL[latest.status]}</span>
          </div>
          <p className="text-xs text-ink/60">
            Last run: <span className="font-medium text-ink">{formatTs(latest.finishedAt ?? latest.startedAt)}</span>
            {latest.tookMs !== null && (
              <span className="ml-2 text-ink/50">({latest.tookMs}ms)</span>
            )}
            {latest.eventCount > 0 && (
              <span className="ml-2 text-ink/50">across {latest.eventCount} event{latest.eventCount === 1 ? "" : "s"}</span>
            )}
          </p>
        </div>
      </div>

      {latest.status === "TAMPERED" && (
        <div className="mt-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900">
          <div className="font-medium">Hash mismatch detected at seq {String(latest.failedAtSeq)}.</div>
          <p className="mt-1">
            This indicates one of: a direct DB write that bypassed the immutability trigger, a
            backup restore that didn&apos;t preserve hash linkage, or a code-path bug. The
            FIRM_ADMINs of this tenant and Acumon operators have been notified. Compare the
            affected seq against your most recent verified backup before taking any action; per
            the DPA, contractually-relevant chain integrity is a 24-hour notification
            obligation.
          </p>
        </div>
      )}

      {latest.status === "ERRORED" && latest.errorMessage && (
        <div className="mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <div className="font-medium">Verification didn&apos;t complete.</div>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono">{latest.errorMessage}</pre>
        </div>
      )}

      {recent.length > 1 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-ink/60">Recent runs</summary>
          <ul className="mt-2 space-y-1 text-xs">
            {recent.map((r) => (
              <li key={r.id} className="flex items-center gap-2">
                <span className={`tag ${STATUS_PILL[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                <span className="text-ink/70">{formatTs(r.startedAt)}</span>
                {r.failedAtSeq !== null && (
                  <span className="text-red-700">seq {String(r.failedAtSeq)}</span>
                )}
                {r.tookMs !== null && r.tookMs !== undefined && (
                  <span className="text-ink/50">{r.tookMs}ms</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function formatTs(d: Date | null): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 19).replace("T", " ") + " UTC";
}
