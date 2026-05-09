import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import {
  STANDARD_TURNAROUND_DAYS,
  STATUTORY_BACKSTOP_DAYS,
  computeSlaBadge,
  fulfillDsar,
  openDsar,
  type DsarKind,
  type DsarSlaBadge,
  type DsarSubjectType,
} from "@/lib/dsar/lifecycle";

const KINDS: { value: DsarKind; label: string; help: string }[] = [
  { value: "ACCESS", label: "Access (Art. 15)", help: "Subject wants a copy of their data." },
  { value: "RECTIFY", label: "Rectification (Art. 16)", help: "Correct inaccurate or incomplete data." },
  { value: "ERASE", label: "Erasure (Art. 17)", help: "Right to be forgotten — see retention exceptions." },
  { value: "RESTRICT", label: "Restriction (Art. 18)", help: "Halt further processing pending review." },
  { value: "PORT", label: "Portability (Art. 20)", help: "Machine-readable export to another controller." },
  { value: "OBJECT", label: "Objection (Art. 21)", help: "Object to processing, e.g. legitimate interests." },
];

export default async function DsarPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "dsar:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const dsars = await superDb.dSARequest.findMany({
    where: { tenantId: ctx.tenant.id },
    orderBy: [{ status: "asc" }, { openedAt: "desc" }],
    take: 200,
  });
  const open = dsars.filter((d) => !d.fulfilledAt && d.status !== "REJECTED");
  const closed = dsars.filter((d) => d.fulfilledAt || d.status === "REJECTED");

  const canWrite = hasPermission(ctx.membership.role, "dsar:write");
  const canFulfill = hasPermission(ctx.membership.role, "dsar:fulfill");

  async function openAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "dsar:write")) throw new Error("forbidden");
    await openDsar({
      tenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
      subjectType: String(formData.get("subjectType") ?? "USER") as DsarSubjectType,
      subjectIdent: String(formData.get("subjectIdent") ?? ""),
      kind: String(formData.get("kind") ?? "ACCESS") as DsarKind,
    });
    revalidatePath(`/${tenantSlug}/dsar`);
  }

  async function fulfillAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "dsar:fulfill")) throw new Error("forbidden");
    const dsarId = String(formData.get("dsarId") ?? "");
    if (!dsarId) throw new Error("dsarId required");
    await fulfillDsar({
      tenantId: inner.tenant.id,
      dsarId,
      actorMembershipId: inner.membership.id,
      packageRef: (formData.get("packageRef") as string | null) ?? null,
      outcome: (formData.get("outcome") as "FULFILLED" | "REJECTED") ?? "FULFILLED",
      notes: (formData.get("notes") as string | null) ?? null,
    });
    revalidatePath(`/${tenantSlug}/dsar`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">DSAR module</h1>
        <p className="mt-1 text-sm text-ink/70">
          PRD §12.4 — Subject Access, Rectification, Erasure, Restriction, Portability, and
          Objection. Standard turnaround{" "}
          <strong>{STANDARD_TURNAROUND_DAYS} days</strong> from receipt; statutory backstop{" "}
          <strong>{STATUTORY_BACKSTOP_DAYS} days</strong>. Counterparty DSARs are routed to the
          Client; the platform supplies extraction tooling.
        </p>
      </div>

      <RetentionNote />

      {canWrite && <OpenForm action={openAction} />}

      <SectionList
        title={`Open (${open.length})`}
        rows={open}
        tenantSlug={tenantSlug}
        canFulfill={canFulfill}
        fulfillAction={fulfillAction}
      />

      {closed.length > 0 && (
        <SectionList
          title={`Closed (${closed.length})`}
          rows={closed}
          tenantSlug={tenantSlug}
          canFulfill={false}
          muted
        />
      )}
    </div>
  );
}

function RetentionNote() {
  return (
    <div className="card border-amber-200 bg-amber-50/30">
      <div className="text-sm font-medium text-amber-900">Retention exceptions for ERASE</div>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-ink/70">
        <li>
          Audit log: immutable per the tenant hash chain (PRD §6.2). Audit-event payloads cannot be
          erased; record the request in the firm&rsquo;s retention exception register.
        </li>
        <li>DPIA attestations: retained per PRD §12.5 retention table.</li>
        <li>
          Statutory retention obligations on the firm&rsquo;s substantive matter records may
          override; assess on a per-record basis before fulfilling.
        </li>
      </ul>
    </div>
  );
}

