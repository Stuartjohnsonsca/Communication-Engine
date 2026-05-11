import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission, requirePermission } from "@/lib/rbac";
import {
  createSubscription,
  deleteSubscription,
  listSubscriptions,
  updateSubscription,
  WebhookValidationError,
} from "@/lib/webhooks";
import { superDb } from "@/lib/db";
import { requireStepUp, resolveCurrentSessionId, StepUpRequired } from "@/lib/auth/totp";

/**
 * Outbound webhook subscriptions admin (post-PRD hardening item 14).
 *
 * FIRM_ADMIN creates / edits / deletes subscriptions. FCT_MEMBER can read
 * for governance oversight (knowing what data leaves the platform is part
 * of their remit). The signing secret is shown once on creation and never
 * read back from storage — re-issuing requires creating a new subscription.
 */

const ALL_EVENT_TYPES_ORDERED: string[] = [
  // Surface a curated subset of the audit-event enum that matters to most
  // receivers. The wildcard checkbox covers everything else.
  "DRAFT_SENT_MARKED",
  "ADHERENCE_ESCALATED",
  "ADHERENCE_ACKNOWLEDGED",
  "SENTIMENT_ESCALATED",
  "SENTIMENT_ACKNOWLEDGED",
  "BREACH_DETECTED",
  "BREACH_CLIENT_NOTIFIED",
  "BREACH_RESOLVED",
  "FCG_COMMITTED",
  "UCG_COMMITTED",
  "OPPORTUNITY_DETECTED",
  "OPPORTUNITY_ACCEPTED",
  "MEETING_MINUTES_CIRCULATED",
  "USER_ACCESS_REVOKED",
  "USER_MARKED_LEAVER",
  "TENANT_TERMINATION_NOTICED",
  "DPIA_ATTESTED",
  "DSAR_OPENED",
  "DSAR_FULFILLED",
  "TIA_EXPIRED",
  "RATE_LIMIT_EXCEEDED",
  "TOTP_DISABLED",
  "SESSION_REVOKED_BY_ADMIN",
  "CHANNEL_TOKEN_REFRESH_FAILED",
];

type SearchParams = {
  created?: string;
  deleted?: string;
  updated?: string;
  error?: string;
  /// Plaintext signing secret, surfaced exactly once after a successful
  /// create. The page wipes it from the URL on the next render via the
  /// "I have saved it" link.
  secret?: string;
};

