import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { hasPermission, requirePermission } from "@/lib/rbac";
import { writeAuditEvent } from "@/lib/audit";
import {
  listActiveSessionsInTenant,
  revokeSession,
  revokeAllSessionsForUser,
  maskIp,
  DEFAULT_IDLE_TIMEOUT_MINUTES,
  DEFAULT_ABSOLUTE_TIMEOUT_MINUTES,
  MIN_IDLE_TIMEOUT_MINUTES,
  MAX_IDLE_TIMEOUT_MINUTES,
  MIN_ABSOLUTE_TIMEOUT_MINUTES,
  MAX_ABSOLUTE_TIMEOUT_MINUTES,
} from "@/lib/auth/sessions";
import { updateTenantAllowlist, AllowlistValidationError } from "@/lib/auth/ip-allowlist";
import { requireStepUp, resolveCurrentSessionId, StepUpRequired } from "@/lib/auth/totp";

/**
 * Tenant-wide 2FA policy. The Firm Administrator can require every active
 * Membership in the tenant to enroll a verified UserTotp; until they do,
 * the layout-level gate redirects them to /account to enroll. The page
 * also surfaces a per-Membership enrollment readiness view so the FCT /
 * FIRM_ADMIN can see who is gated and who is not before flipping the
 * policy.
 */

