import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import { getDpiaStatus, type DpiaStatus, type DpiaScopeSnapshot } from "@/lib/dpia/status";
import { commitDpiaAttestation, type DpiaAttestInput } from "@/lib/dpia/attest";

const STATE_BADGE: Record<string, string> = {
  CURRENT: "bg-emerald-100 text-emerald-800",
  EXPIRING_SOON: "bg-amber-100 text-amber-800",
  WITHIN_GRACE: "bg-amber-100 text-amber-800",
  SCOPE_DRIFT: "bg-amber-100 text-amber-800",
  DEGRADED: "bg-red-100 text-red-700",
  NEVER: "bg-red-100 text-red-700",
};

const SUBPROCESSORS_DEFAULT = [
  "Anthropic (frontier model — judge + verifier)",
  "Together AI (frontier model — drafting + chat)",
  "Postgres (managed, in-region)",
  "Email relay (magic-link / OTP)",
];

export default async function DpiaPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "dpia:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const [status, history] = await Promise.all([
    getDpiaStatus(ctx.tenant.id),
    superDb.dPIAAttestation.findMany({
      where: { tenantId: ctx.tenant.id },
      orderBy: { version: "desc" },
      take: 20,
    }),
  ]);

  const canWrite = hasPermission(ctx.membership.role, "dpia:write");

  async function attestAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "dpia:write")) {
      throw new Error("forbidden");
    }

    const sub = (formData.get("subProcessorsList") as string | null)?.trim() ?? "";
    const subProcessorsList = sub
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const sections: DpiaAttestInput["sections"] = {
      channelsAcknowledged: formData.get("channelsAcknowledged") === "on",
      retentionAcknowledged: formData.get("retentionAcknowledged") === "on",
      lawfulBasis: (formData.get("lawfulBasis") as DpiaAttestInput["sections"]["lawfulBasis"]) ?? "LEGITIMATE_INTERESTS",
      lawfulBasisNotes: (formData.get("lawfulBasisNotes") as string | null)?.trim() || null,
      specialCategoryDataInScope: formData.get("specialCategoryDataInScope") === "on",
      specialCategoryNotes: (formData.get("specialCategoryNotes") as string | null)?.trim() || null,
      transferInRegionConfirmed: formData.get("transferInRegionConfirmed") === "on",
      subProcessorsAcknowledged: formData.get("subProcessorsAcknowledged") === "on",
      subProcessorsList: subProcessorsList.length ? subProcessorsList : SUBPROCESSORS_DEFAULT,
      performanceProportionalityAcknowledged:
        formData.get("performanceProportionalityAcknowledged") === "on",
      sentimentScopeAcknowledged: formData.get("sentimentScopeAcknowledged") === "on",
      salesIdentifierOptIn: formData.get("salesIdentifierOptIn") === "on",
    };

    await commitDpiaAttestation({
      tenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
      signedByName: String(formData.get("signedByName") ?? ""),
      signedByRole: String(formData.get("signedByRole") ?? ""),
      documentRef: (formData.get("documentRef") as string | null) ?? null,
      sections,
    });

    revalidatePath(`/${tenantSlug}/dpia`);
    revalidatePath(`/${tenantSlug}`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">DPIA Helper</h1>
        <p className="mt-1 text-sm text-ink/70">
          PRD §12.2 — the Firm Administrator (with the Client DPO offline) signs off the DPIA on
          onboarding, on any material scope change, and annually. While no current attestation is
          on file, dashboards and Sales Identifier features are paused; drafting continues.
        </p>
      </div>

      <StatusCard status={status} />

      <ScopeCompare status={status} />

      {history.length > 0 && <HistoryCard history={history} />}

      {canWrite && (
        <NewAttestationForm
          status={status}
          defaultSignedByName={ctx.user.name ?? ctx.user.email}
          defaultSignedByRole={ctx.membership.role === "FIRM_ADMIN" ? "Firm Administrator" : ""}
          action={attestAction}
        />
      )}
      {!canWrite && (
        <div className="card text-sm text-ink/60">
          Only a Firm Administrator can attest a new DPIA. Ask your administrator to open this
          page if a re-attestation is required.
        </div>
      )}
    </div>
  );
}

