import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import {
  markLeaver,
  reverseLeaver,
  reauthoriseAccess,
  runLifecycleSweep,
  getMemberLifecycleState,
} from "@/lib/lifecycle";

export default async function LifecyclePage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "lifecycle:read")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const canWrite = hasPermission(ctx.membership.role, "lifecycle:write");

  const members = await superDb.membership.findMany({
    where: { tenantId: ctx.tenant.id },
    include: { user: { select: { email: true, name: true } } },
    orderBy: [{ status: "asc" }, { joinedAt: "asc" }],
  });

  async function markLeaverAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "lifecycle:write")) throw new Error("forbidden");
    const membershipId = String(formData.get("membershipId") ?? "");
    const note = (formData.get("note") as string | null)?.trim() || null;
    if (!membershipId) throw new Error("membershipId required");
    if (membershipId === inner.membership.id) {
      throw new Error("admins cannot mark themselves as leaver — ask another admin");
    }
    await markLeaver({
      tenantId: inner.tenant.id,
      membershipId,
      actorMembershipId: inner.membership.id,
      note,
    });
    revalidatePath(`/${tenantSlug}/admin/lifecycle`);
  }

  async function reverseLeaverAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "lifecycle:write")) throw new Error("forbidden");
    const membershipId = String(formData.get("membershipId") ?? "");
    const reason = String(formData.get("reason") ?? "").trim();
    if (!membershipId || !reason) throw new Error("membershipId and reason required");
    await reverseLeaver({
      tenantId: inner.tenant.id,
      membershipId,
      actorMembershipId: inner.membership.id,
      reason,
    });
    revalidatePath(`/${tenantSlug}/admin/lifecycle`);
  }

  async function adminReauthoriseAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "lifecycle:write")) throw new Error("forbidden");
    const membershipId = String(formData.get("membershipId") ?? "");
    if (!membershipId) throw new Error("membershipId required");
    await reauthoriseAccess({
      tenantId: inner.tenant.id,
      membershipId,
      actorMembershipId: inner.membership.id,
    });
    revalidatePath(`/${tenantSlug}/admin/lifecycle`);
  }

  async function sweepAction() {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    if (!hasPermission(inner.membership.role, "lifecycle:write")) throw new Error("forbidden");
    await runLifecycleSweep({ tenantId: inner.tenant.id });
    revalidatePath(`/${tenantSlug}/admin/lifecycle`);
  }

  const counts = {
    active: 0,
    revoked: 0,
    leaver: 0,
    suspended: 0,
    anonymised: 0,
    other: 0,
  };
  for (const m of members) {
    const s = getMemberLifecycleState(m);
    if (s.kind === "active") counts.active++;
    else if (s.kind === "revoked_grace" || s.kind === "revoked_expired") counts.revoked++;
    else if (s.kind === "leaver_grace" || s.kind === "leaver_expired") counts.leaver++;
    else if (s.kind === "suspended") counts.suspended++;
    else if (s.kind === "anonymised") counts.anonymised++;
    else counts.other++;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">User lifecycle</h1>
        <p className="mt-1 text-sm text-ink/70">
          PRD §14.3 — joiner, mover, revocation and leaver. The 30-day grace windows on
          revocation and leaver flip into anonymisation at the next sweep.
        </p>
      </div>

      <div className="card grid grid-cols-2 gap-3 text-sm sm:grid-cols-6">
        <Stat label="Active" value={counts.active} />
        <Stat label="Revoked (grace)" value={counts.revoked} />
        <Stat label="Leaver-frozen" value={counts.leaver} />
        <Stat label="Suspended" value={counts.suspended} />
        <Stat label="Anonymised" value={counts.anonymised} />
        <Stat label="Other" value={counts.other} />
      </div>

      {canWrite && (
        <form action={sweepAction} className="card flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <div className="font-medium">Run sweep now</div>
            <p className="text-xs text-ink/60">
              Manually trigger the lifecycle sweep. In production this runs automatically
              via /api/cron/lifecycle-sweep.
            </p>
          </div>
          <button type="submit" className="btn text-sm">
            Run sweep
          </button>
        </form>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-ink/50">
            <tr>
              <th className="py-1 pr-3">Member</th>
              <th className="py-1 pr-3">Role</th>
              <th className="py-1 pr-3">State</th>
              <th className="py-1 pr-3">Detail</th>
              {canWrite && <th className="py-1 pr-3">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const state = getMemberLifecycleState(m);
              return (
                <tr key={m.id} className="border-t border-ink/5 align-top">
                  <td className="py-2 pr-3">
                    <div>{m.user.name ?? m.user.email}</div>
                    {m.user.name && <div className="text-xs text-ink/50">{m.user.email}</div>}
                  </td>
                  <td className="py-2 pr-3">
                    <span className="tag">{m.role}</span>
                  </td>
                  <td className="py-2 pr-3">
                    <StateBadge state={state} />
                  </td>
                  <td className="py-2 pr-3 text-xs text-ink/70">
                    <StateDetail state={state} notes={m.lifecycleNotes} />
                  </td>
                  {canWrite && (
                    <td className="py-2 pr-3">
                      <MemberActions
                        membershipId={m.id}
                        state={state}
                        markLeaverAction={markLeaverAction}
                        reverseLeaverAction={reverseLeaverAction}
                        reauthoriseAction={adminReauthoriseAction}
                      />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-ink/50">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}

function StateBadge({ state }: { state: ReturnType<typeof getMemberLifecycleState> }) {
  const map: Record<string, { label: string; cls: string }> = {
    active:           { label: "active",         cls: "bg-emerald-100 text-emerald-800" },
    revoked_grace:    { label: "revoked",        cls: "bg-amber-100 text-amber-800" },
    revoked_expired:  { label: "revoke-expired", cls: "bg-red-100 text-red-800" },
    leaver_grace:     { label: "leaver",         cls: "bg-amber-100 text-amber-800" },
    leaver_expired:   { label: "leaver-expired", cls: "bg-red-100 text-red-800" },
    suspended:        { label: "suspended",      cls: "bg-ink/10 text-ink/70" },
    anonymised:       { label: "anonymised",     cls: "bg-ink/10 text-ink/70" },
    invited:          { label: "invited",        cls: "bg-sky-100 text-sky-800" },
    other:            { label: "other",          cls: "bg-ink/10 text-ink/70" },
  };
  const m = map[state.kind] ?? map.other;
  return <span className={`tag ${m.cls}`}>{m.label}</span>;
}

function StateDetail({
  state,
  notes,
}: {
  state: ReturnType<typeof getMemberLifecycleState>;
  notes: string | null;
}) {
  const lines: string[] = [];
  if (state.kind === "revoked_grace") {
    lines.push(
      `Revoked ${state.revokedAt.toISOString().slice(0, 10)} · ${state.daysLeft}d left to re-auth`,
    );
  } else if (state.kind === "revoked_expired") {
    lines.push(
      `Revoked ${state.revokedAt.toISOString().slice(0, 10)} · grace expired ${state.deadline
        .toISOString()
        .slice(0, 10)}`,
    );
  } else if (state.kind === "leaver_grace") {
    lines.push(
      `Marked ${state.markedAt.toISOString().slice(0, 10)} · anonymise ${state.deadline
        .toISOString()
        .slice(0, 10)} (${state.daysLeft}d)`,
    );
  } else if (state.kind === "leaver_expired") {
    lines.push(
      `Marked ${state.markedAt.toISOString().slice(0, 10)} · anonymise due ${state.deadline
        .toISOString()
        .slice(0, 10)}`,
    );
  } else if (state.kind === "anonymised") {
    lines.push(`Anonymised ${state.anonymisedAt.toISOString().slice(0, 10)}`);
  } else if (state.kind === "suspended") {
    lines.push(
      `Suspended${state.revokedAt ? ` (revoke from ${state.revokedAt.toISOString().slice(0, 10)})` : ""}`,
    );
  }
  if (notes) lines.push(`Note: ${notes}`);
  return (
    <div className="space-y-0.5">
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}

function MemberActions({
  membershipId,
  state,
  markLeaverAction,
  reverseLeaverAction,
  reauthoriseAction,
}: {
  membershipId: string;
  state: ReturnType<typeof getMemberLifecycleState>;
  markLeaverAction: (fd: FormData) => Promise<void>;
  reverseLeaverAction: (fd: FormData) => Promise<void>;
  reauthoriseAction: (fd: FormData) => Promise<void>;
}) {
  if (state.kind === "active") {
    return (
      <form action={markLeaverAction} className="space-y-1">
        <input type="hidden" name="membershipId" value={membershipId} />
        <input
          type="text"
          name="note"
          placeholder="Reason (optional)"
          maxLength={300}
          className="input text-xs"
        />
        <button type="submit" className="btn text-xs">
          Mark as leaver
        </button>
      </form>
    );
  }
  if (state.kind === "leaver_grace") {
    return (
      <form action={reverseLeaverAction} className="space-y-1">
        <input type="hidden" name="membershipId" value={membershipId} />
        <input
          type="text"
          name="reason"
          required
          placeholder="Reversal reason"
          maxLength={300}
          className="input text-xs"
        />
        <button type="submit" className="btn text-xs">
          Reverse leaver
        </button>
      </form>
    );
  }
  if (state.kind === "revoked_grace") {
    return (
      <form action={reauthoriseAction}>
        <input type="hidden" name="membershipId" value={membershipId} />
        <button type="submit" className="btn text-xs">
          Re-authorise
        </button>
      </form>
    );
  }
  return <span className="text-xs text-ink/40">—</span>;
}
