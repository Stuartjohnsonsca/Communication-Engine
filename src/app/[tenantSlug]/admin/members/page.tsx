import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";

export default async function MembersPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  const members = await superDb.membership.findMany({
    where: { tenantId: ctx.tenant.id },
    include: { user: true },
    orderBy: { joinedAt: "asc" },
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
      <p className="text-xs text-ink/60">
        PRD §6.3: changes to FCT membership require two-Administrator approval. UI for that is in
        Phase 2 — for now, edit via seed/console.
      </p>
      <div className="card">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-ink/50">
            <tr>
              <th className="py-1 pr-3">Email</th>
              <th className="py-1 pr-3">Role</th>
              <th className="py-1 pr-3">Status</th>
              <th className="py-1 pr-3">Joined</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-t border-ink/5">
                <td className="py-1 pr-3">{m.user.email}</td>
                <td className="py-1 pr-3">
                  <span className="tag">{m.role}</span>
                </td>
                <td className="py-1 pr-3">{m.status}</td>
                <td className="py-1 pr-3 text-xs">{m.joinedAt.toISOString().slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
