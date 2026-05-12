import { superDb } from "@/lib/db";

/**
 * Post-PRD hardening item 57 — per-channel ingest activity snapshot.
 *
 * Closes the **silent-ingest-failure** visibility gap: a Channel can
 * remain `status="ACTIVE"` with a non-revoked ChannelAuth while still
 * receiving zero new inbound — e.g. the OAuth scope was downgraded
 * outside the platform, the provider rate-limited the polling adapter,
 * or the mailbox got reorganised so the polled folder is now empty.
 * Item 53 covers the *token expiring* failure mode; this covers the
 * *token still works but nothing arrives* mode.
 *
 * Per channel we surface:
 *   - last inbound + last outbound timestamps
 *   - 7d / 30d inbound counts
 *   - whether there's an active (non-revoked, not-yet-expired) auth
 *   - a `silent` flag = ACTIVE + has-active-auth + auth has been live
 *     for >= SILENCE_GRACE_DAYS + no IN message in the last
 *     SILENCE_WARN_DAYS days
 *
 * The grace window stops freshly-connected channels from showing as
 * silent before they've had a chance to receive their first message.
 * Both thresholds are intentionally per-platform constants — making
 * them tenant-configurable is a future item (the same pattern as
 * session-timeout, where the platform default is the floor and tenants
 * can tighten).
 *
 * Read-only. No new schema, no migration, no notification kind. A
 * downstream cron that warns on silence is a separate follow-up; the
 * surface here is "operator opens /admin/channels and can see at a
 * glance which channels are healthy."
 */

export const SILENCE_GRACE_DAYS = 2;
export const SILENCE_WARN_DAYS = 7;

export type ChannelHealth = {
  channelId: string;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  inboundCount7d: number;
  inboundCount30d: number;
  hasActiveAuth: boolean;
  /// Earliest createdAt across the channel's non-revoked auths. We use
  /// "any non-revoked auth has been alive >= grace days" as the
  /// gate — a re-connect after a revoke gets a fresh grace window.
  oldestActiveAuthAt: Date | null;
  /// True iff: ACTIVE channel + active auth + past grace + no IN in
  /// the silence window. The UI uses this to badge a row red.
  silent: boolean;
};

type ChannelInput = {
  id: string;
  status: string;
};

export async function getChannelHealthSnapshot(input: {
  tenantId: string;
  channels: ChannelInput[];
}): Promise<Map<string, ChannelHealth>> {
  const now = Date.now();
  const since7 = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const since30 = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const result = new Map<string, ChannelHealth>();

  if (input.channels.length === 0) return result;

  const channelIds = input.channels.map((c) => c.id);

  // One pull per dimension. Each is bounded by tenant + channel set so
  // they can't blow up; 3 round trips beats a complex aggregation
  // query and stays in Prisma-native syntax.
  const [lastIns, lastOuts, count7s, count30s, auths] = await Promise.all([
    superDb.ingestedMessage.groupBy({
      by: ["channelId"],
      where: {
        tenantId: input.tenantId,
        channelId: { in: channelIds },
        direction: "IN",
      },
      _max: { createdAt: true },
    }),
    superDb.ingestedMessage.groupBy({
      by: ["channelId"],
      where: {
        tenantId: input.tenantId,
        channelId: { in: channelIds },
        direction: "OUT",
      },
      _max: { createdAt: true },
    }),
    superDb.ingestedMessage.groupBy({
      by: ["channelId"],
      where: {
        tenantId: input.tenantId,
        channelId: { in: channelIds },
        direction: "IN",
        createdAt: { gte: since7 },
      },
      _count: { _all: true },
    }),
    superDb.ingestedMessage.groupBy({
      by: ["channelId"],
      where: {
        tenantId: input.tenantId,
        channelId: { in: channelIds },
        direction: "IN",
        createdAt: { gte: since30 },
      },
      _count: { _all: true },
    }),
    superDb.channelAuth.findMany({
      where: {
        tenantId: input.tenantId,
        channelId: { in: channelIds },
        revokedAt: null,
      },
      select: { channelId: true, createdAt: true, expiresAt: true },
    }),
  ]);

  const lastInByChannel = new Map<string, Date>();
  for (const r of lastIns) {
    if (r.channelId && r._max.createdAt)
      lastInByChannel.set(r.channelId, r._max.createdAt);
  }
  const lastOutByChannel = new Map<string, Date>();
  for (const r of lastOuts) {
    if (r.channelId && r._max.createdAt)
      lastOutByChannel.set(r.channelId, r._max.createdAt);
  }
  const c7 = new Map<string, number>();
  for (const r of count7s) {
    if (r.channelId) c7.set(r.channelId, r._count._all);
  }
  const c30 = new Map<string, number>();
  for (const r of count30s) {
    if (r.channelId) c30.set(r.channelId, r._count._all);
  }
  // Per channel: earliest createdAt of non-expired non-revoked auths.
  // Expired auths are NOT "active" — they cannot drive ingestion even
  // though they aren't revoked.
  const oldestActiveAuthByChannel = new Map<string, Date>();
  const hasActiveAuth = new Set<string>();
  for (const a of auths) {
    const stillValid = !a.expiresAt || a.expiresAt.getTime() > now;
    if (!stillValid) continue;
    hasActiveAuth.add(a.channelId);
    const prev = oldestActiveAuthByChannel.get(a.channelId);
    if (!prev || a.createdAt.getTime() < prev.getTime()) {
      oldestActiveAuthByChannel.set(a.channelId, a.createdAt);
    }
  }

  const graceMs = SILENCE_GRACE_DAYS * 24 * 60 * 60 * 1000;
  const warnMs = SILENCE_WARN_DAYS * 24 * 60 * 60 * 1000;

  for (const ch of input.channels) {
    const lastIn = lastInByChannel.get(ch.id) ?? null;
    const oldestAuth = oldestActiveAuthByChannel.get(ch.id) ?? null;
    const active = ch.status === "ACTIVE" && hasActiveAuth.has(ch.id);
    const pastGrace =
      oldestAuth !== null && now - oldestAuth.getTime() >= graceMs;
    const silentByLastIn =
      lastIn === null
        ? // No IN ever — silent only once past the grace window. A
          // freshly connected channel that's had zero inbound for
          // 36 hours is fine; the same channel at day 8 is suspect.
          pastGrace
        : now - lastIn.getTime() >= warnMs;
    const silent = active && pastGrace && silentByLastIn;

    result.set(ch.id, {
      channelId: ch.id,
      lastInboundAt: lastIn,
      lastOutboundAt: lastOutByChannel.get(ch.id) ?? null,
      inboundCount7d: c7.get(ch.id) ?? 0,
      inboundCount30d: c30.get(ch.id) ?? 0,
      hasActiveAuth: hasActiveAuth.has(ch.id),
      oldestActiveAuthAt: oldestAuth,
      silent,
    });
  }

  return result;
}
