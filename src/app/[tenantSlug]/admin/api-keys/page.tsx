import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission, requirePermission } from "@/lib/rbac";
import {
  createApiKey,
  revokeApiKey,
  listApiKeysForTenant,
  SCOPE_CATALOGUE,
  ApiKeyValidationError,
  ScopeError,
} from "@/lib/auth/api-keys";

/**
 * Programmatic API keys admin (post-PRD hardening item 16).
 *
 * FIRM_ADMIN creates / revokes keys. FCT_MEMBER can read for governance
 * oversight (knowing what credentials exist is part of their remit, same
 * posture as webhooks). The plaintext key is shown exactly once via the
 * `?secret=…` round-trip pattern that webhooks already uses; it is wiped
 * from the URL on the user's next render.
 *
 * Scopes assignable to a key are limited to those backed by RBAC
 * permissions the issuing Firm Administrator's role itself holds — a key
 * can never grant access the creator wouldn't have had (`assertAssignable`
 * inside the lib).
 *
 * Revocation is symmetric: the creator can revoke their own keys; a
 * FIRM_ADMIN can revoke any key in the tenant for incident response.
 */

type SearchParams = {
  created?: string;
  revoked?: string;
  error?: string;
  /// Plaintext key, surfaced exactly once after a successful create.
  secret?: string;
};

