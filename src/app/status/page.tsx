import Link from "next/link";
import {
  SEVERITY_LABELS,
  SLA_KIND_LABELS,
  STATUS_LABELS,
  getPublicStatus,
  type RedactedIncident,
  type SlaRollup,
  type TermsKindStatus,
} from "@/lib/status";
import type { SubProcessor, AccessibilityStatement } from "@prisma/client";

// Public, always live: skip build-time prerender so we don't need a DB
// at build, and recompute per-request. The aggregations are cheap (one
// row per target/measurement/incident) so even a hot scraper is fine.
export const dynamic = "force-dynamic";

export default async function StatusPage() {
  const status = await getPublicStatus();

  const overall = overallSlaPosture(status.sla);
  const openIncidents = status.incidents.filter(
    (i) => i.status !== "RESOLVED",
  );

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Service status</h1>
        <p className="text-sm text-ink/70">
          Aggregate posture across every Client tenant for the current measurement period.
          Individual tenants see their own per-tenant rollups inside their{" "}
          <code className="rounded bg-ink/5 px-1">/{`<tenant>`}/sla</code> view.
        </p>
        <p className="text-xs text-ink/50">
          Generated {status.generatedAt.toISOString().slice(0, 19).replace("T", " ")} UTC ·
          refreshed every 60 seconds.
        </p>
      </header>

      <section
        className={`card flex flex-wrap items-center justify-between gap-3 ${
          overall.tone === "ok"
            ? "border-emerald-300 bg-emerald-50/50"
            : overall.tone === "degraded"
              ? "border-amber-300 bg-amber-50/50"
              : "border-red-300 bg-red-50/50"
        }`}
      >
        <div>
          <div className="text-sm text-ink/60">Overall posture</div>
          <div className="text-2xl font-semibold">{overall.headline}</div>
        </div>
        <div className="text-right text-xs text-ink/60">
          <div>
            <strong>{overall.met}</strong> targets met
            {overall.missed > 0 && (
              <>
                {" "}
                · <strong className="text-red-700">{overall.missed}</strong> missed
              </>
            )}
            {overall.insufficient > 0 && (
              <>
                {" "}
                · <strong>{overall.insufficient}</strong> insufficient data
              </>
            )}
          </div>
          {openIncidents.length > 0 && (
            <div className="mt-1 text-red-700">
              <strong>{openIncidents.length}</strong> open incident
              {openIncidents.length === 1 ? "" : "s"}
            </div>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Service-level targets (PRD §13.1)</h2>
        <p className="text-xs text-ink/60">
          Per-target rollup across every Client tenant for the most recent period that has
          measurements. Latency targets are reported as median-of-tenant-medians;
          availability is sample-weighted across observed coverage.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          {status.sla.map((row) => (
            <SlaCard key={row.target.id} row={row} />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Recent incidents (PRD §12.9)</h2>
        <p className="text-xs text-ink/60">
          Personal-data breach incidents in the last 90 days. Affected-tenant identities are
          never published — counts are aggregate. Each affected Client receives a per-tenant
          notification under the contractual 24-hour SLA.
        </p>
        {status.incidents.length === 0 ? (
          <div className="card text-sm text-ink/60">
            No personal-data breach incidents recorded in the last 90 days.
          </div>
        ) : (
          <ul className="space-y-3">
            {status.incidents.map((i) => (
              <IncidentItem key={i.code} incident={i} />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Sub-processors (PRD §15.3)</h2>
        <p className="text-xs text-ink/60">
          Published in advance of contracting per the EU Data Act commitment. Same data each
          Client sees on their <code className="rounded bg-ink/5 px-1">/switching</code> page.
        </p>
        {status.subProcessors.length === 0 ? (
          <div className="card text-sm text-ink/60">No sub-processors recorded.</div>
        ) : (
          <ul className="grid gap-2 md:grid-cols-2">
            {status.subProcessors.map((s) => (
              <SubProcessorCard key={s.id} sp={s} />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Accessibility (PRD §13.4)</h2>
        <AccessibilitySummary statement={status.accessibility} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Contract versioning (PRD §15.4)</h2>
        <p className="text-xs text-ink/60">
          We persist every signed contract version per-tenant. The catalogue of in-platform
          terms kinds and the latest cut version (across any tenant) is shown below. The
          contents of any one tenant&rsquo;s contracts are never published — request your own
          via your DPA contact.
        </p>
        <ul className="grid gap-2 md:grid-cols-2">
          {status.terms.map((t) => (
            <TermsCard key={t.kind} terms={t} />
          ))}
        </ul>
      </section>

      <section className="card space-y-2 border-emerald-200 bg-emerald-50/30">
        <h2 className="text-base font-medium">Security disclosure</h2>
        <p className="text-sm text-ink/70">
          Found a vulnerability? Email <strong>security@acumon.com</strong>. Our coordinated
          disclosure policy and what to expect from us are documented in{" "}
          <a
            href="https://github.com/Stuartjohnsonsca/Communication-Engine/blob/main/SECURITY.md"
            className="underline decoration-dotted"
          >
            SECURITY.md
          </a>
          ; a machine-readable RFC 9116 record is at{" "}
          <a href="/.well-known/security.txt" className="underline decoration-dotted">
            /.well-known/security.txt
          </a>
          .
        </p>
      </section>

      <section className="card text-xs text-ink/60">
        Need more detail than this surface provides? Authenticated tenants see per-tenant
        breakdowns inside their <code className="rounded bg-ink/5 px-1">/sla</code>,{" "}
        <code className="rounded bg-ink/5 px-1">/compliance/breaches</code>,{" "}
        <code className="rounded bg-ink/5 px-1">/switching</code>,{" "}
        <code className="rounded bg-ink/5 px-1">/accessibility</code>, and{" "}
        <code className="rounded bg-ink/5 px-1">/admin/terms</code> views.{" "}
        <Link href="/login" className="underline decoration-dotted">
          Sign in
        </Link>{" "}
        to reach yours.
      </section>
    </div>
  );
}

function overallSlaPosture(rollups: SlaRollup[]): {
  tone: "ok" | "degraded" | "down";
  headline: string;
  met: number;
  missed: number;
  insufficient: number;
} {
  const met = rollups.filter((r) => r.aggregateOutcome === "MET").length;
  const missed = rollups.filter((r) => r.aggregateOutcome === "MISSED").length;
  const insufficient = rollups.filter((r) => r.aggregateOutcome === "INSUFFICIENT_DATA").length;
  const tone: "ok" | "degraded" | "down" =
    missed === 0 ? "ok" : missed >= Math.ceil(rollups.length / 2) ? "down" : "degraded";
  const headline =
    tone === "ok"
      ? "All systems operational"
      : tone === "down"
        ? "Service degraded"
        : "Partial degradation";
  return { tone, headline, met, missed, insufficient };
}

function SlaCard({ row }: { row: SlaRollup }) {
  const tone =
    row.aggregateOutcome === "MET"
      ? "border-emerald-300 bg-emerald-50/40"
      : row.aggregateOutcome === "MISSED"
        ? "border-red-300 bg-red-50/40"
        : "border-ink/10";
  const valueText =
    row.aggregateObserved == null
      ? "—"
      : `${formatNumber(row.aggregateObserved, row.target.kind === "AVAILABILITY" ? 2 : 2)} ${row.target.unit}`;
  return (
    <div className={`rounded border p-3 text-sm ${tone}`}>
      <div className="flex items-baseline justify-between">
        <span className="font-medium">{row.target.name}</span>
        <span className="text-xs text-ink/60">{SLA_KIND_LABELS[row.target.kind]}</span>
      </div>
      <div className="mt-1 text-xs text-ink/60">
        Target: {row.target.threshold} {row.target.unit} · {row.target.aggregation} ·{" "}
        {row.target.scope}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-semibold">{valueText}</span>
        {row.period && (
          <span className="text-xs text-ink/60">
            ({row.period} · {row.aggregateOutcome})
          </span>
        )}
      </div>
      {row.tenantsMeasured > 0 ? (
        <div className="mt-1 text-[11px] text-ink/50">
          {row.met} met · {row.missed} missed · {row.insufficient} insufficient ·{" "}
          {row.tenantsMeasured} tenant{row.tenantsMeasured === 1 ? "" : "s"} ·{" "}
          {row.sampleN.toLocaleString()} sample{row.sampleN === 1 ? "" : "s"}
        </div>
      ) : (
        <div className="mt-1 text-[11px] text-ink/50">No measurements yet for this target.</div>
      )}
    </div>
  );
}

function IncidentItem({ incident }: { incident: RedactedIncident }) {
  const tone =
    incident.status === "RESOLVED"
      ? "border-ink/10"
      : incident.severity === "CRITICAL" || incident.severity === "HIGH"
        ? "border-red-300 bg-red-50/40"
        : "border-amber-300 bg-amber-50/40";
  return (
    <li className={`rounded border p-3 text-sm ${tone}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="font-medium">{incident.title}</span>{" "}
          <code className="ml-1 rounded bg-ink/5 px-1 text-xs">{incident.code}</code>
          <span className="ml-2 tag bg-ink/5 text-xs">{SEVERITY_LABELS[incident.severity]}</span>
          <span className="ml-1 tag bg-ink/5 text-xs">{STATUS_LABELS[incident.status]}</span>
          {incident.isPersonalData && (
            <span className="ml-1 tag bg-ink/5 text-xs">Personal data</span>
          )}
        </div>
        <span className="text-xs text-ink/50">
          Aware {incident.awareAt.toISOString().slice(0, 16).replace("T", " ")} UTC
        </span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm">{incident.description}</p>
      {incident.affectedCategories.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {incident.affectedCategories.map((c) => (
            <span key={c} className="tag bg-ink/5 text-xs">
              {c}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2 text-xs text-ink/60">
        {incident.affectedClientCount} client
        {incident.affectedClientCount === 1 ? "" : "s"} affected
        {incident.containedAt && (
          <>
            {" "}
            · Contained {incident.containedAt.toISOString().slice(0, 10)}
          </>
        )}
        {incident.resolvedAt && (
          <>
            {" "}
            · Resolved {incident.resolvedAt.toISOString().slice(0, 10)}
          </>
        )}
      </div>
    </li>
  );
}

function SubProcessorCard({ sp }: { sp: SubProcessor }) {
  return (
    <li className="rounded border border-ink/10 bg-white p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-medium">{sp.name}</div>
        <span className="text-xs text-ink/60">{sp.jurisdiction}</span>
      </div>
      <div className="mt-1 text-xs text-ink/70">{sp.role}</div>
      {sp.dataCategories.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {sp.dataCategories.map((c) => (
            <span key={c} className="tag bg-ink/5 text-xs">
              {c}
            </span>
          ))}
        </div>
      )}
      <div className="mt-1 text-[11px] text-ink/50">
        Added {sp.addedAt.toISOString().slice(0, 10)}
      </div>
    </li>
  );
}

function AccessibilitySummary({ statement }: { statement: AccessibilityStatement | null }) {
  if (!statement) {
    return (
      <div className="card text-sm text-ink/60">No accessibility statement published yet.</div>
    );
  }
  return (
    <div className="card space-y-2 text-sm">
      <div>
        Version <strong>v{statement.version}</strong> · conformance target{" "}
        <strong>{statement.conformanceTo}</strong> · claim{" "}
        <strong>{statement.claim}</strong>
      </div>
      <div className="text-xs text-ink/60">
        {statement.auditedAt
          ? `Last formal audit ${statement.auditedAt.toISOString().slice(0, 10)}${
              statement.auditedByName ? ` by ${statement.auditedByName}` : ""
            }.`
          : "No formal audit recorded yet."}
        {statement.publishedAt && (
          <>
            {" "}
            Published {statement.publishedAt.toISOString().slice(0, 10)}
            {statement.publishedByName ? ` by ${statement.publishedByName}` : ""}.
          </>
        )}
      </div>
      <details>
        <summary className="cursor-pointer text-xs text-ink/60">Read the statement</summary>
        <div className="mt-2 whitespace-pre-wrap text-sm">{statement.body}</div>
      </details>
    </div>
  );
}

function TermsCard({ terms }: { terms: TermsKindStatus }) {
  return (
    <li className="rounded border border-ink/10 bg-white p-3 text-sm">
      <div className="flex items-baseline justify-between">
        <div className="font-medium">{terms.kind}</div>
        <span className="text-xs text-ink/60">
          {terms.latestVersion == null ? "no versions yet" : `v${terms.latestVersion}`}
        </span>
      </div>
      <div className="mt-1 text-xs text-ink/70">{terms.description}</div>
      {terms.lastUpdatedAt && (
        <div className="mt-1 text-[11px] text-ink/50">
          Most recent cut {terms.lastUpdatedAt.toISOString().slice(0, 10)}
        </div>
      )}
    </li>
  );
}

function formatNumber(n: number, decimals: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(decimals);
}
