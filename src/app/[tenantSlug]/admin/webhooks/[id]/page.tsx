import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission, requirePermission } from "@/lib/rbac";
import { superDb } from "@/lib/db";
import { getSubscription, replayDelivery, fireTestEvent } from "@/lib/webhooks";

/**
 * Per-subscription detail. Shows recent deliveries (PENDING + IN_FLIGHT +
 * the latest 50 terminal rows), with a per-row Replay button for any
 * DEAD_LETTERED row. The replayed delivery enqueues a fresh PENDING with
 * the original payload — receivers verify it with the same secret because
 * the payload is byte-stable.
 */

export default async function WebhookDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantSlug: string; id: string }>;
  searchParams?: Promise<{ testFired?: string; testError?: string; testDeliveryId?: string }>;
}) {
  const { tenantSlug, id } = await params;
  const sp = (await searchParams) ?? {};
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "webhooks:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const sub = await getSubscription(ctx.tenant.id, id);
  if (!sub) {
    return (
      <div className="space-y-3">
        <Link href={`/${tenantSlug}/admin/webhooks`} className="text-sm underline">
          ← Webhooks
        </Link>
        <p>Subscription not found.</p>
      </div>
    );
  }

  const recent = await superDb.webhookDelivery.findMany({
    where: { tenantId: ctx.tenant.id, subscriptionId: sub.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      eventType: true,
      status: true,
      attempt: true,
      maxAttempts: true,
      lastStatusCode: true,
      lastError: true,
      scheduledFor: true,
      completedAt: true,
      createdAt: true,
    },
  });

  const canConfigure = hasPermission(ctx.membership.role, "webhooks:configure");

  async function replayAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    requirePermission(inner.membership.role, "webhooks:configure");
    const deliveryId = (formData.get("deliveryId") as string | null)?.trim();
    if (!deliveryId) throw new Error("missing deliveryId");
    await replayDelivery({ tenantId: inner.tenant.id, deliveryId });
    revalidatePath(`/${tenantSlug}/admin/webhooks/${id}`);
  }

  async function testFireAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    requirePermission(inner.membership.role, "webhooks:configure");
    const note = (formData.get("note") as string | null)?.trim() || null;
    const result = await fireTestEvent({
      tenantId: inner.tenant.id,
      subscriptionId: id,
      actorMembershipId: inner.membership.id,
      note,
    });
    revalidatePath(`/${tenantSlug}/admin/webhooks/${id}`);
    if (result.ok) {
      redirect(
        `/${tenantSlug}/admin/webhooks/${id}?testFired=1&testDeliveryId=${encodeURIComponent(result.deliveryId)}`,
      );
    } else {
      redirect(
        `/${tenantSlug}/admin/webhooks/${id}?testError=${encodeURIComponent(result.reason)}`,
      );
    }
  }

  return (
    <div className="space-y-6">
      <Link href={`/${tenantSlug}/admin/webhooks`} className="text-sm underline">
        ← Webhooks
      </Link>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{sub.name}</h1>
        <p className="mt-1 break-all text-sm text-ink/70">{sub.url}</p>
        <div className="mt-2 flex flex-wrap gap-1">
          {sub.eventTypes.includes("*") ? (
            <span className="tag">All events</span>
          ) : (
            sub.eventTypes.map((et) => (
              <code key={et} className="rounded bg-ink/5 px-1.5 py-0.5 text-[10px]">
                {et}
              </code>
            ))
          )}
        </div>
      </div>

      <div className="card grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
        <div>
          <div className="text-xs uppercase text-ink/50">Status</div>
          <div className="font-medium">
            {sub.enabled ? "Enabled" : "Disabled"}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase text-ink/50">Last delivered</div>
          <div className="font-medium">
            {sub.lastDeliveredAt
              ? sub.lastDeliveredAt.toISOString().slice(0, 16).replace("T", " ")
              : "never"}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase text-ink/50">Last failure</div>
          <div className="font-medium">
            {sub.lastFailureAt
              ? sub.lastFailureAt.toISOString().slice(0, 16).replace("T", " ")
              : "never"}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase text-ink/50">Consecutive failures</div>
          <div className="font-medium">{sub.consecutiveFailures}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-ink/50">Auto-disable threshold</div>
          <div className="font-medium">{sub.autoDisableThreshold}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-ink/50">Last status code</div>
          <div className="font-medium">{sub.lastStatusCode ?? "—"}</div>
        </div>
      </div>

      {canConfigure && (
        <div className="card space-y-3">
          <div>
            <h2 className="text-base font-medium">Send test event</h2>
            <p className="mt-1 text-sm text-ink/70">
              Synthesises a single signed{" "}
              <code className="rounded bg-ink/5 px-1 text-xs">
                WEBHOOK_SUBSCRIPTION_TESTED
              </code>{" "}
              delivery to this subscription only, using the production
              signing key + retry pipeline. Safe to fire against disabled
              subscriptions for receiver setup verification.
            </p>
          </div>
          {sp.testFired === "1" && (
            <div className="rounded border border-emerald-300 bg-emerald-50/60 px-3 py-2 text-sm text-emerald-900">
              Test event queued.
              {sp.testDeliveryId && (
                <>
                  {" "}
                  Delivery id:{" "}
                  <code className="font-mono text-xs">{sp.testDeliveryId}</code>
                </>
              )}{" "}
              The cron worker will fire it within a minute.
            </div>
          )}
          {sp.testError && (
            <div className="rounded border border-red-300 bg-red-50/60 px-3 py-2 text-sm text-red-800">
              Test failed: {sp.testError}
            </div>
          )}
          <form action={testFireAction} className="space-y-2">
            <label className="block text-sm">
              <span className="block text-xs uppercase text-ink/50">
                Note (optional)
              </span>
              <input
                type="text"
                name="note"
                maxLength={200}
                placeholder="e.g. signature verification check 2026-05-11"
                className="mt-1 w-full rounded border border-ink/10 px-2 py-1 text-sm"
              />
            </label>
            <button type="submit" className="btn text-sm">
              Send test event
            </button>
          </form>
        </div>
      )}

      <div className="card space-y-2">
        <h2 className="text-base font-medium">Recent deliveries</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-ink/60">No deliveries yet.</p>
        ) : (
          <ul className="divide-y divide-ink/5 text-sm">
            {recent.map((d) => (
              <li key={d.id} className="py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <code className="font-mono text-xs">{d.eventType}</code>
                    <span className="ml-2 text-xs text-ink/60">
                      {statusLabel(d.status)} · attempt {d.attempt}/{d.maxAttempts}
                      {d.lastStatusCode != null && ` · HTTP ${d.lastStatusCode}`}
                    </span>
                    {d.lastError && (
                      <div className="mt-1 truncate text-xs text-amber-700">
                        {d.lastError}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-ink/60">
                    <span>
                      {(d.completedAt ?? d.createdAt).toISOString().slice(0, 16).replace("T", " ")}
                    </span>
                    {canConfigure && d.status === "DEAD_LETTERED" && (
                      <form action={replayAction}>
                        <input type="hidden" name="deliveryId" value={d.id} />
                        <button type="submit" className="btn text-xs">
                          Replay
                        </button>
                      </form>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "PENDING":
      return "Pending";
    case "IN_FLIGHT":
      return "In flight";
    case "DELIVERED":
      return "Delivered";
    case "DEAD_LETTERED":
      return "Dead-lettered";
    default:
      return status;
  }
}