export default async function ApiKeysPage({
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
  if (!hasPermission(ctx.membership.role, "apikeys:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const keys = await listApiKeysForTenant(ctx.tenant.id, { includeRevoked: true });
  const canCreate = hasPermission(ctx.membership.role, "apikeys:create");
  const canRevokeAny = hasPermission(ctx.membership.role, "apikeys:revoke-any");

  const justCreatedId = sp.created ?? null;
  const justCreated = justCreatedId
    ? keys.find((k) => k.id === justCreatedId) ?? null
    : null;

  async function createAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    requirePermission(inner.membership.role, "apikeys:create");
    const name = (formData.get("name") as string | null) ?? "";
    const wildcard = (formData.get("wildcard") as string | null) === "on";
    const scopes = wildcard
      ? ["*"]
      : formData.getAll("scopes").map((v) => String(v)).filter((v) => v && v !== "*");
    const expiresRaw = (formData.get("expiresAt") as string | null)?.trim() || null;
    let expiresAt: Date | null = null;
    if (expiresRaw) {
      const parsed = new Date(expiresRaw);
      if (Number.isNaN(parsed.getTime())) {
        redirect(`/${tenantSlug}/admin/api-keys?error=${encodeURIComponent("expiresAt is not a valid date")}`);
      }
      expiresAt = parsed;
    }
    try {
      const created = await createApiKey({
        tenantId: inner.tenant.id,
        actorMembershipId: inner.membership.id,
        actorRole: inner.membership.role,
        name,
        scopes,
        expiresAt,
      });
      revalidatePath(`/${tenantSlug}/admin/api-keys`);
      redirect(
        `/${tenantSlug}/admin/api-keys?created=${encodeURIComponent(created.apiKey.id)}&secret=${encodeURIComponent(created.plaintext)}`,
      );
    } catch (err) {
      if (err instanceof ApiKeyValidationError || err instanceof ScopeError) {
        redirect(`/${tenantSlug}/admin/api-keys?error=${encodeURIComponent(err.message)}`);
      }
      throw err;
    }
  }

  async function revokeAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    const keyId = (formData.get("keyId") as string | null)?.trim();
    if (!keyId) throw new Error("missing keyId");
    // Authorisation: either the creator (manage-own), or any FIRM_ADMIN
    // for the tenant (revoke-any). The lib re-reads the row and refuses
    // if the tenantId doesn't match, so a cross-tenant URL crash can't
    // leak.
    const target = await listApiKeysForTenant(inner.tenant.id, { includeRevoked: true });
    const row = target.find((k) => k.id === keyId);
    if (!row) {
      redirect(`/${tenantSlug}/admin/api-keys?error=${encodeURIComponent("key not found")}`);
    }
    const isOwn = row && row.createdByMembershipId === inner.membership.id;
    const canRevoke = (isOwn && hasPermission(inner.membership.role, "apikeys:manage-own"))
      || hasPermission(inner.membership.role, "apikeys:revoke-any");
    if (!canRevoke) {
      redirect(`/${tenantSlug}/admin/api-keys?error=${encodeURIComponent("you can only revoke keys you created")}`);
    }
    await revokeApiKey({
      tenantId: inner.tenant.id,
      keyId,
      actorMembershipId: inner.membership.id,
      reason: isOwn ? "user-revoke" : "admin-revoke",
    });
    revalidatePath(`/${tenantSlug}/admin/api-keys`);
    redirect(`/${tenantSlug}/admin/api-keys?revoked=${encodeURIComponent(keyId)}`);
  }

  const ownMembershipId = ctx.membership.id;
  const visibleScopes = SCOPE_CATALOGUE.filter((s) => {
    // Only show scopes the creator's role can actually grant — this is the
    // same filter `assertAssignable` enforces server-side, surfaced in the
    // UI so the user doesn't try to pick something they'll get rejected for.
    return s.requires.every((p) => hasPermission(ctx.membership.role, p));
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
        <p className="mt-1 text-sm text-ink/70">
          Programmatic access for integrators — SIEMs ingesting the audit
          chain, BI tools reading webhook delivery history, bespoke
          dashboards that need to read tenant data without a browser
          session. Each key authenticates as the Membership that created
          it (intersected with the chosen scopes); mutating compliance
          actions (FCG votes, draft creation, breach acknowledgement,
          DSAR fulfil) are never exposed here — those require a human
          session for forensic accountability.
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
            Key issued — copy it now
          </h2>
          <p className="mt-1 text-sm text-emerald-900/80">
            <strong>{justCreated.name}</strong> · prefix{" "}
            <code className="font-mono">{justCreated.prefix}</code>
          </p>
          <p className="mt-2 text-sm text-emerald-900/80">
            This is the only time the plaintext will be shown. Store it in
            your integrator's secret store — Acumon does not retain it and
            cannot re-display it. To rotate, create a new key and revoke
            this one.
          </p>
          <pre className="mt-3 break-all rounded bg-white px-3 py-2 text-sm font-mono text-ink">
            {sp.secret}
          </pre>
          <div className="mt-3">
            <Link
              href={`/${tenantSlug}/admin/api-keys`}
              className="text-sm underline decoration-dotted"
            >
              I have saved it — dismiss
            </Link>
          </div>
        </div>
      )}

      {canCreate && (
        <form action={createAction} className="card space-y-3">
          <h2 className="text-base font-medium">Issue a new key</h2>
          <label className="block text-sm">
            <span className="block font-medium">Name</span>
            <input
              type="text"
              name="name"
              required
              maxLength={120}
              placeholder="e.g. Datadog SIEM audit ingest"
              className="mt-1 w-full rounded border border-ink/10 px-2 py-1 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="block font-medium">Expires at (optional)</span>
            <input
              type="datetime-local"
              name="expiresAt"
              className="mt-1 rounded border border-ink/10 px-2 py-1 text-sm"
            />
            <p className="mt-1 text-xs text-ink/60">
              Leave blank for no automatic expiry. Maximum 5 years out.
              You can revoke at any time regardless.
            </p>
          </label>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Scopes</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="wildcard" />
              <span>
                Grant <strong>every</strong> scope your role permits (narrows
                automatically if your role is changed later)
              </span>
            </label>
            <details open className="text-sm">
              <summary className="cursor-pointer">Or pick specific scopes</summary>
              <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
                {visibleScopes.map((s) => (
                  <label key={s.scope} className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      name="scopes"
                      value={s.scope}
                      className="mt-0.5"
                    />
                    <span>
                      <code className="font-mono">{s.scope}</code>
                      <br />
                      <span className="text-ink/60">{s.description}</span>
                    </span>
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs text-ink/60">
                Only scopes assignable by your current role are shown. To
                grant a broader scope, contact a Firm Administrator.
              </p>
            </details>
          </fieldset>
          <div className="flex justify-end">
            <button type="submit" className="btn btn-primary text-sm">
              Issue key
            </button>
          </div>
        </form>
      )}

      <div className="card space-y-2">
        <h2 className="text-base font-medium">Keys</h2>
        {keys.length === 0 ? (
          <p className="text-sm text-ink/60">No API keys issued yet.</p>
        ) : (
          <ul className="divide-y divide-ink/5">
            {keys.map((k) => {
              const isOwn = k.createdByMembershipId === ownMembershipId;
              const canRevoke = !k.revokedAt && (canRevokeAny || isOwn);
              const isExpired = k.expiresAt && k.expiresAt.getTime() < Date.now();
              return (
                <li key={k.id} className="py-3">
                  <div className="flex items-baseline justify-between gap-3 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{k.name}</div>
                      <div className="text-xs text-ink/60 break-all">
                        prefix <code className="font-mono">{k.prefix}</code>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {k.scopes.includes("*") ? (
                          <span className="tag">All scopes</span>
                        ) : (
                          k.scopes.map((s) => (
                            <code key={s} className="rounded bg-ink/5 px-1.5 py-0.5 text-[10px]">
                              {s}
                            </code>
                          ))
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {k.revokedAt && (
                        <span className="tag">
                          Revoked{k.revokedReason ? ` · ${k.revokedReason}` : ""}
                        </span>
                      )}
                      {!k.revokedAt && isExpired && <span className="tag">Expired</span>}
                      {canRevoke && (
                        <form action={revokeAction}>
                          <input type="hidden" name="keyId" value={k.id} />
                          <button type="submit" className="btn text-xs">
                            Revoke
                          </button>
                        </form>
                      )}
                    </div>
                  </div>
                  <div className="mt-1 text-[11px] text-ink/50">
                    Created {k.createdAt.toISOString().slice(0, 10)}
                    {k.expiresAt && ` · expires ${k.expiresAt.toISOString().slice(0, 10)}`}
                    {k.lastUsedAt &&
                      ` · last used ${k.lastUsedAt.toISOString().slice(0, 16).replace("T", " ")}`}
                    {k.revokedAt &&
                      ` · revoked ${k.revokedAt.toISOString().slice(0, 16).replace("T", " ")}`}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="card text-sm text-ink/70">
        <h2 className="text-base font-medium text-ink">Using a key</h2>
        <p className="mt-1">
          Pass the issued string as a bearer token. Example:
        </p>
        <pre className="mt-2 break-all rounded bg-ink/5 px-3 py-2 text-xs font-mono">
{`curl -H 'Authorization: Bearer ack_<prefix>_<secret>' \\
     '${process.env.NEXT_PUBLIC_APP_URL ?? "https://your-acumon-host"}/api/v1/audit?limit=200'`}
        </pre>
        <p className="mt-2 text-xs">
          Available surfaces: <code>GET /api/v1/audit</code>,{" "}
          <code>GET /api/v1/webhooks</code>,{" "}
          <code>POST /api/v1/webhooks/replay</code>. Per-IP rate limit
          50/min on the auth point.
        </p>
      </div>
    </div>
  );
}
