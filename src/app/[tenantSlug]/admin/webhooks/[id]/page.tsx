import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission, requirePermission } from "@/lib/rbac";
import { superDb } from "@/lib/db";
import {
  getSubscription,
  replayDelivery,
  fireTestEvent,
  getDeliveryStats,
  rotateSubscriptionSecret,
} from "@/lib/webhooks";
import { requireStepUp, resolveCurrentSessionId, StepUpRequired } from "@/lib/auth/totp";

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
  searchParams?: Promise<{
    testFired?: string;
    testError?: string;
    testDeliveryId?: string;
    /// One-shot plaintext display of the freshly-rotated secret. The page
    /// strips it on the next render — same posture as the create flow.
    rotated?: string;
    rotatedSecret?: string;
    rotatedRetiresAt?: string;
    rotateError?: string;
  }>;
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

  const [recent, stats] = await Promise.all([
    superDb.webhookDelivery.findMany({
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
    }),
    getDeliveryStats({ tenantId: ctx.tenant.id, subscriptionId: sub.id, windowHours: 24 }),
  ]);

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

  async function rotateAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    requirePermission(inner.membership.role, "webhooks:configure");
    // Rotating the signing secret is a sensitive operation — receivers
    // depend on the secret for authenticity, and a stolen open session
    // should not be able to issue a new one. Step-up like create.
    const sessionId = await resolveCurrentSessionId();
    try {
      await requireStepUp({
        sessionId,
        userId: inner.user.id,
        tenantStepUpMaxAgeMinutes: inner.tenant.stepUpMaxAgeMinutes,
        nextUrl: `/${tenantSlug}/admin/webhooks/${id}`,
        opKey: "webhook-subscription-rotate-secret",
      });
    } catch (err) {
      if (err instanceof StepUpRequired) {
        redirect(
          `/${tenantSlug}/auth/2fa?stepUp=1&op=${encodeURIComponent(err.opKey)}&next=${encodeURIComponent(err.nextUrl)}`,
        );
      }
      throw err;
    }
    const hoursRaw = (formData.get("graceWindowHours") as string | null)?.trim();
    const graceWindowHours = hoursRaw ? Number.parseInt(hoursRaw, 10) : undefined;
    // Keep `redirect()` calls OUT of the try block — Next.js signals
    // redirects by throwing a sentinel, and a generic catch would
    // swallow it.
    let success: { secret: string; prevRetiresAt: Date } | null = null;
    let errorMessage: string | null = null;
    try {
      const result = await rotateSubscriptionSecret({
        tenantId: inner.tenant.id,
        subscriptionId: id,
        actorMembershipId: inner.membership.id,
        graceWindowHours,
      });
      success = { secret: result.secret, prevRetiresAt: result.prevRetiresAt };
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : "rotation failed";
    }
    revalidatePath(`/${tenantSlug}/admin/webhooks/${id}`);
    if (success) {
      redirect(
        `/${tenantSlug}/admin/webhooks/${id}?rotated=1&rotatedSecret=${encodeURIComponent(success.secret)}&rotatedRetiresAt=${encodeURIComponent(success.prevRetiresAt.toISOString())}`,
      );
    }
    redirect(
      `/${tenantSlug}/admin/webhooks/${id}?rotateError=${encodeURIComponent(errorMessage ?? "rotation failed")}`,
    );
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

      <div className="card space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-medium">Last 24h</h2>
          <span className="text-xs text-ink/60">
            {stats.total} {stats.total === 1 ? "delivery" : "deliveries"}
          </span>
        </div>
        {stats.total === 0 ? (
          <p className="text-sm text-ink/60">No deliveries in the window.</p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <StatusPill label="Delivered" count={stats.byStatus.DELIVERED} tone="emerald" />
              <StatusPill label="Pending" count={stats.byStatus.PENDING} tone="amber" />
              <StatusPill label="In flight" count={stats.byStatus.IN_FLIGHT} tone="indigo" />
              <StatusPill label="Dead-lettered" count={stats.byStatus.DEAD_LETTERED} tone="red" />
            </div>
            <div>
              <div className="text-xs uppercase text-ink/50">Response code families</div>
              <div className="mt-1 grid grid-cols-3 gap-2 text-sm sm:grid-cols-6">
                <CodeFamily label="2xx" count={stats.byCodeFamily["2xx"]} tone="emerald" />
                <CodeFamily label="3xx" count={stats.byCodeFamily["3xx"]} tone="indigo" />
                <CodeFamily label="4xx" count={stats.byCodeFamily["4xx"]} tone="amber" />
                <CodeFamily label="5xx" count={stats.byCodeFamily["5xx"]} tone="red" />
                <CodeFamily label="network" count={stats.byCodeFamily.network} tone="slate" />
                <CodeFamily label="other" count={stats.byCodeFamily.unknown} tone="slate" />
              </div>
            </div>
            {stats.topCodes.length > 0 && (
              <div>
                <div className="text-xs uppercase text-ink/50">Top response codes</div>
                <ul className="mt-1 divide-y divide-ink/5 text-sm">
                  {stats.topCodes.map((c) => (
                    <li key={String(c.code)} className="flex items-baseline justify-between py-1">
                      <code className="font-mono text-xs">
                        {c.code === "network" ? "no response (network)" : `HTTP ${c.code}`}
                      </code>
                      <span className="text-xs text-ink/60">
                        {c.count} ({((c.count / stats.total) * 100).toFixed(0)}%)
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      {canConfigure && (
        <div className="card space-y-3">
          <div>
            <h2 className="text-base font-medium">Signing secret</h2>
            <p className="mt-1 text-sm text-ink/70">
              Rotate the HMAC signing secret without recreating the
              subscription. The dispatcher signs payloads with both the
              new and the old secret during a grace window, so receivers
              can roll their stored secret over without dropping
              deliveries.
            </p>
          </div>
          {sub.secretPrevRetiresAt && sub.secretPrevRetiresAt > new Date() && (
            <div className="rounded border border-amber-300 bg-amber-50/60 px-3 py-2 text-sm text-amber-900">
              Rotation grace window active — previous secret retires{" "}
              {sub.secretPrevRetiresAt.toISOString().slice(0, 16).replace("T", " ")} UTC.
              Receivers should be running on the new secret by then.
            </div>
          )}
          {sp.rotated === "1" && sp.rotatedSecret && (
            <div className="rounded border border-emerald-300 bg-emerald-50/60 px-3 py-2 text-sm text-emerald-900">
              <div className="font-medium">New signing secret generated.</div>
              <p className="mt-1 text-xs">
                Copy this now — it will not be shown again. The previous
                secret stays valid until{" "}
                {sp.rotatedRetiresAt
                  ? sp.rotatedRetiresAt.slice(0, 16).replace("T", " ") + " UTC"
                  : "the grace window expires"}
                .
              </p>
              <pre className="mt-2 overflow-x-auto rounded bg-ink/5 px-2 py-1 font-mono text-xs">
                {sp.rotatedSecret}
              </pre>
              <Link
                href={`/${tenantSlug}/admin/webhooks/${id}`}
                className="mt-2 inline-block text-xs underline"
              >
                I have saved it — hide
              </Link>
            </div>
          )}
          {sp.rotateError && (
            <div className="rounded border border-red-300 bg-red-50/60 px-3 py-2 text-sm text-red-800">
              Rotation failed: {sp.rotateError}
            </div>
          )}
          <form action={rotateAction} className="space-y-2">
            <label className="block text-sm">
              <span className="block text-xs uppercase text-ink/50">
                Grace window (hours, 1–168 — default 24)
              </span>
              <input
                type="number"
                name="graceWindowHours"
                min={1}
                max={168}
                defaultValue={24}
                className="mt-1 w-32 rounded border border-ink/10 px-2 py-1 text-sm"
              />
            </label>
            <button type="submit" className="btn text-sm">
              Rotate signing secret
            </button>
          </form>
        </div>
      )}

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

type Tone = "emerald" | "amber" | "indigo" | "red" | "slate";

const TONE_CLASSES: Record<Tone, string> = {
  emerald: "border-emerald-300 bg-emerald-50/60 text-emerald-900",
  amber: "border-amber-300 bg-amber-50/60 text-amber-900",
  indigo: "border-indigo-300 bg-indigo-50/60 text-indigo-900",
  red: "border-red-300 bg-red-50/60 text-red-900",
  slate: "border-ink/10 bg-ink/5 text-ink/80",
};

function StatusPill({ label, count, tone }: { label: string; count: number; tone: Tone }) {
  return (
    <div className={`rounded border px-2 py-1 ${TONE_CLASSES[tone]}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-lg font-medium leading-tight">{count}</div>
    </div>
  );
}

function CodeFamily({ label, count, tone }: { label: string; count: number; tone: Tone }) {
  return (
    <div className={`rounded border px-2 py-1 ${TONE_CLASSES[tone]}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-sm font-medium leading-tight">{count}</div>
    </div>
  );
}
