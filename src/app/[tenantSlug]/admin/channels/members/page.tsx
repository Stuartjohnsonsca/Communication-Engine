import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import { listActiveAuthsForChannel } from "@/lib/channels/auths";
import { meta as channelMeta } from "@/lib/channels/registry";
import { AdminRevokeButton } from "./AdminRevokeButton";

/**
 * Item 104 — admin-side per-Member auth roster.
 *
 * FIRM_ADMIN-only. Lists every ACTIVE per-Member ChannelAuth across
 * the tenant's Channels with a force-revoke button per row. Used for
 * terminated-staff cleanup, compromised-account containment, or
 * routine "who has access to what" review.
 *
 * The page is intentionally separate from /admin/channels (the
 * channel-management page) because the latter is already a complex
 * client component covering channel CRUD + ingest + pause/resume +
 * silent-detection. The per-Member roster is a narrower governance
 * surface that benefits from its own page.
 */
export default async function ChannelMembersPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "channels:write")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const channels = await superDb.channel.findMany({
    where: { tenantId: ctx.tenant.id },
    orderBy: { createdAt: "asc" },
  });

  const sections: Array<{
    channelId: string;
    channelKind: string;
    channelLabel: string;
    auths: Awaited<ReturnType<typeof listActiveAuthsForChannel>>;
  }> = [];
  for (const c of channels) {
    let label = c.kind;
    try {
      label = channelMeta(c.kind).label;
    } catch {
      /* unknown kind */
    }
    const auths = await listActiveAuthsForChannel({
      tenantId: ctx.tenant.id,
      channelId: c.id,
    });
    sections.push({
      channelId: c.id,
      channelKind: c.kind,
      channelLabel: label,
      auths,
    });
  }

  const totalActive = sections.reduce((acc, s) => acc + s.auths.length, 0);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Per-Member channel access</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Each row is one staff member&rsquo;s active OAuth connection on a tenant
          Channel. Revoke clears their tokens immediately &mdash; ingest from their
          mailbox stops on the next cron tick. They can re-connect themselves
          from /account at any time. Force-revoke is the right tool for
          terminated staff, compromised accounts, or audit cleanup; otherwise
          let staff manage their own connections.
        </p>
        <p className="mt-2 text-xs text-zinc-500">
          {totalActive} active connection{totalActive === 1 ? "" : "s"} across{" "}
          {sections.length} channel{sections.length === 1 ? "" : "s"}.
        </p>
      </header>

      {sections.length === 0 && (
        <div className="rounded border border-zinc-200 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          No channels configured. Add one on{" "}
          <a className="underline" href={`/${tenantSlug}/admin/channels`}>
            /admin/channels
          </a>{" "}
          first.
        </div>
      )}

      <div className="space-y-5">
        {sections.map((s) => (
          <section
            key={s.channelId}
            className="rounded border border-zinc-200 p-4 dark:border-zinc-800"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">{s.channelLabel}</h2>
              <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                {s.auths.length} member
                {s.auths.length === 1 ? "" : "s"} connected
              </span>
            </div>
            {s.auths.length === 0 ? (
              <p className="mt-2 text-xs text-zinc-500">
                No staff have connected this channel yet.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {s.auths.map((a) => (
                  <li
                    key={a.authId}
                    className="flex items-start justify-between gap-3 border-t border-zinc-200 pt-2 first:border-0 first:pt-0 dark:border-zinc-800"
                  >
                    <div className="text-sm">
                      <div className="font-medium">{a.memberName}</div>
                      <div className="text-xs text-zinc-600 dark:text-zinc-400">
                        {a.memberEmail ?? "(no email)"}
                      </div>
                      <div className="text-xs text-zinc-500">
                        Connected {a.connectedAt.toISOString().slice(0, 10)}
                        {a.expiresAt
                          ? ` · expires ${a.expiresAt.toISOString().slice(0, 10)}`
                          : ""}
                      </div>
                    </div>
                    <AdminRevokeButton
                      authId={a.authId}
                      channelId={s.channelId}
                      tenantSlug={tenantSlug}
                      memberName={a.memberName}
                      channelKind={s.channelLabel}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
