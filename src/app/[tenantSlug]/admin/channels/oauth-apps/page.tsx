import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission, requirePermission } from "@/lib/rbac";
import {
  listTenantOAuthApps,
  oauthCapableChannelKinds,
  upsertTenantOAuthApp,
  deleteTenantOAuthApp,
} from "@/lib/channels/oauth-apps";

/**
 * Post-PRD hardening item 101 — bring-your-own OAuth app per tenant
 * per channel kind.
 *
 * Each Client (tenant) registers their own Google Cloud / Microsoft /
 * Slack OAuth application and pastes the resulting client_id +
 * client_secret here. The platform stores these per-tenant; the
 * connect + callback routes use them to drive the OAuth handshake on
 * behalf of the Client's own provider app, not a shared Acumon one.
 *
 * The redirect URI displayed below is what the Client must whitelist
 * on the provider side — derived from the current request origin so
 * it Just Works in dev / staging / prod without env vars.
 */
export default async function OAuthAppsPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantSlug: string }>;
  searchParams?: Promise<{ saved?: string; deleted?: string; error?: string }>;
}) {
  const { tenantSlug } = await params;
  const sp = (await searchParams) ?? {};
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "tenant:configure-channel-oauth-app")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const kinds = oauthCapableChannelKinds();
  const configured = await listTenantOAuthApps(ctx.tenant.id);
  const configuredByKind = new Map(configured.map((c) => [c.channelKind, c]));

  // Best-effort detect the public origin so the displayed redirect URI
  // matches what the Client will paste into the provider console. In
  // production behind Railway's proxy, x-forwarded-host + proto carry
  // the right values; locally we fall back to host header.
  const reqHeaders = await headers();
  const proto = reqHeaders.get("x-forwarded-proto") ?? "https";
  const host = reqHeaders.get("x-forwarded-host") ?? reqHeaders.get("host") ?? "localhost:3000";
  const redirectUri = `${proto}://${host}/api/channels/oauth-callback`;

  async function saveAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    requirePermission(inner.membership.role, "tenant:configure-channel-oauth-app");
    const channelKind = String(formData.get("channelKind") ?? "");
    const clientId = String(formData.get("clientId") ?? "");
    const clientSecret = String(formData.get("clientSecret") ?? "");
    try {
      await upsertTenantOAuthApp({
        tenantId: inner.tenant.id,
        channelKind,
        clientId,
        clientSecret,
        actorMembershipId: inner.membership.id,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "save failed";
      redirect(
        `/${tenantSlug}/admin/channels/oauth-apps?error=${encodeURIComponent(
          `${channelKind}: ${msg}`,
        )}`,
      );
    }
    revalidatePath(`/${tenantSlug}/admin/channels/oauth-apps`);
    redirect(
      `/${tenantSlug}/admin/channels/oauth-apps?saved=${encodeURIComponent(channelKind)}`,
    );
  }

  async function deleteAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    requirePermission(inner.membership.role, "tenant:configure-channel-oauth-app");
    const channelKind = String(formData.get("channelKind") ?? "");
    await deleteTenantOAuthApp({
      tenantId: inner.tenant.id,
      channelKind,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/admin/channels/oauth-apps`);
    redirect(
      `/${tenantSlug}/admin/channels/oauth-apps?deleted=${encodeURIComponent(channelKind)}`,
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">OAuth provider apps</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Each Client registers their own OAuth app with the provider (Google
          Cloud Console, Microsoft Entra, Slack API portal) and enters the{" "}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">client_id</code>{" "}
          + <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">client_secret</code>{" "}
          below. Acumon never sees plaintext provider tokens; the secret is
          encrypted at rest and only decrypted in-memory at handshake time.
          Saving is audited; the secret value never appears in audit payloads.
        </p>
        <div className="mt-3 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm dark:border-blue-900 dark:bg-blue-900/20">
          <strong>Redirect URI for the provider console:</strong>{" "}
          <code className="block break-all rounded bg-white px-2 py-1 font-mono text-xs dark:bg-zinc-900">
            {redirectUri}
          </code>
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
            Paste this verbatim into the OAuth client&rsquo;s &ldquo;Authorized
            redirect URIs&rdquo; on Google / &ldquo;Redirect URI&rdquo; on
            Microsoft / &ldquo;Redirect URLs&rdquo; on Slack. Trailing slash
            matters; copy exactly.
          </p>
        </div>
      </header>

      {sp.saved && (
        <div className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300">
          Saved {sp.saved}.
        </div>
      )}
      {sp.deleted && (
        <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          Removed {sp.deleted}. Connections via this provider will fall back to
          platform defaults if any are configured; otherwise users will see a
          configuration error until a new app is added.
        </div>
      )}
      {sp.error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          {sp.error}
        </div>
      )}

      <div className="space-y-5">
        {kinds.map(({ kind, label, scopeDefault, authorizeUrl }) => {
          const existing = configuredByKind.get(kind);
          return (
            <section
              key={kind}
              className="rounded border border-zinc-200 p-4 dark:border-zinc-800"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">{label}</h2>
                {existing ? (
                  <span className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/30 dark:text-green-300">
                    Configured · client {existing.clientIdLast4}
                  </span>
                ) : (
                  <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                    Not configured
                  </span>
                )}
              </div>
              <dl className="mt-2 space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                <div>
                  <dt className="inline font-medium">Authorize URL:</dt>{" "}
                  <code className="break-all">{authorizeUrl}</code>
                </div>
                <div>
                  <dt className="inline font-medium">Scopes requested:</dt>{" "}
                  <code className="break-all">{scopeDefault.join(" ")}</code>
                </div>
                {existing && (
                  <div>
                    <dt className="inline font-medium">Last updated:</dt>{" "}
                    {existing.updatedAt.toISOString()}
                  </div>
                )}
              </dl>

              <form action={saveAction} className="mt-4 space-y-3">
                <input type="hidden" name="channelKind" value={kind} />
                <div>
                  <label
                    className="block text-sm font-medium"
                    htmlFor={`${kind}-clientId`}
                  >
                    Client ID
                  </label>
                  <input
                    id={`${kind}-clientId`}
                    name="clientId"
                    type="text"
                    required
                    autoComplete="off"
                    defaultValue=""
                    placeholder={
                      existing
                        ? `Replacing existing (${existing.clientIdLast4}) — re-enter full client_id`
                        : "Paste from provider console"
                    }
                    className="mt-1 block w-full rounded border border-zinc-300 px-2 py-1 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  />
                </div>
                <div>
                  <label
                    className="block text-sm font-medium"
                    htmlFor={`${kind}-clientSecret`}
                  >
                    Client secret
                  </label>
                  <input
                    id={`${kind}-clientSecret`}
                    name="clientSecret"
                    type="password"
                    required
                    autoComplete="new-password"
                    defaultValue=""
                    placeholder="Paste from provider console (write-only — never displayed back)"
                    className="mt-1 block w-full rounded border border-zinc-300 px-2 py-1 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  />
                  <p className="mt-1 text-xs text-zinc-500">
                    Encrypted at rest. Saving requires the full secret on every
                    submission &mdash; we never &ldquo;preserve the existing
                    secret&rdquo; on a partial save.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    type="submit"
                    className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                  >
                    {existing ? "Update" : "Save"}
                  </button>
                  {existing && (
                    <p className="text-xs text-zinc-500">
                      Updating rotates the stored credentials immediately;
                      already-issued tokens keep working until the provider
                      revokes them.
                    </p>
                  )}
                </div>
              </form>

              {existing && (
                <form action={deleteAction} className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                  <input type="hidden" name="channelKind" value={kind} />
                  <button
                    type="submit"
                    className="rounded border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/20"
                  >
                    Remove app for {label}
                  </button>
                  <p className="mt-1 text-xs text-zinc-500">
                    Connections via this provider will stop working unless a
                    platform-level fallback is configured. New connect attempts
                    will return a 503 &ldquo;not configured&rdquo; error.
                  </p>
                </form>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
