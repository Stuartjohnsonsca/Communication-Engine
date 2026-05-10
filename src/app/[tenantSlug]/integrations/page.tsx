import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import {
  CATEGORY_LABELS,
  STATUS_LABELS,
  TIER_LABELS,
  addIntegrationTarget,
  getIntegrationsView,
  isAcumonIntegrationOperator,
  setIntegrationStatus,
  updateIntegrationTarget,
} from "@/lib/integrations";
import type {
  IntegrationCategory,
  IntegrationStatus,
  IntegrationTarget,
  IntegrationTier,
} from "@prisma/client";

const TIER_OPTIONS: IntegrationTier[] = ["TIER_1", "TIER_2", "TIER_3", "SDK"];
const STATUS_OPTIONS: IntegrationStatus[] = ["PLANNED", "IN_DEVELOPMENT", "AVAILABLE", "DEPRECATED"];
const CATEGORY_OPTIONS: IntegrationCategory[] = [
  "EMAIL",
  "CHAT",
  "DOCUMENTS",
  "CALENDAR",
  "MEETINGS",
  "E_SIGNATURE",
  "PRACTICE_MANAGEMENT",
  "CRM",
  "KNOWLEDGE_BASE",
  "ACCOUNTING",
  "TASK_MANAGEMENT",
  "OTHER",
];