export default async function SecurityPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantSlug: string }>;
  searchParams?: Promise<{ allowlistSaved?: string; allowlistError?: string }>;
}) {
  const { tenantSlug } = await params;
  const sp = (await searchParams) ?? {};
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "tenant:configure-totp-policy")) {
    redirect(`/${tenantSlug}/dashboard`);
  }
  const canConfigureAllowlist = hasPermission(ctx.membership.role, "tenant:configure-ip-allowlist");

  const [memberships, tenantSessions] = await Promise.all([
    superDb.membership.findMany({
      where: { tenantId: ctx.tenant.id, status: "ACTIVE" },
      include: { user: { select: { id: true, email: true, totp: { select: { verifiedAt: true, disabledAt: true, lastUsedAt: true } } } } },
      orderBy: { joinedAt: "asc" },
    }),
    listActiveSessionsInTenant(ctx.tenant.id),
  ]);

  const totalActive = memberships.length;
  const enrolled = memberships.filter(
    (m) => m.user.totp?.verifiedAt && !m.user.totp.disabledAt,
  ).length;
  const canRevokeMembers = hasPermission(ctx.membership.role, "tenant:revoke-member-sessions");

  async function adminRevokeSessionAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    requirePermission(inner.membership.role, "tenant:revoke-member-sessions");
    const sessionId = (formData.get("sessionId") as string | null)?.trim();
    if (!sessionId) throw new Error("missing sessionId");
    // Confirm the target session belongs to a User with an ACTIVE membership
    // in THIS tenant — prevents a FIRM_ADMIN of tenant A from revoking a
    // session that belongs to a User who happens to share a userId but is
    // only a member of tenant B.
    const row = await superDb.session.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });
    if (!row) throw new Error("not found");
    const tenantMembership = await superDb.membership.findFirst({
      where: { tenantId: inner.tenant.id, userId: row.userId, status: "ACTIVE" },
      select: { id: true },
    });
    if (!tenantMembership) throw new Error("forbidden");
    await revokeSession({
      sessionId,
      reason: "admin-revoke",
      ctx: {
        tenantId: inner.tenant.id,
        actorMembershipId: inner.membership.id,
        actorUserId: inner.user.id,
      },
    });
    revalidatePath(`/${tenantSlug}/admin/security`);
  }

  async function adminRevokeAllForUserAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    requirePermission(inner.membership.role, "tenant:revoke-member-sessions");
    const targetUserId = (formData.get("userId") as string | null)?.trim();
    if (!targetUserId) throw new Error("missing userId");
    const tenantMembership = await superDb.membership.findFirst({
      where: { tenantId: inner.tenant.id, userId: targetUserId, status: "ACTIVE" },
      select: { id: true },
    });
    if (!tenantMembership) throw new Error("forbidden");
    await revokeAllSessionsForUser({
      targetUserId,
      reason: "admin-revoke-all",
      ctx: {
        tenantId: inner.tenant.id,
        actorMembershipId: inner.membership.id,
        actorUserId: inner.user.id,
      },
    });
    revalidatePath(`/${tenantSlug}/admin/security`);
  }

  // Shared step-up gate for sensitive mutations on this page. The
  // helper redirects to /auth/2fa?stepUp=1 with `next` set to the
  // current page so the User lands back here after re-verifying.
  // On stale/no-totp it never returns (redirects via Next.js); on
  // fresh it returns normally.
  async function gateStepUp(opKey: string) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) redirect("/login");
    const sessionId = await resolveCurrentSessionId();
    try {
      await requireStepUp({
        sessionId,
        userId: inner.user.id,
        tenantStepUpMaxAgeMinutes: inner.tenant.stepUpMaxAgeMinutes,
        nextUrl: `/${tenantSlug}/admin/security`,
        opKey,
      });
    } catch (err) {
      if (err instanceof StepUpRequired) {
        redirect(
          `/${tenantSlug}/auth/2fa?stepUp=1&op=${encodeURIComponent(err.opKey)}&next=${encodeURIComponent(err.nextUrl)}`,
        );
      }
      throw err;
    }
  }

  async function updateTimeoutsAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    requirePermission(inner.membership.role, "tenant:configure-session-timeout");
    await gateStepUp("session-timeouts-change");
    function parse(raw: FormDataEntryValue | null): number | null {
      if (typeof raw !== "string") return null;
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      const n = Number.parseInt(trimmed, 10);
      if (!Number.isFinite(n) || n <= 0) return null;
      return n;
    }
    const rawIdle = parse(formData.get("sessionIdleTimeoutMinutes"));
    const rawAbs = parse(formData.get("sessionAbsoluteTimeoutMinutes"));
    const idle =
      rawIdle === null
        ? null
        : Math.min(MAX_IDLE_TIMEOUT_MINUTES, Math.max(MIN_IDLE_TIMEOUT_MINUTES, rawIdle));
    const absolute =
      rawAbs === null
        ? null
        : Math.min(
            MAX_ABSOLUTE_TIMEOUT_MINUTES,
            Math.max(MIN_ABSOLUTE_TIMEOUT_MINUTES, rawAbs),
          );
    if (idle !== null && absolute !== null && idle > absolute) {
      throw new Error("idle timeout cannot exceed absolute timeout");
    }
    const before = {
      idle: inner.tenant.sessionIdleTimeoutMinutes,
      absolute: inner.tenant.sessionAbsoluteTimeoutMinutes,
    };
    if (before.idle === idle && before.absolute === absolute) return;
    await superDb.tenant.update({
      where: { id: inner.tenant.id },
      data: {
        sessionIdleTimeoutMinutes: idle,
        sessionAbsoluteTimeoutMinutes: absolute,
      },
    });
    await writeAuditEvent({
      tenantId: inner.tenant.id,
      eventType: "TENANT_SESSION_TIMEOUT_CHANGED",
      actorMembershipId: inner.membership.id,
      subjectType: "Tenant",
      subjectId: inner.tenant.id,
      payload: {
        before,
        after: { idle, absolute },
      },
    });
    revalidatePath(`/${tenantSlug}/admin/security`);
  }

  async function updateAllowlistAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    requirePermission(inner.membership.role, "tenant:configure-ip-allowlist");
    await gateStepUp("ip-allowlist-change");
    const raw = (formData.get("allowedIpCidrs") as string | null) ?? "";
    // Split on newline OR comma so admins can paste either format.
    const lines = raw.split(/[\n,]/);
    try {
      await updateTenantAllowlist({
        tenantId: inner.tenant.id,
        actorMembershipId: inner.membership.id,
        lines,
      });
    } catch (err) {
      if (err instanceof AllowlistValidationError) {
        redirect(`/${tenantSlug}/admin/security?allowlistError=${encodeURIComponent(err.errors.join("; "))}`);
      }
      throw err;
    }
    revalidatePath(`/${tenantSlug}/admin/security`);
    redirect(`/${tenantSlug}/admin/security?allowlistSaved=1`);
  }

  async function toggleAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    requirePermission(inner.membership.role, "tenant:configure-totp-policy");
    const desired = (formData.get("requireTotp") as string | null) === "on";
    // Only gate step-up when the policy actually changes — a stable
    // form re-submit is a no-op below and shouldn't trigger a fresh
    // challenge dialog.
    if (inner.tenant.requireTotp !== desired) {
      await gateStepUp("totp-policy-change");
    }
    if (inner.tenant.requireTotp === desired) return;
    await superDb.tenant.update({
      where: { id: inner.tenant.id },
      data: { requireTotp: desired },
    });
    await writeAuditEvent({
      tenantId: inner.tenant.id,
      eventType: "TENANT_TOTP_REQUIREMENT_CHANGED",
      actorMembershipId: inner.membership.id,
      subjectType: "Tenant",
      subjectId: inner.tenant.id,
      payload: { requireTotp: desired },
    });
    revalidatePath(`/${tenantSlug}/admin/security`);
    revalidatePath(`/${tenantSlug}`, "layout");
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Security policy</h1>
        <p className="mt-1 text-sm text-ink/70">
          Tenant-wide authentication posture. When two-factor authentication is required,
          every active Membership is redirected to /account to enroll a TOTP authenticator
          before they can reach any tenant page. Sign-in itself remains a magic-code email;
          the second factor is enforced as a step-up on entry to the tenant.
        </p>
      </div>

      <form action={updateTimeoutsAction} className="card space-y-3">
        <h2 className="text-base font-medium">Session timeouts</h2>
        <p className="text-xs text-ink/60">
          Sessions are auto-revoked when they exceed either threshold. Idle timeout
          measures the gap since the last authenticated request from the session;
          absolute timeout measures the age of the session since sign-in regardless
          of activity. Leave a field blank to inherit the platform default ({DEFAULT_IDLE_TIMEOUT_MINUTES}{" "}
          minutes idle, {DEFAULT_ABSOLUTE_TIMEOUT_MINUTES} minutes / 24h absolute).
          Cross-tenant Users inherit the strictest active membership's threshold.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="block text-xs uppercase tracking-wider text-ink/50">
              Idle timeout (minutes)
            </span>
            <input
              name="sessionIdleTimeoutMinutes"
              type="number"
              min={MIN_IDLE_TIMEOUT_MINUTES}
              max={MAX_IDLE_TIMEOUT_MINUTES}
              defaultValue={ctx.tenant.sessionIdleTimeoutMinutes ?? ""}
              placeholder={`${DEFAULT_IDLE_TIMEOUT_MINUTES} (default)`}
              className="mt-1 w-full rounded border border-ink/15 px-2 py-1 text-sm"
            />
            <span className="text-[11px] text-ink/50">
              {MIN_IDLE_TIMEOUT_MINUTES}–{MAX_IDLE_TIMEOUT_MINUTES} minutes
            </span>
          </label>
          <label className="text-sm">
            <span className="block text-xs uppercase tracking-wider text-ink/50">
              Absolute timeout (minutes)
            </span>
            <input
              name="sessionAbsoluteTimeoutMinutes"
              type="number"
              min={MIN_ABSOLUTE_TIMEOUT_MINUTES}
              max={MAX_ABSOLUTE_TIMEOUT_MINUTES}
              defaultValue={ctx.tenant.sessionAbsoluteTimeoutMinutes ?? ""}
              placeholder={`${DEFAULT_ABSOLUTE_TIMEOUT_MINUTES} (default)`}
              className="mt-1 w-full rounded border border-ink/15 px-2 py-1 text-sm"
            />
            <span className="text-[11px] text-ink/50">
              {MIN_ABSOLUTE_TIMEOUT_MINUTES}–{MAX_ABSOLUTE_TIMEOUT_MINUTES} minutes
            </span>
          </label>
        </div>
        <div className="flex justify-end">
          <button type="submit" className="btn btn-primary text-sm">
            Save timeouts
          </button>
        </div>
      </form>

      <form action={updateAllowlistAction} className="card space-y-3">
        <h2 className="text-base font-medium">IP allowlist</h2>
        <p className="text-xs text-ink/60">
          Restrict authenticated access to specific networks. Applies to
          BOTH browser sessions (this layout enforces) and API keys
          (<code>/api/v1/*</code> calls). Leave empty for no restriction.
          One CIDR per line — also accepts comma-separated lists from a
          paste. IPv4 and IPv6 are both supported; single hosts can be
          written without a slash (auto-expanded to /32 or /128).
        </p>
        {sp.allowlistError && (
          <div className="rounded border border-red-300 bg-red-50/60 px-3 py-2 text-xs text-red-800">
            {sp.allowlistError}
          </div>
        )}
        {sp.allowlistSaved && !sp.allowlistError && (
          <div className="rounded border border-emerald-300 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-800">
            Allowlist saved.
          </div>
        )}
        <label className="block text-sm">
          <span className="block text-xs uppercase tracking-wider text-ink/50">
            Allowed networks (one per line)
          </span>
          <textarea
            name="allowedIpCidrs"
            rows={6}
            defaultValue={ctx.tenant.allowedIpCidrs.join("\n")}
            disabled={!canConfigureAllowlist}
            placeholder={"192.0.2.0/24\n203.0.113.5\n2001:db8::/32"}
            className="mt-1 w-full rounded border border-ink/15 px-2 py-1 font-mono text-xs disabled:bg-ink/5"
          />
        </label>
        <p className="text-[11px] text-ink/50">
          <strong>Warning:</strong> a misconfigured list can lock every
          member out — including the Firm Administrator. The platform
          will not reach in and clear it; recovery requires direct DB
          access. Test from a candidate network before relying on this.
        </p>
        {canConfigureAllowlist && (
          <div className="flex justify-end">
            <button type="submit" className="btn btn-primary text-sm">
              Save allowlist
            </button>
          </div>
        )}
      </form>

      <form action={toggleAction} className="card space-y-3">
        <h2 className="text-base font-medium">Two-factor authentication</h2>
        <div className="flex items-center gap-3">
          <input
            id="requireTotp"
            name="requireTotp"
            type="checkbox"
            defaultChecked={ctx.tenant.requireTotp}
            className="h-4 w-4"
          />
          <label htmlFor="requireTotp" className="text-sm">
            Require every active Membership to enroll TOTP 2FA
          </label>
        </div>
        <p className="text-xs text-ink/60">
          Currently <strong>{enrolled}</strong> of <strong>{totalActive}</strong> active members are enrolled.
          {ctx.tenant.requireTotp ? " Policy: required." : " Policy: optional."}
        </p>
        <div className="flex justify-end">
          <button type="submit" className="btn btn-primary text-sm">
            Save policy
          </button>
        </div>
      </form>

      {canRevokeMembers && (
        <div className="card space-y-3">
          <h2 className="text-base font-medium">Active sessions</h2>
          <p className="text-sm text-ink/70">
            Every active session for a User who has an ACTIVE membership in this tenant.
            Revoking a session signs that device out on its next request; the row is
            preserved for audit history. Revoking <em>all</em> sessions for a member is
            global — they will be signed out of every tenant they belong to and must
            sign in again. Use this for incident response (compromised credentials,
            lost device).
          </p>
          {tenantSessions.length === 0 ? (
            <p className="text-sm text-ink/60">No active sessions in this tenant.</p>
          ) : (
            <ul className="space-y-3 text-sm">
              {tenantSessions.map((entry) => (
                <li
                  key={entry.user.id}
                  className="border-t border-ink/5 pt-2 first:border-0 first:pt-0"
                >
                  <div className="flex items-baseline justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2">
                      <span className="tag">{entry.role}</span>
                      <span className="font-medium">{entry.user.email}</span>
                      <span className="text-xs text-ink/50">
                        ({entry.sessions.length} session{entry.sessions.length === 1 ? "" : "s"})
                      </span>
                    </div>
                    <form action={adminRevokeAllForUserAction}>
                      <input type="hidden" name="userId" value={entry.user.id} />
                      <button type="submit" className="btn text-xs">
                        Revoke all
                      </button>
                    </form>
                  </div>
                  <ul className="mt-1 space-y-1">
                    {entry.sessions.map((s) => (
                      <li
                        key={s.id}
                        className="flex flex-col gap-1 text-xs text-ink/70 sm:flex-row sm:items-baseline sm:justify-between"
                      >
                        <div className="min-w-0 flex-1">
                          {s.device.label}
                          {s.totpVerifiedAt && (
                            <span className="ml-2 inline-flex items-center rounded bg-sky-50 px-1.5 py-0.5 text-[10px] text-sky-800">
                              2FA
                            </span>
                          )}
                          <span className="text-ink/50">
                            {" · "}IP {maskIp(s.ipAddress)}
                            {" · "}last seen {s.lastSeenAt.toISOString().slice(0, 16).replace("T", " ")}
                          </span>
                        </div>
                        <form action={adminRevokeSessionAction}>
                          <input type="hidden" name="sessionId" value={s.id} />
                          <button type="submit" className="btn text-xs">
                            Revoke
                          </button>
                        </form>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="card space-y-3">
        <h2 className="text-base font-medium">Member enrollment</h2>
        <ul className="space-y-1 text-sm">
          {memberships.map((m) => {
            const t = m.user.totp;
            const isEnrolled = !!t?.verifiedAt && !t.disabledAt;
            return (
              <li
                key={m.id}
                className="flex items-baseline justify-between border-t border-ink/5 pt-1 first:border-0 first:pt-0"
              >
                <div className="flex items-center gap-2">
                  <span className="tag">{m.role}</span>
                  <span>{m.user.email}</span>
                </div>
                <div className="text-xs">
                  {isEnrolled ? (
                    <span className="text-emerald-700">
                      Enrolled
                      {t.lastUsedAt ? ` · last used ${t.lastUsedAt.toISOString().slice(0, 10)}` : ""}
                    </span>
                  ) : (
                    <span className="text-amber-700">Not enrolled</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
