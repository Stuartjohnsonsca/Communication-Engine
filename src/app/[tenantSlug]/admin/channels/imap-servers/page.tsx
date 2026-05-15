import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { hasPermission, requirePermission } from "@/lib/rbac";
import { writeAuditEvent } from "@/lib/audit";

/**
 * Item 110 — FIRM_ADMIN configuration of generic IMAP server settings.
 *
 * Each Channel of kind = "IMAP" carries its server config in
 * `Channel.imapConfigJson` (host, port, security). Per-staff
 * credentials are entered separately on /account.
 *
 * This page lets the FIRM_ADMIN:
 *   1. Create a new IMAP Channel (kind=IMAP, with imapConfigJson set
 *      from the form).
 *   2. Update the imapConfigJson on existing IMAP Channels (host /
 *      port / security). Note: changing the server doesn't invalidate
 *      existing per-Member auths — staff credentials stay encrypted
 *      against the new server. If the host change is operationally
 *      destructive (different mail tenant) the FIRM_ADMIN should
 *      force-revoke per-Member auths on /admin/channels/members.
 *
 * Sibling to /admin/channels/oauth-apps. The /admin/channels page
 * itself stays focused on channel CRUD + ingest health; this page is
 * the IMAP-specific config surface so the parent doesn't bloat.
 */
