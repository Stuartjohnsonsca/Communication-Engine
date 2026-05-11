import Link from "next/link";
import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { tenantDb } from "@/lib/db";
import {
  aggregateForMembership,
  digestHasContent,
  isMailerConfigured,
  listPreferences,
  isOptOutable,
} from "@/lib/notifications";
import { getT, resolveLocale } from "@/lib/i18n";
import NotificationActions from "./NotificationActions";

const KIND_LABEL: Record<string, string> = {
  weekly_digest: "Weekly digest",
  sentiment_escalation: "Sentiment escalation",
  adherence_escalation: "Adherence escalation",
  breach_ack_required: "Breach acknowledgement",
};

export default async function NotificationsPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  const [inbox, digest, prefs] = await Promise.all([
    tenantDb(ctx.tenant.id).notificationInbox.findMany({
      where: {
        tenantId: ctx.tenant.id,
        membershipId: ctx.membership.id,
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    aggregateForMembership({ tenant: ctx.tenant, membership: ctx.membership }),
    listPreferences(ctx.membership.id),
  ]);

  const unread = inbox.filter((r) => !r.readAt).length;
  const hasContent = digestHasContent(digest);
  const locale = resolveLocale({ membership: ctx.membership, tenant: ctx.tenant });
  const t = getT(locale);

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
        <span className="text-xs text-ink/60">
          {unread} unread / {inbox.length} total
        </span>
      </div>

      {!isMailerConfigured() && (
        <div className="rounded border border-amber-300 bg-amber-50/60 p-3 text-xs text-amber-900">
          <span className="font-medium">EMAIL_SERVER not configured.</span>{" "}
          Notifications are recorded in this inbox but no emails will be sent.
          Set <code>EMAIL_SERVER</code> + <code>EMAIL_FROM</code> in the
          deployment environment to enable email dispatch.
        </div>
      )}

      <div className="card space-y-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-medium">This week at a glance</h2>
          <span className="text-xs text-ink/50">
            {hasContent ? `${digest.totalOpen} item${digest.totalOpen === 1 ? "" : "s"}` : "all clear"}
          </span>
        </div>
        <ul className="space-y-1 text-sm">
          <DigestRow label="FCG proposals open for vote" count={digest.fcgProposals.open} sub={
            digest.fcgProposals.closingSoon
              ? `${digest.fcgProposals.closingSoon} closing within 48 hours`
              : undefined
          } href={`/${tenantSlug}/fcg`} />
          <DigestRow label="Open actions" count={digest.actions.open} sub={
            digest.actions.overdue ? `${digest.actions.overdue} overdue` : undefined
          } href={`/${tenantSlug}/actions`} />
          <DigestRow
            label="Sentiment escalations (you)"
            count={digest.sentimentEscalations.mine}
            sub={
              digest.sentimentEscalations.firmWideOpen
                ? `${digest.sentimentEscalations.firmWideOpen} firm-wide`
                : undefined
            }
            href={`/${tenantSlug}/sentiment`}
          />
          <DigestRow
            label="Adherence escalations (you)"
            count={digest.adherenceEscalations.mine}
            sub={
              digest.adherenceEscalations.firmWideOpen
                ? `${digest.adherenceEscalations.firmWideOpen} firm-wide`
                : undefined
            }
            href={`/${tenantSlug}/adherence/escalations`}
          />
          <DigestRow
            label="Breach acknowledgements pending"
            count={digest.breachAcks.pending}
            href={`/${tenantSlug}/compliance/breaches`}
          />
          <DigestRow
            label="DPIA expiry within 30 days"
            count={digest.expiries.dpiaWithin30Days ? 1 : 0}
            sub={
              digest.expiries.dpiaDaysUntil != null && digest.expiries.dpiaDaysUntil >= 0
                ? `${digest.expiries.dpiaDaysUntil} day${digest.expiries.dpiaDaysUntil === 1 ? "" : "s"} away`
                : undefined
            }
            href={`/${tenantSlug}/dpia`}
          />
          <DigestRow
            label="TIAs expiring within 30 days"
            count={digest.expiries.tiasExpiringSoon}
            href={`/${tenantSlug}/compliance/transfers`}
          />
          <DigestRow
            label="Terms records expiring within 30 days"
            count={digest.expiries.termsExpiringSoon}
            href={`/${tenantSlug}/admin/terms`}
          />
        </ul>
      </div>

      <div className="card">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-medium">Inbox</h2>
          {unread > 0 && (
            <NotificationActions tenantSlug={tenantSlug} kind="mark-all-read" />
          )}
        </div>
        {inbox.length === 0 ? (
          <p className="mt-3 text-sm text-ink/60">
            Nothing yet. Immediate notifications (sentiment, adherence, breach
            acknowledgements) and the weekly digest will land here.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-ink/5 text-sm">
            {inbox.map((r) => {
              const isUnread = !r.readAt;
              return (
                <li key={r.id} className="py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span
                        className={`tag ${
                          isUnread ? "bg-sky-100 text-sky-800" : "bg-ink/5"
                        }`}
                      >
                        {KIND_LABEL[r.kind] ?? r.kind}
                      </span>
                      <span className={`font-medium ${isUnread ? "" : "text-ink/70"}`}>
                        {r.title}
                      </span>
                    </div>
                    <span className="text-xs text-ink/50">
                      {r.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                    </span>
                  </div>
                  {r.summary && (
                    <p className="mt-1 text-xs text-ink/60">{r.summary}</p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink/60">
                    {r.href && (
                      <Link
                        href={r.href}
                        className="underline decoration-dotted"
                      >
                        Open →
                      </Link>
                    )}
                    {r.emailSentAt ? (
                      <span>email sent {r.emailSentAt.toISOString().slice(0, 16).replace("T", " ")}</span>
                    ) : isOptOutable(r.kind) && prefs[r.kind] === false ? (
                      <span className="text-ink/60">{t("notifications.mutedByPreference")}</span>
                    ) : (
                      <span className="text-amber-700">in-app only (no email)</span>
                    )}
                    {isUnread && (
                      <NotificationActions
                        tenantSlug={tenantSlug}
                        kind="mark-one-read"
                        id={r.id}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function DigestRow({
  label,
  count,
  sub,
  href,
}: {
  label: string;
  count: number;
  sub?: string;
  href: string;
}) {
  return (
    <li className="flex items-baseline justify-between gap-2">
      <span className={count ? "" : "text-ink/40"}>
        <Link href={href} className="hover:underline">
          {label}
        </Link>
      </span>
      <span className="flex items-baseline gap-2 text-xs text-ink/60">
        {sub && <span>{sub}</span>}
        <span className={`tag ${count ? "bg-ink text-white" : "bg-ink/5"}`}>
          {count}
        </span>
      </span>
    </li>
  );
}