function OpenForm({ action }: { action: (fd: FormData) => Promise<void> }) {
  return (
    <form action={action} className="card space-y-3">
      <h2 className="text-base font-medium">Open a new DSAR</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="label">Subject type</label>
          <select className="input" name="subjectType" defaultValue="USER">
            <option value="USER">User (member of this tenant)</option>
            <option value="COUNTERPARTY">Counterparty (third party in correspondence)</option>
          </select>
        </div>
        <div>
          <label className="label">Subject identifier</label>
          <input
            className="input"
            name="subjectIdent"
            type="email"
            required
            placeholder="email@firm.com"
            maxLength={250}
          />
        </div>
        <div>
          <label className="label">Right exercised</label>
          <select className="input" name="kind" defaultValue="ACCESS">
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <ul className="text-xs text-ink/60">
        {KINDS.map((k) => (
          <li key={k.value}>
            <span className="tag mr-1">{k.value}</span>
            {k.help}
          </li>
        ))}
      </ul>
      <div>
        <button type="submit" className="btn btn-primary">
          Open DSAR
        </button>
      </div>
    </form>
  );
}

type DsarRow = {
  id: string;
  subjectType: string;
  subjectIdent: string;
  kind: string;
  status: string;
  openedAt: Date;
  dueAt: Date | null;
  fulfilledAt: Date | null;
  packageRef: string | null;
};

function SectionList({
  title,
  rows,
  tenantSlug,
  canFulfill,
  fulfillAction,
  muted,
}: {
  title: string;
  rows: DsarRow[];
  tenantSlug: string;
  canFulfill: boolean;
  fulfillAction?: (fd: FormData) => Promise<void>;
  muted?: boolean;
}) {
  return (
    <div className={`card ${muted ? "opacity-90" : ""}`}>
      <h2 className="text-base font-medium">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-ink/60">Nothing here yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-ink/5">
          {rows.map((d) => (
            <DsarItem
              key={d.id}
              dsar={d}
              tenantSlug={tenantSlug}
              canFulfill={canFulfill}
              fulfillAction={fulfillAction}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function DsarItem({
  dsar,
  tenantSlug,
  canFulfill,
  fulfillAction,
}: {
  dsar: DsarRow;
  tenantSlug: string;
  canFulfill: boolean;
  fulfillAction?: (fd: FormData) => Promise<void>;
}) {
  const sla = computeSlaBadge(dsar);
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{dsar.subjectIdent}</div>
          <div className="mt-0.5 flex flex-wrap gap-1.5 text-xs text-ink/60">
            <span className="tag">{dsar.kind}</span>
            <span className="tag">{dsar.subjectType}</span>
            <span>opened {dsar.openedAt.toISOString().slice(0, 10)}</span>
            {dsar.dueAt && (
              <span>· due {dsar.dueAt.toISOString().slice(0, 10)}</span>
            )}
            {dsar.fulfilledAt && (
              <span>· closed {dsar.fulfilledAt.toISOString().slice(0, 10)}</span>
            )}
            {dsar.packageRef && <span>· ref {dsar.packageRef}</span>}
          </div>
        </div>
        <SlaBadge sla={sla} />
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <Link
          href={`/api/dsar/${dsar.id}/package?tenant=${tenantSlug}`}
          className="btn"
          prefetch={false}
        >
          Download package (JSON)
        </Link>
        {canFulfill && fulfillAction && !dsar.fulfilledAt && dsar.status !== "REJECTED" && (
          <FulfillForm dsarId={dsar.id} action={fulfillAction} />
        )}
      </div>
    </li>
  );
}

function FulfillForm({
  dsarId,
  action,
}: {
  dsarId: string;
  action: (fd: FormData) => Promise<void>;
}) {
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="dsarId" value={dsarId} />
      <input
        className="input h-7 px-2 text-xs"
        name="packageRef"
        placeholder="package ref (URL / doc id)"
        maxLength={250}
      />
      <select className="input h-7 px-2 text-xs" name="outcome" defaultValue="FULFILLED">
        <option value="FULFILLED">Fulfilled</option>
        <option value="REJECTED">Rejected</option>
      </select>
      <input
        className="input h-7 px-2 text-xs"
        name="notes"
        placeholder="notes (optional)"
        maxLength={500}
      />
      <button type="submit" className="btn btn-primary text-xs">
        Mark
      </button>
    </form>
  );
}

function SlaBadge({ sla }: { sla: DsarSlaBadge }) {
  switch (sla.kind) {
    case "in_window":
      return (
        <span className="tag bg-emerald-100 text-emerald-800">
          {sla.daysLeft}d to due
        </span>
      );
    case "due_soon":
      return (
        <span className="tag bg-amber-100 text-amber-800">
          due in {sla.daysLeft}d
        </span>
      );
    case "overdue_standard":
      return (
        <span className="tag bg-amber-200 text-amber-900">
          overdue {sla.daysOver}d
        </span>
      );
    case "overdue_backstop":
      return (
        <span className="tag bg-red-100 text-red-700">
          past statutory backstop +{sla.daysOver}d
        </span>
      );
    case "fulfilled":
      return (
        <span
          className={`tag ${
            sla.withinStandard
              ? "bg-emerald-100 text-emerald-800"
              : "bg-amber-100 text-amber-800"
          }`}
        >
          fulfilled · {sla.durationDays}d
        </span>
      );
    case "rejected":
      return <span className="tag bg-ink/10 text-ink/60">rejected</span>;
  }
}