export default async function IntegrationsPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "integrations:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const view = await getIntegrationsView();
  const isOperator =
    isAcumonIntegrationOperator(ctx.tenant.slug) &&
    hasPermission(ctx.membership.role, "integrations:manage");

  async function addAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (
      !isAcumonIntegrationOperator(inner.tenant.slug) ||
      !hasPermission(inner.membership.role, "integrations:manage")
    ) {
      throw new Error("forbidden");
    }
    await addIntegrationTarget({
      code: String(formData.get("code") ?? ""),
      name: String(formData.get("name") ?? ""),
      vendor: String(formData.get("vendor") ?? "").trim() || null,
      tier: String(formData.get("tier") ?? "TIER_3") as IntegrationTier,
      category: String(formData.get("category") ?? "OTHER") as IntegrationCategory,
      channelKind: String(formData.get("channelKind") ?? "").trim() || null,
      authMechanism: String(formData.get("authMechanism") ?? "oauth2"),
      requiredScopes: splitCsv(formData.get("requiredScopes")),
      capabilities: splitCsv(formData.get("capabilities")),
      role: String(formData.get("role") ?? "").trim() || null,
      notes: String(formData.get("notes") ?? "").trim() || null,
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/integrations`);
  }

  async function updateAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (
      !isAcumonIntegrationOperator(inner.tenant.slug) ||
      !hasPermission(inner.membership.role, "integrations:manage")
    ) {
      throw new Error("forbidden");
    }
    const code = String(formData.get("code") ?? "");
    await updateIntegrationTarget({
      code,
      name: String(formData.get("name") ?? "") || undefined,
      vendor: String(formData.get("vendor") ?? "").trim() || null,
      tier: (String(formData.get("tier") ?? "") as IntegrationTier) || undefined,
      category: (String(formData.get("category") ?? "") as IntegrationCategory) || undefined,
      channelKind: String(formData.get("channelKind") ?? "").trim() || null,
      authMechanism: String(formData.get("authMechanism") ?? "") || undefined,
      requiredScopes: splitCsv(formData.get("requiredScopes")),
      capabilities: splitCsv(formData.get("capabilities")),
      role: String(formData.get("role") ?? "").trim() || null,
      notes: String(formData.get("notes") ?? "").trim() || null,
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/integrations`);
  }

  async function statusAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (
      !isAcumonIntegrationOperator(inner.tenant.slug) ||
      !hasPermission(inner.membership.role, "integrations:manage")
    ) {
      throw new Error("forbidden");
    }
    await setIntegrationStatus({
      code: String(formData.get("code") ?? ""),
      status: String(formData.get("status") ?? "PLANNED") as IntegrationStatus,
      notes: String(formData.get("notes") ?? "").trim() || null,
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/integrations`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
        <p className="mt-1 text-sm text-ink/70">
          PRD §10 — published catalogue of every integration target. Tier 1 is required at GA;
          Tier 2 is committed within 6 months of GA; Tier 3 is roadmap; the SDK row is the
          generic extensibility commitment under §10.4.
        </p>
      </div>

      <section className="card grid gap-3 border-emerald-300 bg-emerald-50/40 md:grid-cols-3">
        <Stat label="Tier 1 (GA)" value={view.tier1.length} status={view.tier1} />
        <Stat label="Tier 2 (6mo)" value={view.tier2.length} status={view.tier2} />
        <Stat label="Tier 3 (roadmap)" value={view.tier3.length} status={view.tier3} />
      </section>

      {(["TIER_1", "TIER_2", "TIER_3", "SDK"] as const).map((tier) => {
        const list =
          tier === "TIER_1"
            ? view.tier1
            : tier === "TIER_2"
              ? view.tier2
              : tier === "TIER_3"
                ? view.tier3
                : view.sdk;
        if (list.length === 0) return null;
        return (
          <section key={tier} className="card space-y-3">
            <h2 className="text-base font-medium">{TIER_LABELS[tier]}</h2>
            <ul className="space-y-3">
              {list.map((t) => (
                <IntegrationRow
                  key={t.id}
                  target={t}
                  isOperator={isOperator}
                  updateAction={updateAction}
                  statusAction={statusAction}
                />
              ))}
            </ul>
          </section>
        );
      })}

      <section className="card space-y-2">
        <h2 className="text-base font-medium">Permissions inheritance (§10.4)</h2>
        <p className="text-sm text-ink/70">
          Every integration inherits the source system&rsquo;s permissions model — SharePoint
          ACLs, iManage cabinets, Slack channel membership, Drive folder shares all flow through
          to RAG retrieval. Acumon never grants a User access to documents the underlying system
          would not.
        </p>
      </section>

      <section className="card space-y-2">
        <h2 className="text-base font-medium">What your tenant has authorised</h2>
        <p className="text-sm text-ink/70">
          The catalogue above is the global product surface. To see and manage which integrations
          your tenant has actually wired up, go to{" "}
          <Link
            href={`/${tenantSlug}/admin/channels`}
            className="underline decoration-dotted"
          >
            channel administration
          </Link>
          .
        </p>
      </section>

      {isOperator && (
        <section className="card space-y-3 border-amber-300 bg-amber-50/40">
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              Add integration target
            </summary>
            <form action={addAction} className="mt-3 grid gap-2 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <input
                  className="input"
                  name="code"
                  required
                  placeholder="stable-code"
                  pattern="[a-z0-9_-]+"
                  maxLength={64}
                />
                <input
                  className="input"
                  name="name"
                  required
                  placeholder="Display name"
                  maxLength={200}
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <select className="input" name="tier" required>
                  {TIER_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {TIER_LABELS[t]}
                    </option>
                  ))}
                </select>
                <select className="input" name="category" required>
                  {CATEGORY_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>
                <input
                  className="input"
                  name="vendor"
                  placeholder="Vendor"
                  maxLength={200}
                />
              </div>
              <input
                className="input"
                name="channelKind"
                placeholder="Channel.kind (e.g. M365 — leave blank if no Channel produced)"
                maxLength={64}
              />
              <input
                className="input"
                name="authMechanism"
                placeholder="Auth mechanism (oauth2, api_key, saml, webhook, sdk)"
                maxLength={64}
                defaultValue="oauth2"
              />
              <input
                className="input"
                name="requiredScopes"
                placeholder="Required scopes (comma-separated)"
              />
              <input
                className="input"
                name="capabilities"
                placeholder="Capabilities (comma-separated, e.g. drafts, calendar)"
              />
              <input
                className="input"
                name="role"
                placeholder="Short role description"
                maxLength={200}
              />
              <textarea className="input" name="notes" rows={2} placeholder="Notes" />
              <button className="btn btn-primary justify-self-start" type="submit">
                Add target
              </button>
            </form>
          </details>
        </section>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  status,
}: {
  label: string;
  value: number;
  status: IntegrationTarget[];
}) {
  const live = status.filter((t) => t.status === "AVAILABLE").length;
  return (
    <div className="rounded bg-white/70 p-3 text-center">
      <div className="text-xs text-ink/60">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-[11px] text-ink/50">
        {live} available · {value - live} not yet
      </div>
    </div>
  );
}

function IntegrationRow({
  target,
  isOperator,
  updateAction,
  statusAction,
}: {
  target: IntegrationTarget;
  isOperator: boolean;
  updateAction: (formData: FormData) => Promise<void>;
  statusAction: (formData: FormData) => Promise<void>;
}) {
  return (
    <li className="rounded border border-ink/10 p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="font-medium">{target.name}</span>
          {target.vendor && <span className="ml-2 text-xs text-ink/50">{target.vendor}</span>}
          <span className="ml-2 text-xs text-ink/50">
            <code className="rounded bg-ink/5 px-1">{target.code}</code> ·{" "}
            {CATEGORY_LABELS[target.category]}
          </span>
        </div>
        <span
          className={`tag text-xs ${
            target.status === "AVAILABLE"
              ? "bg-emerald-100 text-emerald-900"
              : target.status === "IN_DEVELOPMENT"
                ? "bg-amber-100 text-amber-900"
                : target.status === "DEPRECATED"
                  ? "bg-ink/10 text-ink/60"
                  : "bg-ink/5 text-ink/70"
          }`}
        >
          {STATUS_LABELS[target.status]}
        </span>
      </div>
      {target.role && <p className="mt-1 text-sm">{target.role}</p>}
      {target.capabilities.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {target.capabilities.map((c) => (
            <span key={c} className="tag bg-ink/5 text-xs">
              {c}
            </span>
          ))}
        </div>
      )}
      {target.requiredScopes.length > 0 && (
        <details className="mt-2 text-xs text-ink/60">
          <summary className="cursor-pointer">
            {target.requiredScopes.length} scope{target.requiredScopes.length === 1 ? "" : "s"} ·{" "}
            {target.authMechanism}
          </summary>
          <div className="mt-1 flex flex-wrap gap-1">
            {target.requiredScopes.map((s) => (
              <code key={s} className="rounded bg-ink/5 px-1 py-0.5">
                {s}
              </code>
            ))}
          </div>
        </details>
      )}
      {target.channelKind && (
        <div className="mt-1 text-xs text-ink/50">
          Channel.kind = <code className="rounded bg-ink/5 px-1">{target.channelKind}</code>
        </div>
      )}
      {target.notes && (
        <p className="mt-1 whitespace-pre-wrap text-xs text-ink/60">{target.notes}</p>
      )}
      {isOperator && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-ink/60">Operator: edit / status</summary>
          <form action={updateAction} className="mt-2 grid gap-1 text-sm">
            <input type="hidden" name="code" value={target.code} />
            <div className="grid grid-cols-2 gap-2">
              <input className="input" name="name" defaultValue={target.name} required />
              <input className="input" name="vendor" defaultValue={target.vendor ?? ""} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <select className="input" name="tier" defaultValue={target.tier}>
                {TIER_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {TIER_LABELS[t]}
                  </option>
                ))}
              </select>
              <select className="input" name="category" defaultValue={target.category}>
                {CATEGORY_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
              <input
                className="input"
                name="channelKind"
                defaultValue={target.channelKind ?? ""}
                placeholder="Channel.kind"
              />
            </div>
            <input
              className="input"
              name="authMechanism"
              defaultValue={target.authMechanism}
            />
            <input
              className="input"
              name="requiredScopes"
              defaultValue={target.requiredScopes.join(", ")}
              placeholder="Comma-separated"
            />
            <input
              className="input"
              name="capabilities"
              defaultValue={target.capabilities.join(", ")}
              placeholder="Comma-separated"
            />
            <input className="input" name="role" defaultValue={target.role ?? ""} />
            <textarea
              className="input"
              name="notes"
              rows={2}
              defaultValue={target.notes ?? ""}
            />
            <button className="btn justify-self-start" type="submit">
              Save changes
            </button>
          </form>
          <form action={statusAction} className="mt-2 flex flex-wrap items-center gap-2">
            <input type="hidden" name="code" value={target.code} />
            <select className="input" name="status" defaultValue={target.status}>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
            <input
              className="input flex-1"
              name="notes"
              placeholder="Status note (optional)"
            />
            <button className="btn" type="submit">
              Update status
            </button>
          </form>
        </details>
      )}
    </li>
  );
}

function splitCsv(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