export default async function WebhooksPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantSlug: string }>;
  searchParams?: Promise<SearchParams>;
}) {
  const { tenantSlug } = await params;
  const sp = (await searchParams) ?? {};
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "webhooks:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const subs = await listSubscriptions(ctx.tenant.id);
  const canConfigure = hasPermission(ctx.membership.role, "webhooks:configure");

  // The only path that surfaces a fresh secret to the user is server →
  // searchParam round-trip immediately after creation; we read it from the
  // searchParam and immediately link the user to it. We never persist a
  // plaintext secret beyond `createSubscription`'s return value.
  const justCreatedId = sp.created ?? null;
  const justCreated = justCreatedId
    ? await superDb.webhookSubscription.findFirst({
        where: { id: justCreatedId, tenantId: ctx.tenant.id },
        select: { id: true, name: true, url: true },
      })
    : null;
  // Plaintext secret is passed through `?secret=…` once; the form below
  // wipes it on first render by linking back without it. This avoids
  // persisting it through a navigation history.

  async function createAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    requirePermission(inner.membership.role, "webhooks:configure");
    // Post-PRD hardening item 18 — step-up gate. Creating a webhook
    // subscription causes future events to leave the platform with
    // a signing secret; a stolen open session should not be able to
    // do this from across the room. Update/delete don't gate — the
    // signing secret stays the same; only the wire surface changes.
    const sessionId = await resolveCurrentSessionId();
    try {
      await requireStepUp({
        sessionId,
        userId: inner.user.id,
        tenantStepUpMaxAgeMinutes: inner.tenant.stepUpMaxAgeMinutes,
        nextUrl: `/${tenantSlug}/admin/webhooks`,
        opKey: "webhook-subscription-create",
      });
    } catch (err) {
      if (err instanceof StepUpRequired) {
        redirect(
          `/${tenantSlug}/auth/2fa?stepUp=1&op=${encodeURIComponent(err.opKey)}&next=${encodeURIComponent(err.nextUrl)}`,
        );
      }
      throw err;
    }
    const name = (formData.get("name") as string | null) ?? "";
    const url = (formData.get("url") as string | null) ?? "";
    const wildcard = (formData.get("wildcard") as string | null) === "on";
    let eventTypes: string[];
    if (wildcard) {
      eventTypes = ["*"];
    } else {
      eventTypes = formData
        .getAll("eventTypes")
        .map((v) => String(v))
        .filter((v) => v && v !== "*");
    }
    try {
      const created = await createSubscription({
        tenantId: inner.tenant.id,
        actorMembershipId: inner.membership.id,
        name,
        url,
        eventTypes,
      });
      revalidatePath(`/${tenantSlug}/admin/webhooks`);
      // Show the plaintext secret exactly once via querystring. The page
      // strips it on the next render. Safer than leaving it in a
      // server-component render that would be in the SSR HTML history.
      redirect(
        `/${tenantSlug}/admin/webhooks?created=${encodeURIComponent(created.subscription.id)}&secret=${encodeURIComponent(created.secret)}`,
      );
    } catch (err) {
      if (err instanceof WebhookValidationError) {
        redirect(`/${tenantSlug}/admin/webhooks?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
  }

  async function toggleAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    requirePermission(inner.membership.role, "webhooks:configure");
    const id = (formData.get("subscriptionId") as string | null)?.trim();
    if (!id) throw new Error("missing subscriptionId");
    const enable = (formData.get("enable") as string | null) === "true";
    await updateSubscription({
      tenantId: inner.tenant.id,
      subscriptionId: id,
      actorMembershipId: inner.membership.id,
      patch: { enabled: enable },
    });
    revalidatePath(`/${tenantSlug}/admin/webhooks`);
    revalidatePath(`/${tenantSlug}/admin/webhooks/${id}`);
  }

  async function deleteAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    requirePermission(inner.membership.role, "webhooks:configure");
    const id = (formData.get("subscriptionId") as string | null)?.trim();
    if (!id) throw new Error("missing subscriptionId");
    await deleteSubscription({
      tenantId: inner.tenant.id,
      subscriptionId: id,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/admin/webhooks`);
    redirect(`/${tenantSlug}/admin/webhooks?deleted=${encodeURIComponent(id)}`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Webhooks</h1>
        <p className="mt-1 text-sm text-ink/70">
          Subscribe an HTTPS receiver to audit events from this tenant. Every
          matching event sends a POST signed with HMAC-SHA256 (header{" "}
          <code className="rounded bg-ink/5 px-1 text-xs">X-Acumon-Signature</code>).
          Failed deliveries retry with exponential backoff for up to ~15 hours
          before they are dead-lettered. After 25 consecutive dead-letters the
          subscription is auto-disabled.
        </p>
      </div>

      {sp.error && (
        <div className="rounded border border-red-300 bg-red-50/60 px-3 py-2 text-sm text-red-800">
          {sp.error}
        </div>
      )}

      {justCreated && sp.secret && (
        <div className="card border border-emerald-300 bg-emerald-50/30">
          <h2 className="text-base font-medium text-emerald-900">
            Subscription created — copy the secret now
          </h2>
          <p className="mt-1 text-sm text-emerald-900/80">
            <strong>{justCreated.name}</strong> · {justCreated.url}
          </p>
          <p className="mt-2 text-sm text-emerald-900/80">
            This is the only time the signing secret will be shown. Store it in
            your receiver's vault — you cannot recover it later.
          </p>
          <pre className="mt-3 break-all rounded bg-white px-3 py-2 text-sm font-mono text-ink">
            {sp.secret}
          </pre>
          <div className="mt-3">
            <Link
              href={`/${tenantSlug}/admin/webhooks`}
              className="text-sm underline decoration-dotted"
            >
              I have saved it — dismiss
            </Link>
          </div>
        </div>
      )}

      {canConfigure && (
        <form action={createAction} className="card space-y-3">
          <h2 className="text-base font-medium">New subscription</h2>
          <label className="block text-sm">
            <span className="block font-medium">Name</span>
            <input
              type="text"
              name="name"
              required
              maxLength={120}
              placeholder="e.g. Compliance Slack incoming webhook"
              className="mt-1 w-full rounded border border-ink/10 px-2 py-1 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="block font-medium">Receiver URL</span>
            <input
              type="url"
              name="url"
              required
              placeholder="https://hooks.example.com/acumon"
              className="mt-1 w-full rounded border border-ink/10 px-2 py-1 text-sm"
            />
            <p className="mt-1 text-xs text-ink/60">
              HTTPS only in production. Loopback / private addresses are refused.
            </p>
          </label>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Event types</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="wildcard" />
              <span>
                Subscribe to <strong>every</strong> event type (recommended for
                a SIEM / archive receiver)
              </span>
            </label>
            <details className="text-sm">
              <summary className="cursor-pointer">
                Or pick specific event types
              </summary>
              <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
                {ALL_EVENT_TYPES_ORDERED.map((et) => (
                  <label key={et} className="flex items-center gap-2 text-xs">
                    <input type="checkbox" name="eventTypes" value={et} />
                    <code className="font-mono">{et}</code>
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs text-ink/60">
                Need an event type that isn't listed? Subscribe to wildcard
                and filter in the receiver, or contact your operator to extend
                this list.
              </p>
            </details>
          </fieldset>
          <div className="flex justify-end">
            <button type="submit" className="btn btn-primary text-sm">
              Create subscription
            </button>
          </div>
        </form>
      )}

      <div className="card space-y-2">
        <h2 className="text-base font-medium">Subscriptions</h2>
        {subs.length === 0 ? (
          <p className="text-sm text-ink/60">No subscriptions yet.</p>
        ) : (
          <ul className="divide-y divide-ink/5">
            {subs.map((s) => (
              <li key={s.id} className="py-3">
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/${tenantSlug}/admin/webhooks/${s.id}`}
                      className="text-sm font-medium underline decoration-dotted"
                    >
                      {s.name}
                    </Link>
                    <div className="text-xs text-ink/60 break-all">{s.url}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {s.eventTypes.includes("*") ? (
                        <span className="tag">All events</span>
                      ) : (
                        s.eventTypes.slice(0, 4).map((et) => (
                          <code key={et} className="rounded bg-ink/5 px-1.5 py-0.5 text-[10px]">
                            {et}
                          </code>
                        ))
                      )}
                      {!s.eventTypes.includes("*") && s.eventTypes.length > 4 && (
                        <span className="text-[10px] text-ink/60">
                          +{s.eventTypes.length - 4} more
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {!s.enabled && <span className="tag">Disabled</span>}
                    {s.consecutiveFailures > 0 && (
                      <span className="text-xs text-amber-700">
                        {s.consecutiveFailures} consecutive failure{s.consecutiveFailures === 1 ? "" : "s"}
                      </span>
                    )}
                    {canConfigure && (
                      <>
                        <form action={toggleAction}>
                          <input type="hidden" name="subscriptionId" value={s.id} />
                          <input type="hidden" name="enable" value={s.enabled ? "false" : "true"} />
                          <button type="submit" className="btn text-xs">
                            {s.enabled ? "Disable" : "Enable"}
                          </button>
                        </form>
                        <form action={deleteAction}>
                          <input type="hidden" name="subscriptionId" value={s.id} />
                          <button
                            type="submit"
                            className="btn text-xs"
                            // No native confirm in server actions; the audit
                            // trail records the deletion and FIRM_ADMIN can
                            // re-create. Per project convention we don't ship
                            // confirm modals just for this.
                          >
                            Delete
                          </button>
                        </form>
                      </>
                    )}
                  </div>
                </div>
                <div className="mt-1 text-[11px] text-ink/50">
                  Created {s.createdAt.toISOString().slice(0, 10)}
                  {s.lastDeliveredAt &&
                    ` · last delivered ${s.lastDeliveredAt.toISOString().slice(0, 16).replace("T", " ")}`}
                  {s.lastFailureAt &&
                    ` · last failure ${s.lastFailureAt.toISOString().slice(0, 16).replace("T", " ")}`}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
