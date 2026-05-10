import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import {
  NOTIFICATION_DEADLINE_HOURS,
  SEVERITY_LABELS,
  STATUS_LABELS,
  addAffectedTenant,
  dispatchNotification,
  getOperatorIncident,
  isAcumonBreachOperator,
  listAvailableTenantsForIncident,
  updateBreachIncident,
} from "@/lib/compliance/breach";
import type { BreachSeverity, BreachStatus } from "@prisma/client";

const SEVERITY_OPTIONS: BreachSeverity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const STATUS_OPTIONS: BreachStatus[] = ["TRIAGE", "INVESTIGATING", "CONTAINED", "RESOLVED"];

export default async function BreachIncidentDetailPage({
  params,
}: {
  params: Promise<{ tenantSlug: string; id: string }>;
}) {
  const { tenantSlug, id } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (
    !isAcumonBreachOperator(ctx.tenant.slug) ||
    !hasPermission(ctx.membership.role, "breach:manage")
  ) {
    redirect(`/${tenantSlug}/compliance/breaches`);
  }

  const data = await getOperatorIncident(id);
  if (!data) notFound();

  const available = await listAvailableTenantsForIncident(id);
  const slaCutoff = new Date(
    data.incident.awareAt.getTime() + NOTIFICATION_DEADLINE_HOURS * 3_600_000,
  );
  const now = Date.now();

  async function updateAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (
      !isAcumonBreachOperator(inner.tenant.slug) ||
      !hasPermission(inner.membership.role, "breach:manage")
    ) {
      throw new Error("forbidden");
    }
    await updateBreachIncident({
      incidentId: id,
      status: (String(formData.get("status") ?? "") as BreachStatus) || undefined,
      severity: (String(formData.get("severity") ?? "") as BreachSeverity) || undefined,
      rootCause: String(formData.get("rootCause") ?? "").trim() || null,
      mitigations: String(formData.get("mitigations") ?? "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/compliance/breaches/${id}`);
  }

  async function addTenantAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (
      !isAcumonBreachOperator(inner.tenant.slug) ||
      !hasPermission(inner.membership.role, "breach:manage")
    ) {
      throw new Error("forbidden");
    }
    await addAffectedTenant({
      incidentId: id,
      tenantId: String(formData.get("tenantId") ?? ""),
      notes: String(formData.get("notes") ?? "").trim() || null,
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/compliance/breaches/${id}`);
  }

  async function dispatchAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (
      !isAcumonBreachOperator(inner.tenant.slug) ||
      !hasPermission(inner.membership.role, "breach:manage")
    ) {
      throw new Error("forbidden");
    }
    const tenantId = String(formData.get("tenantId") ?? "");
    await dispatchNotification({
      notificationId: String(formData.get("notificationId") ?? ""),
      tenantId,
      notifiedByName: String(formData.get("notifiedByName") ?? ""),
      notifiedToName: String(formData.get("notifiedToName") ?? ""),
      notifiedToRole: String(formData.get("notifiedToRole") ?? ""),
      payload: String(formData.get("payload") ?? ""),
      actorTenantId: inner.tenant.id,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/compliance/breaches/${id}`);
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/${tenantSlug}/compliance/breaches`}
          className="text-xs underline decoration-dotted"
        >
          ← Breach notifications
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {data.incident.title}{" "}
          <code className="ml-1 rounded bg-ink/5 px-1 text-base">{data.incident.code}</code>
        </h1>
        <div className="mt-1 flex flex-wrap gap-2 text-xs text-ink/60">
          <span className="tag bg-ink/5">{SEVERITY_LABELS[data.incident.severity]}</span>
          <span className="tag bg-ink/5">{STATUS_LABELS[data.incident.status]}</span>
          {data.incident.isPersonalData && (
            <span className="tag bg-amber-100 text-amber-900">Personal data</span>
          )}
        </div>
        <p className="mt-1 text-xs text-ink/60">
          Aware {data.incident.awareAt.toISOString().slice(0, 16).replace("T", " ")} UTC ·{" "}
          SLA cutoff {slaCutoff.toISOString().slice(0, 16).replace("T", " ")} UTC
        </p>
      </div>

      <section className="card space-y-3">
        <h2 className="text-base font-medium">Incident description</h2>
        <p className="whitespace-pre-wrap text-sm">{data.incident.description}</p>
        {data.incident.affectedCategories.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {data.incident.affectedCategories.map((c) => (
              <span key={c} className="tag bg-ink/5 text-xs">
                {c}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="card space-y-2">
        <h2 className="text-base font-medium">Lifecycle</h2>
        <form action={updateAction} className="grid gap-2 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <select className="input" name="status" defaultValue={data.incident.status}>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
            <select className="input" name="severity" defaultValue={data.incident.severity}>
              {SEVERITY_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <textarea
            className="input"
            name="rootCause"
            rows={3}
            defaultValue={data.incident.rootCause ?? ""}
            placeholder="Root cause notes (added during INVESTIGATING)"
          />
          <textarea
            className="input"
            name="mitigations"
            rows={3}
            defaultValue={data.incident.mitigations.join("\n")}
            placeholder="Mitigations applied — one per line"
          />
          <button className="btn justify-self-start" type="submit">
            Save lifecycle update
          </button>
        </form>
      </section>

      <section className="card space-y-3">
        <h2 className="text-base font-medium">
          Affected Clients ({data.notifications.length})
        </h2>
        {data.notifications.length === 0 ? (
          <p className="text-sm text-ink/60">No Clients added yet.</p>
        ) : (
          <ul className="space-y-3 text-sm">
            {data.notifications.map((n) => {
              const overdue = n.status === "PENDING" && n.dueAt.getTime() < now;
              return (
                <li key={n.id} className="rounded border border-ink/10 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <span className="font-medium">{n.tenantName}</span>{" "}
                      <code className="ml-1 rounded bg-ink/5 px-1 text-xs">{n.tenantSlug}</code>
                      <span className="ml-2 tag bg-ink/5 text-xs">{n.status}</span>
                    </div>
                    <span
                      className={`text-xs ${
                        overdue ? "text-red-700" : "text-ink/50"
                      }`}
                    >
                      Due {n.dueAt.toISOString().slice(0, 16).replace("T", " ")} UTC
                    </span>
                  </div>
                  {n.notifiedAt ? (
                    <div className="mt-1 text-xs text-ink/60">
                      Notified {n.notifiedAt.toISOString().slice(0, 16).replace("T", " ")} by{" "}
                      {n.notifiedByName} → {n.notifiedToName} ({n.notifiedToRole})
                    </div>
                  ) : (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-ink/60">
                        Dispatch notification
                      </summary>
                      <form action={dispatchAction} className="mt-2 grid gap-1 text-sm">
                        <input type="hidden" name="notificationId" value={n.id} />
                        <input type="hidden" name="tenantId" value={n.tenantId} />
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            className="input"
                            name="notifiedByName"
                            required
                            placeholder="Acumon contact (your name)"
                          />
                          <input
                            className="input"
                            name="notifiedToName"
                            required
                            placeholder="Client DPO contact (name)"
                          />
                        </div>
                        <input
                          className="input"
                          name="notifiedToRole"
                          required
                          placeholder="Client contact role (e.g. Data Protection Officer)"
                        />
                        <textarea
                          className="input"
                          name="payload"
                          rows={6}
                          required
                          placeholder="Notification body — markdown. Tailor per Client if needed; include nature of breach, categories of data, approximate number of records, contact for queries, likely consequences, mitigations applied / proposed."
                          defaultValue={`Subject: Breach notification — ${data.incident.code}

Acumon Intelligence (as processor) is notifying you of the following personal-data breach affecting your tenant.

Incident: ${data.incident.title}
Code: ${data.incident.code}
Severity: ${data.incident.severity}
Aware at: ${data.incident.awareAt.toISOString()}

Description:
${data.incident.description}

Categories potentially affected:
${data.incident.affectedCategories.map((c) => `  - ${c}`).join("\n") || "  (under investigation)"}

Mitigations to date:
${data.incident.mitigations.map((m) => `  - ${m}`).join("\n") || "  (under investigation)"}

This notice is issued within the 24-hour processor SLA under our DPA. It contains the information you need to meet your 72-hour ICO/EDPB obligation. Please respond with any questions.`}
                        />
                        <button className="btn justify-self-start" type="submit">
                          Dispatch
                        </button>
                      </form>
                    </details>
                  )}
                  {n.acknowledgedAt && (
                    <div className="mt-1 text-xs text-emerald-700">
                      Acknowledged {n.acknowledgedAt.toISOString().slice(0, 16).replace("T", " ")} by{" "}
                      {n.acknowledgedByName}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {available.length > 0 && (
          <details className="border-t border-ink/10 pt-3">
            <summary className="cursor-pointer text-sm font-medium">
              Add affected Client ({available.length} available)
            </summary>
            <form action={addTenantAction} className="mt-3 grid gap-2 text-sm">
              <select className="input" name="tenantId" required>
                <option value="">— select tenant —</option>
                {available.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.slug})
                  </option>
                ))}
              </select>
              <input
                className="input"
                name="notes"
                placeholder="Optional internal note"
              />
              <button className="btn btn-primary justify-self-start" type="submit">
                Add to incident
              </button>
            </form>
          </details>
        )}
      </section>
    </div>
  );
}
