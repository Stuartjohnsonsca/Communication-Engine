import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import SweepButton from "./SweepButton";

export default async function ConflictsPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "members:read")) redirect(`/${tenantSlug}/dashboard`);

  const conflicted = await superDb.userCultureGuide.findMany({
    where: { tenantId: ctx.tenant.id, status: "CONFLICTED" },
    orderBy: { gracePeriodEndsAt: "asc" },
    include: {
      membership: { include: { user: { select: { email: true, name: true } } } },
      rules: { select: { id: true, suspendedAt: true } },
      basedOnFcg: { select: { version: true } },
    },
  });

  const conflictFcgIds = Array.from(
    new Set(conflicted.map((u) => u.conflictedSinceFcgId).filter((x): x is string => !!x)),
  );
  const conflictFcgs = conflictFcgIds.length
    ? await superDb.firmCultureGuide.findMany({
        where: { id: { in: conflictFcgIds } },
        select: { id: true, version: true },
      })
    : [];
  const fcgVersionById = new Map(conflictFcgs.map((f) => [f.id, f.version]));

  const canSweep = hasPermission(ctx.membership.role, "members:write");
  const now = Date.now();

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">UCG Conflicts</h1>
        {canSweep && <SweepButton tenantSlug={tenantSlug} />}
      </div>
      <p className="text-xs text-ink/60">
        PRD §5.2.2 — every committed UCG flagged when an FCG amendment makes it non-compliant.
        After the grace period (default 10 working days), the conflicting rules auto-suspend.
        Users resolve the conflict by editing their UCG and committing a new version that judges
        clean against the new FCG.
      </p>

      {conflicted.length === 0 ? (
        <div className="card text-sm text-ink/60">No UCGs are currently flagged as conflicted.</div>
      ) : (
        <div className="card">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-ink/50">
              <tr>
                <th className="py-1 pr-3">User</th>
                <th className="py-1 pr-3">UCG v</th>
                <th className="py-1 pr-3">Conflict vs FCG</th>
                <th className="py-1 pr-3">Flagged</th>
                <th className="py-1 pr-3">Grace ends</th>
                <th className="py-1 pr-3">Suspended rules</th>
              </tr>
            </thead>
            <tbody>
              {conflicted.map((u) => {
                const newV = u.conflictedSinceFcgId
                  ? fcgVersionById.get(u.conflictedSinceFcgId) ?? "?"
                  : "?";
                const overdue = u.gracePeriodEndsAt && u.gracePeriodEndsAt.getTime() < now;
                const suspended = u.rules.filter((r) => r.suspendedAt).length;
                return (
                  <tr key={u.id} className="border-t border-ink/5">
                    <td className="py-1 pr-3">
                      {u.membership.user.name ?? u.membership.user.email}
                    </td>
                    <td className="py-1 pr-3">v{u.version}</td>
                    <td className="py-1 pr-3">
                      v{u.basedOnFcg.version} → v{newV}
                    </td>
                    <td className="py-1 pr-3 text-xs">
                      {u.conflictFlaggedAt?.toISOString().slice(0, 10) ?? "—"}
                    </td>
                    <td className={`py-1 pr-3 text-xs ${overdue ? "text-red-700 font-medium" : ""}`}>
                      {u.gracePeriodEndsAt?.toISOString().slice(0, 10) ?? "—"}
                      {overdue && !u.conflictAutoSuspendedAt && " · due"}
                      {u.conflictAutoSuspendedAt && " · swept"}
                    </td>
                    <td className="py-1 pr-3">{suspended}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
