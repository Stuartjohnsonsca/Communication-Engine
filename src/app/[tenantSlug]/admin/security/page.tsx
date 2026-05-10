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
} from "@/lib/auth/sessions";

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
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "tenant:configure-totp-policy")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

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

  async function toggleAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    requirePermission(inner.membership.role, "tenant:configure-totp-policy");
    const desired = (formData.get("requireTotp") as string | null) === "on";
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