export default async function ImapServersPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantSlug: string }>;
  searchParams?: Promise<{ saved?: string; created?: string; error?: string }>;
}) {
  const { tenantSlug } = await params;
  const sp = (await searchParams) ?? {};
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");
  if (!hasPermission(ctx.membership.role, "channels:write")) {
    redirect(`/${tenantSlug}/dashboard`);
  }

  const channels = await superDb.channel.findMany({
    where: { tenantId: ctx.tenant.id, kind: "IMAP" },
    orderBy: { createdAt: "asc" },
  });

  async function createImapChannelAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    requirePermission(inner.membership.role, "channels:write");
    const host = String(formData.get("imapHost") ?? "").trim();
    const portRaw = String(formData.get("imapPort") ?? "").trim();
    const security = String(formData.get("imapSecurity") ?? "TLS");
    const port = Number.parseInt(portRaw, 10);
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      redirect(
        `/${tenantSlug}/admin/channels/imap-servers?error=${encodeURIComponent(
          "host required + port must be 1..65535",
        )}`,
      );
    }
    if (!["TLS", "STARTTLS", "NONE"].includes(security)) {
      redirect(
        `/${tenantSlug}/admin/channels/imap-servers?error=${encodeURIComponent(
          "imapSecurity must be TLS / STARTTLS / NONE",
        )}`,
      );
    }
    const created = await superDb.channel.create({
      data: {
        tenantId: inner.tenant.id,
        kind: "IMAP",
        status: "ACTIVE",
        imapConfigJson: {
          imapHost: host,
          imapPort: port,
          imapSecurity: security as "TLS" | "STARTTLS" | "NONE",
        },
      },
    });
    await writeAuditEvent({
      tenantId: inner.tenant.id,
      eventType: "CHANNEL_AUTHORISED", // re-using; channel CRUD events are operational
      actorMembershipId: inner.membership.id,
      subjectType: "Channel",
      subjectId: created.id,
      payload: {
        kind: "IMAP",
        op: "imap-server-created",
        imapHost: host,
        imapPort: port,
        imapSecurity: security,
      },
    });
    revalidatePath(`/${tenantSlug}/admin/channels/imap-servers`);
    redirect(
      `/${tenantSlug}/admin/channels/imap-servers?created=${encodeURIComponent(host)}`,
    );
  }

  async function updateImapChannelAction(formData: FormData) {
    "use server";
    const inner = await getTenantContext(tenantSlug);
    if (!inner) throw new Error("forbidden");
    requirePermission(inner.membership.role, "channels:write");
    const channelId = String(formData.get("channelId") ?? "");
    const host = String(formData.get("imapHost") ?? "").trim();
    const portRaw = String(formData.get("imapPort") ?? "").trim();
    const security = String(formData.get("imapSecurity") ?? "TLS");
    const port = Number.parseInt(portRaw, 10);
    if (!channelId || !host || !Number.isInteger(port) || port <= 0) {
      redirect(
        `/${tenantSlug}/admin/channels/imap-servers?error=${encodeURIComponent(
          "host + port + channelId required",
        )}`,
      );
    }
    if (!["TLS", "STARTTLS", "NONE"].includes(security)) {
      redirect(
        `/${tenantSlug}/admin/channels/imap-servers?error=${encodeURIComponent(
          "imapSecurity must be TLS / STARTTLS / NONE",
        )}`,
      );
    }
    const channel = await superDb.channel.findUnique({
      where: { id: channelId },
    });
    if (!channel || channel.tenantId !== inner.tenant.id || channel.kind !== "IMAP") {
      redirect(
        `/${tenantSlug}/admin/channels/imap-servers?error=${encodeURIComponent(
          "channel not found",
        )}`,
      );
    }
    await superDb.channel.update({
      where: { id: channelId },
      data: {
        imapConfigJson: {
          imapHost: host,
          imapPort: port,
          imapSecurity: security as "TLS" | "STARTTLS" | "NONE",
        },
      },
    });
    await writeAuditEvent({
      tenantId: inner.tenant.id,
      eventType: "CHANNEL_AUTHORISED",
      actorMembershipId: inner.membership.id,
      subjectType: "Channel",
      subjectId: channelId,
      payload: {
        kind: "IMAP",
        op: "imap-server-updated",
        imapHost: host,
        imapPort: port,
        imapSecurity: security,
      },
    });
    revalidatePath(`/${tenantSlug}/admin/channels/imap-servers`);
    redirect(
      `/${tenantSlug}/admin/channels/imap-servers?saved=${encodeURIComponent(host)}`,
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">IMAP server configuration</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          IMAP channels let staff connect mailboxes on legacy / on-prem mail
          servers that don&rsquo;t support OAuth. You configure the server
          settings (host / port / security) here; each staff member then
          enters their personal username + password from /account.
          Re-entry every {`{tenant default}`} days; configurable on{" "}
          <a
            className="underline"
            href={`/${tenantSlug}/admin/sensitivity`}
          >
            /admin/sensitivity
          </a>
          .
        </p>
      </header>

      {sp.created && (
        <div className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300">
          Created IMAP channel for <code>{sp.created}</code>.
        </div>
      )}
      {sp.saved && (
        <div className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300">
          Saved <code>{sp.saved}</code>.
        </div>
      )}
      {sp.error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          {sp.error}
        </div>
      )}

      <section className="rounded border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="text-lg font-semibold">Existing IMAP channels</h2>
        {channels.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            No IMAP channels yet. Add one below.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {channels.map((c) => {
              const cfg = (c.imapConfigJson ?? {}) as {
                imapHost?: string;
                imapPort?: number;
                imapSecurity?: string;
              };
              return (
                <li
                  key={c.id}
                  className="rounded border border-zinc-100 p-3 dark:border-zinc-900"
                >
                  <form action={updateImapChannelAction} className="space-y-2">
                    <input type="hidden" name="channelId" value={c.id} />
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <label className="text-xs">
                        <span className="block text-zinc-600 dark:text-zinc-400">Host</span>
                        <input
                          type="text"
                          name="imapHost"
                          defaultValue={cfg.imapHost ?? ""}
                          required
                          className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                        />
                      </label>
                      <label className="text-xs">
                        <span className="block text-zinc-600 dark:text-zinc-400">Port</span>
                        <input
                          type="number"
                          name="imapPort"
                          min={1}
                          max={65535}
                          defaultValue={cfg.imapPort ?? 993}
                          required
                          className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                        />
                      </label>
                      <label className="text-xs">
                        <span className="block text-zinc-600 dark:text-zinc-400">Security</span>
                        <select
                          name="imapSecurity"
                          defaultValue={cfg.imapSecurity ?? "TLS"}
                          className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                        >
                          <option value="TLS">TLS (port 993)</option>
                          <option value="STARTTLS">STARTTLS (port 143)</option>
                          <option value="NONE">None (dev/lab only)</option>
                        </select>
                      </label>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-zinc-500">
                        Channel id: <code>{c.id}</code> · created{" "}
                        {c.createdAt.toISOString().slice(0, 10)}
                      </span>
                      <button
                        type="submit"
                        className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
                      >
                        Save
                      </button>
                    </div>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="text-lg font-semibold">Add a new IMAP channel</h2>
        <form action={createImapChannelAction} className="mt-3 space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="text-xs">
              <span className="block text-zinc-600 dark:text-zinc-400">Host</span>
              <input
                type="text"
                name="imapHost"
                placeholder="imap.firm.example.com"
                required
                className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <label className="text-xs">
              <span className="block text-zinc-600 dark:text-zinc-400">Port</span>
              <input
                type="number"
                name="imapPort"
                min={1}
                max={65535}
                defaultValue={993}
                required
                className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <label className="text-xs">
              <span className="block text-zinc-600 dark:text-zinc-400">Security</span>
              <select
                name="imapSecurity"
                defaultValue="TLS"
                className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="TLS">TLS (port 993)</option>
                <option value="STARTTLS">STARTTLS (port 143)</option>
                <option value="NONE">None (dev/lab only)</option>
              </select>
            </label>
          </div>
          <button
            type="submit"
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Add IMAP channel
          </button>
          <p className="text-xs text-zinc-500">
            Once created, share the /account URL with your staff so they can
            enter their personal mailbox credentials.
          </p>
        </form>
      </section>
    </div>
  );
}
