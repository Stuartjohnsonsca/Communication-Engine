import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { ALL_KINDS } from "@/lib/channels/registry";
import {
  getChannelHealthSnapshot,
  SILENCE_WARN_DAYS,
} from "@/lib/channels/health";
import { hasPermission } from "@/lib/rbac";
import ChannelsClient from "./ChannelsClient";

export default async function ChannelsPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  const channels = await superDb.channel.findMany({
    where: { tenantId: ctx.tenant.id },
    orderBy: { createdAt: "desc" },
    include: {
      auths: {
        where: { revokedAt: null },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
      _count: { select: { messages: true } },
    },
  });

  const kinds = ALL_KINDS.map((m) => ({
    kind: m.kind,
    label: m.label,
    tier: m.tier,
    prdRef: m.prdRef,
    realOAuth: m.realOAuthAvailable(),
  }));

  // Item 57 — per-channel ingest activity snapshot. ACTIVE channel +
  // active auth + grace-window passed + no inbound in the silence
  // window flags `silent`. Renders inline alongside each channel row.
  const health = await getChannelHealthSnapshot({
    tenantId: ctx.tenant.id,
    channels: channels.map((c) => ({ id: c.id, status: c.status })),
  });

  // Item 52 — recent auto-draft sweep runs for this tenant. Surfaces
  // the same counts the operator sees in the backfill confirmation
  // toast, plus the cron-driven runs they never explicitly trigger.
  const sweepRuns = await superDb.autoDraftSweepRun.findMany({
    where: { tenantId: ctx.tenant.id },
    orderBy: { startedAt: "desc" },
    take: 10,
    include: {
      triggeredBy: { include: { user: { select: { name: true, email: true } } } },
    },
  });

  // Item 62 — quarantined inbound (failed `QUARANTINE_THRESHOLD`
  // consecutive draft attempts). Capped at 50 rows; if a tenant
  // has more than 50, the operator should hit "Retry all" or
  // investigate a systemic issue. Surfaced to FIRM_ADMIN with a
  // retry button; FCT sees the list read-only.
  const quarantined = await superDb.ingestedMessage.findMany({
    where: {
      tenantId: ctx.tenant.id,
      quarantinedFromDraftAt: { not: null },
    },
    orderBy: { quarantinedFromDraftAt: "desc" },
    take: 50,
    select: {
      id: true,
      sender: true,
      subject: true,
      sentAt: true,
      createdAt: true,
      quarantinedFromDraftAt: true,
      quarantineReason: true,
      draftAttemptCount: true,
    },
  });

  return (
    <ChannelsClient
      tenantSlug={tenantSlug}
      silenceWarnDays={SILENCE_WARN_DAYS}
      canPauseAutoDraft={hasPermission(ctx.membership.role, "auto-draft:pause")}
      autoDraftPause={{
        pausedAt: ctx.tenant.autoDraftPausedAt?.toISOString() ?? null,
        pausedByName: ctx.tenant.autoDraftPausedByName ?? null,
        reason: ctx.tenant.autoDraftPauseReason ?? null,
      }}
      channels={channels.map((c) => {
        const h = health.get(c.id);
        return {
          id: c.id,
          kind: c.kind,
          status: c.status,
          dpiaApproved: c.dpiaApproved,
          createdAt: c.createdAt.toISOString(),
          scope: c.auths[0]?.scope ?? null,
          expiresAt: c.auths[0]?.expiresAt?.toISOString() ?? null,
          messageCount: c._count.messages,
          lastInboundAt: h?.lastInboundAt?.toISOString() ?? null,
          lastOutboundAt: h?.lastOutboundAt?.toISOString() ?? null,
          inboundCount7d: h?.inboundCount7d ?? 0,
          inboundCount30d: h?.inboundCount30d ?? 0,
          silent: h?.silent ?? false,
        };
      })}
      kinds={kinds}
      sweepRuns={sweepRuns.map((r) => ({
        id: r.id,
        source: r.source,
        startedAt: r.startedAt.toISOString(),
        windowHours: r.windowHours,
        maxPerTenant: r.maxPerTenant,
        candidates: r.candidates,
        produced: r.produced,
        skipped: r.skipped,
        errored: r.errored,
        skipReasons:
          r.skipReasons && typeof r.skipReasons === "object" && !Array.isArray(r.skipReasons)
            ? (r.skipReasons as Record<string, number>)
            : {},
        triggeredByName:
          r.triggeredBy?.user?.name ?? r.triggeredBy?.user?.email ?? null,
      }))}
      canUnquarantine={hasPermission(ctx.membership.role, "auto-draft:unquarantine")}
      quarantined={quarantined.map((q) => ({
        id: q.id,
        sender: q.sender,
        subject: q.subject,
        receivedAt: (q.sentAt ?? q.createdAt).toISOString(),
        quarantinedAt: q.quarantinedFromDraftAt!.toISOString(),
        attemptCount: q.draftAttemptCount,
        reason: q.quarantineReason,
      }))}
    />
  );
}
