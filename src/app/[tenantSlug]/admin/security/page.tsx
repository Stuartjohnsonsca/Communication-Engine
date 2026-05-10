import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { hasPermission, requirePermission } from "@/lib/rbac";
import { writeAuditEvent } from "@/lib/audit";

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

  const memberships = await superDb.membership.findMany({
    where: { tenantId: ctx.tenant.id, status: "ACTIVE" },
    include: { user: { select: { id: true, email: true, totp: { select: { verifiedAt: true, disabledAt: true, lastUsedAt: true } } } } },
    orderBy: { joinedAt: "asc" },
  });

  const totalActive = memberships.length;
  const enrolled = memberships.filter(
    (m) => m.user.totp?.verifiedAt && !m.user.totp.disabledAt,
  ).length;

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
