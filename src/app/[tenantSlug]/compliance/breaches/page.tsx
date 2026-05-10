import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import {
  NOTIFICATION_DEADLINE_HOURS,
  SEVERITY_LABELS,
  STATUS_LABELS,
  acknowledgeNotification,
  isAcumonBreachOperator,
  listClientNotifications,
  listOperatorIncidents,
} from "@/lib/compliance/breach";

export default async function BreachesPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "breach:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const isOperator =
    isAcumonBreachOperator(ctx.tenant.slug) &&
    hasPermission(ctx.membership.role, "breach:manage");

  const notifications = await listClientNotifications(ctx.tenant.id);
  const operatorIncidents = isOperator ? await listOperatorIncidents() : [];

  async function ackAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "breach:notify")) throw new Error("forbidden");
    await acknowledgeNotification({
      notificationId: String(formData.get("notificationId") ?? ""),
      tenantId: inner.tenant.id,
      acknowledgedByName: String(formData.get("acknowledgedByName") ?? ""),
      notes: String(formData.get("notes") ?? "").trim() || null,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/compliance/breaches`);
  }

  const now = Date.now();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Breach notifications</h1>
        <p className="mt-1 text-sm text-ink/70">
          PRD §12.9 — Acumon (as processor) notifies you within{" "}
          <strong>{NOTIFICATION_DEADLINE_HOURS} hours</strong> of becoming aware of any
          personal-data breach affecting your tenant. Each notice carries everything you need to
          meet your own 72-hour ICO/EDPB obligation.
        </p>
      </div>

      <section className="card space-y-3">
        <h2 className="text-base font-medium">
          Notifications addressed to {ctx.tenant.name}
        </h2>
        {notifications.length === 0 ? (
          <p className="text-sm text-ink/60">
            No breach notifications on file. Nothing to do.
          </p>
        ) : (
          <ul className="space-y-3">
            {notifications.map((n) => {
              const overdue = n.status === "PENDING" && n.dueAt.getTime() < now;
              return (
                <li
                  key={n.id}
                  className={`rounded border p-3 text-sm ${
                    n.status === "PENDING" && overdue
                      ? "border-red-300 bg-red-50/40"
                      : n.status === "PENDING"
                        ? "border-amber-300 bg-amber-50/40"
                        : "border-ink/10"
                  }`}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <span className="font-medium">{n.incident.title}</span>{" "}
                      <code className="ml-1 rounded bg-ink/5 px-1 text-xs">{n.incident.code}</code>
                      <span className="ml-2 tag bg-ink/5 text-xs">
                        {SEVERITY_LABELS[n.incident.severity]}
                      </span>
                    </div>
                    <span className="text-xs text-ink/50">
                      Due {n.dueAt.toISOString().slice(0, 16).replace("T", " ")} UTC
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{n.incident.description}</p>
                  {n.incident.affectedCategories.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {n.incident.affectedCategories.map((c) => (
                        <span key={c} className="tag bg-ink/5 text-xs">
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="mt-2 text-xs text-ink/60">
                    Status: <strong>{n.status}</strong> ·{" "}
                    {n.notifiedAt
                      ? `Notified ${n.notifiedAt.toISOString().slice(0, 10)}`
                      : "Awaiting dispatch"}
                    {n.acknowledgedAt && (
                      <>
                        {" "}
                        · Acknowledged {n.acknowledgedAt.toISOString().slice(0, 10)} by{" "}
                        {n.acknowledgedByName}
                      </>
                    )}
                  </div>
                  {n.payload && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-ink/60">
                        Notification body
                      </summary>
                      <pre className="mt-1 whitespace-pre-wrap rounded bg-ink/5 p-2 text-xs">
                        {n.payload}
                      </pre>
                    </details>
                  )}
                  {n.status === "NOTIFIED" &&
                    hasPermission(ctx.membership.role, "breach:notify") && (
                      <form action={ackAction} className="mt-2 grid gap-1 text-sm">
                        <input type="hidden" name="notificationId" value={n.id} />
                        <input
                          className="input"
                          name="acknowledgedByName"
                          required
                          placeholder="Acknowledged by (name)"
                          defaultValue={ctx.user.name ?? ""}
                        />
                        <input
                          className="input"
                          name="notes"
                          placeholder="Optional acknowledgement notes"
                        />
                        <button className="btn justify-self-start" type="submit">
                          Acknowledge receipt
                        </button>
                      </form>
                    )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {isOperator && (
        <section className="card space-y-3 border-amber-300 bg-amber-50/40">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-medium">Acumon operator console</h2>
            <Link
              href={`/${tenantSlug}/compliance/breaches/new`}
              className="btn btn-primary text-sm"
            >
              + Record incident
            </Link>
          </div>
          {operatorIncidents.length === 0 ? (
            <p className="text-sm text-ink/60">No incidents recorded.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {operatorIncidents.map((i) => {
                const overdue = i.overdue > 0;
                const slaCutoff = i.dueAt;
                return (
                  <li key={i.id} className="rounded border border-ink/10 p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div>
                        <Link
                          href={`/${tenantSlug}/compliance/breaches/${i.id}`}
                          className="font-medium underline decoration-dotted"
                        >
                          {i.title}
                        </Link>
                        <code className="ml-2 rounded bg-ink/5 px-1 text-xs">{i.code}</code>
                        <span className="ml-2 tag bg-ink/5 text-xs">
                          {SEVERITY_LABELS[i.severity]}
                        </span>
                        <span className="ml-2 tag bg-ink/5 text-xs">{STATUS_LABELS[i.status]}</span>
                      </div>
                      <span
                        className={`text-xs ${
                          overdue ? "text-red-700" : "text-ink/50"
                        }`}
                      >
                        SLA cutoff {slaCutoff.toISOString().slice(0, 16).replace("T", " ")} UTC
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-ink/60">
                      Aware {i.awareAt.toISOString().slice(0, 16).replace("T", " ")} ·{" "}
                      {i.affectedClientCount} affected Client
                      {i.affectedClientCount === 1 ? "" : "s"} ·{" "}
                      {i.openNotifications} pending dispatch
                      {overdue && ` · ${i.overdue} overdue`}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <section className="card space-y-2">
        <h2 className="text-base font-medium">How this works</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>
            The 24-hour clock starts at <strong>Acumon&rsquo;s awareness</strong>, not when the
            incident technically began.
          </li>
          <li>
            Per-Client notifications are RLS-isolated — you only see notices addressed to{" "}
            {ctx.tenant.name}.
          </li>
          <li>
            Audit events <code>BREACH_CLIENT_NOTIFIED</code> +{" "}
            <code>BREACH_UPDATE_PUBLISHED</code> land on this tenant&rsquo;s chain so the{" "}
            <Link href={`/${tenantSlug}/admin/audit`} className="underline decoration-dotted">
              audit log
            </Link>{" "}
            preserves dispatch + acknowledgement timestamps.
          </li>
          <li>
            Acknowledging is contractually meaningful under your DPA and is logged as a
            FIRM_ADMIN action.
          </li>
        </ul>
      </section>
    </div>
  );
}