function StatusCard({ status }: { status: DpiaStatus }) {
  const att = status.attestation;
  return (
    <div className="card space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-base font-medium">Status</h2>
        <span className={`tag ${STATE_BADGE[status.state] ?? ""}`}>{status.state}</span>
      </div>
      {status.banner && (
        <p className={`text-sm ${status.banner.tone === "alert" ? "text-red-700" : status.banner.tone === "warn" ? "text-amber-800" : "text-ink/70"}`}>
          {status.banner.message}
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-ink/50">Latest version</div>
          <div className="mt-0.5">{att ? `v${att.version}` : "—"}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-ink/50">Signed</div>
          <div className="mt-0.5">
            {att ? (
              <>
                {att.signedAt.toISOString().slice(0, 10)} ·{" "}
                <span className="text-ink/60">{att.signedByName}</span>{" "}
                <span className="tag">{att.signedByRole}</span>
              </>
            ) : (
              <span className="text-ink/50">never</span>
            )}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-ink/50">Expires</div>
          <div className="mt-0.5">
            {status.expiresAt ? (
              <>
                {status.expiresAt.toISOString().slice(0, 10)}{" "}
                {status.daysUntilExpiry !== null && (
                  <span className="text-xs text-ink/50">
                    {status.daysUntilExpiry >= 0
                      ? `· in ${status.daysUntilExpiry} day${status.daysUntilExpiry === 1 ? "" : "s"}`
                      : `· ${Math.abs(status.daysUntilExpiry)} day${Math.abs(status.daysUntilExpiry) === 1 ? "" : "s"} ago`}
                  </span>
                )}
              </>
            ) : (
              <span className="text-ink/50">—</span>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pt-1 text-xs">
        <span className={`tag ${status.dashboardsAllowed ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-700"}`}>
          dashboards · {status.dashboardsAllowed ? "active" : "paused"}
        </span>
        <span className={`tag ${status.salesIdentifierAllowed ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-700"}`}>
          sales identifier · {status.salesIdentifierAllowed ? "active" : "paused"}
        </span>
      </div>
    </div>
  );
}

function ScopeCompare({ status }: { status: DpiaStatus }) {
  const live = status.liveScope;
  const att = status.attestedScope;
  const drift = status.state === "SCOPE_DRIFT" || (att && att.hash !== live.hash);

  return (
    <div className="card space-y-3">
      <h2 className="text-base font-medium">Scope</h2>
      <p className="text-xs text-ink/60">
        The DPIA Helper hashes the live scope at sign-off so we can detect drift. Adding a channel,
        flipping perf-dashboard or sentiment opt-in for a User, or enabling Sales Identifier all
        change the hash and trigger re-attestation.
      </p>
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <ScopeColumn title="Live (now)" snap={live} />
        {att ? (
          <ScopeColumn title={`Last attested${drift ? " — drift" : ""}`} snap={att} drifted={!!drift} />
        ) : (
          <div className="rounded border border-dashed border-ink/15 p-3 text-xs text-ink/50">
            No prior attestation.
          </div>
        )}
      </div>
    </div>
  );
}

function ScopeColumn({
  title,
  snap,
  drifted,
}: {
  title: string;
  snap: DpiaScopeSnapshot;
  drifted?: boolean;
}) {
  return (
    <div className={`rounded border p-3 ${drifted ? "border-amber-300 bg-amber-50/30" : "border-ink/10"}`}>
      <div className="text-xs uppercase tracking-wider text-ink/50">{title}</div>
      <dl className="mt-2 space-y-1 text-xs">
        <Row label="Jurisdiction" value={snap.jurisdiction} />
        <Row label="Retention (days)" value={String(snap.retentionDays)} />
        <Row
          label="Channels"
          value={snap.channelKinds.length ? snap.channelKinds.join(", ") : "(none)"}
        />
        <Row label="Perf opt-ins" value={String(snap.perfDashOptInUserCount)} />
        <Row label="Sentiment opt-ins" value={String(snap.sentimentOutOptInUserCount)} />
        <Row label="Sales Identifier" value={snap.salesIdentifierEnabled ? "on" : "off"} />
        <Row label="Hash" value={<span className="font-mono">{snap.hash}</span>} />
      </dl>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink/50">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

function HistoryCard({ history }: { history: { id: string; version: number; signedAt: Date; signedByName: string; signedByRole: string; expiresAt: Date | null; documentRef: string | null }[] }) {
  return (
    <div className="card">
      <h2 className="text-base font-medium">Attestation history</h2>
      <table className="mt-2 w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-ink/50">
          <tr>
            <th className="py-1 pr-3">v</th>
            <th className="py-1 pr-3">Signed</th>
            <th className="py-1 pr-3">By</th>
            <th className="py-1 pr-3">Expires</th>
            <th className="py-1 pr-3">Document ref</th>
          </tr>
        </thead>
        <tbody>
          {history.map((a) => (
            <tr key={a.id} className="border-t border-ink/5">
              <td className="py-1 pr-3 tabular-nums">{a.version}</td>
              <td className="py-1 pr-3 text-xs">{a.signedAt.toISOString().slice(0, 10)}</td>
              <td className="py-1 pr-3 text-xs">
                {a.signedByName} <span className="tag">{a.signedByRole}</span>
              </td>
              <td className="py-1 pr-3 text-xs">{a.expiresAt?.toISOString().slice(0, 10) ?? "—"}</td>
              <td className="py-1 pr-3 text-xs text-ink/60">{a.documentRef ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NewAttestationForm({
  status,
  defaultSignedByName,
  defaultSignedByRole,
  action,
}: {
  status: DpiaStatus;
  defaultSignedByName: string;
  defaultSignedByRole: string;
  action: (formData: FormData) => Promise<void>;
}) {
  const live = status.liveScope;

  return (
    <form action={action} className="card space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-medium">Sign off a new DPIA</h2>
        <span className="text-xs text-ink/50">covers next 365 days</span>
      </div>

      <Section
        title="1 · Channel scope"
        prd="§5.1.1, §10"
        body={
          <p className="text-sm">
            Channels currently in scope:{" "}
            <strong>{live.channelKinds.length ? live.channelKinds.join(", ") : "(none — Helper will sign off the empty scope)"}</strong>.
            Personal channels are excluded by design (PRD §5.1.1).
          </p>
        }
      >
        <Ack name="channelsAcknowledged" label="The list above reflects channels approved for ingestion." />
      </Section>

      <Section
        title="2 · Retention windows"
        prd="§12.5, §14.3"
        body={
          <p className="text-sm">
            Tenant retention: <strong>{live.retentionDays} days</strong>. UCG retention on staff
            departure: 30 days then anonymised. Audit log: 7 years minimum.
          </p>
        }
      >
        <Ack name="retentionAcknowledged" label="Retention windows reviewed and acceptable." />
      </Section>

      <Section title="3 · Lawful basis" prd="A2">
        <fieldset className="space-y-1 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="lawfulBasis" value="LEGITIMATE_INTERESTS" defaultChecked />
            Legitimate interests (with documented LIA)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="lawfulBasis" value="CONSENT" />
            Consent (specific, granular, withdrawable)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="lawfulBasis" value="CONTRACT" />
            Contract / pre-contractual
          </label>
        </fieldset>
        <textarea
          name="lawfulBasisNotes"
          rows={2}
          className="input mt-2"
          placeholder="LIA reference, scope notes (optional)"
        />
      </Section>

      <Section title="4 · Special-category data" prd="§5">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="specialCategoryDataInScope" />
          Special-category data may be in scope (health, biometric, etc.)
        </label>
        <textarea
          name="specialCategoryNotes"
          rows={2}
          className="input mt-2"
          placeholder="If yes, summarise mitigations (optional)"
        />
      </Section>

      <Section
        title="5 · Transfer mechanism"
        prd="§12.6"
        body={
          <p className="text-sm">
            Tenant jurisdiction: <strong>{live.jurisdiction}</strong>. All inference and storage
            in-region; no third-country transfers in v1.
          </p>
        }
      >
        <Ack
          name="transferInRegionConfirmed"
          label={`Confirmed: all processing remains in ${live.jurisdiction}.`}
        />
      </Section>

      <Section title="6 · Sub-processors" prd="§12.6, §15.3">
        <textarea
          name="subProcessorsList"
          rows={4}
          className="input"
          defaultValue={SUBPROCESSORS_DEFAULT.join("\n")}
        />
        <Ack name="subProcessorsAcknowledged" label="Sub-processor list reviewed." />
      </Section>

      <Section
        title="7 · Performance-monitoring proportionality"
        prd="§9.2"
        body={
          <p className="text-sm">
            Per-User dashboards: <strong>{live.perfDashOptInUserCount}</strong> User
            {live.perfDashOptInUserCount === 1 ? "" : "s"} opted in. Individual data is shown
            monthly in arrears only.
          </p>
        }
      >
        <Ack
          name="performanceProportionalityAcknowledged"
          label="ICO worker-monitoring proportionality reviewed (monthly-in-arrears + opt-in)."
        />
      </Section>

      <Section
        title="8 · Sentiment-monitoring scope"
        prd="§9.3"
        body={
          <p className="text-sm">
            Outgoing sentiment opt-ins: <strong>{live.sentimentOutOptInUserCount}</strong>. Incoming
            sentiment is firm-handling-only.
          </p>
        }
      >
        <Ack name="sentimentScopeAcknowledged" label="Sentiment scope and escalation reviewed." />
      </Section>

      <Section
        title="9 · Sales Identifier opt-in"
        prd="§8, §11"
        body={
          <p className="text-sm">
            Sales Identifier currently {live.salesIdentifierEnabled ? "enabled" : "disabled"}.
            Mining correspondence for opportunities is a separate processing purpose and may
            require updated counterparty privacy notices.
          </p>
        }
      >
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="salesIdentifierOptIn"
            defaultChecked={live.salesIdentifierEnabled}
          />
          Sales Identifier add-on attested as opted-in.
        </label>
      </Section>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Signed by — name</label>
          <input
            className="input"
            name="signedByName"
            required
            defaultValue={defaultSignedByName}
            maxLength={120}
          />
        </div>
        <div>
          <label className="label">Signed by — role</label>
          <input
            className="input"
            name="signedByRole"
            required
            defaultValue={defaultSignedByRole}
            placeholder="Firm Administrator / DPO / etc."
            maxLength={120}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="label">Document reference (optional)</label>
          <input
            className="input"
            name="documentRef"
            placeholder="Internal DPIA-2026-Q2 / SharePoint URL"
            maxLength={500}
          />
        </div>
      </div>

      <div className="pt-2">
        <button type="submit" className="btn btn-primary">
          Sign off DPIA v{(status.attestation?.version ?? 0) + 1}
        </button>
        <p className="mt-2 text-xs text-ink/50">
          On sign-off the live scope hash is captured, the audit chain emits DPIA_ATTESTED, and any
          active channels are flagged dpiaApproved=true.
        </p>
      </div>
    </form>
  );
}

function Section({
  title,
  prd,
  body,
  children,
}: {
  title: string;
  prd: string;
  body?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded border border-ink/10 p-3">
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-ink/40">{prd}</div>
      </div>
      {body && <div className="mt-1">{body}</div>}
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Ack({ name, label }: { name: string; label: string }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name={name} required />
      {label}
    </label>
  );
}
