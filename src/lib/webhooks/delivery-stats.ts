/**
 * Webhook delivery aggregate statistics (post-PRD hardening).
 *
 * The per-delivery list on `/admin/webhooks/[id]` shows individual rows
 * but doesn't surface patterns. When a receiver returns 503 for 50% of
 * deliveries you have to scroll the list and eyeball it — easy to miss
 * for a busy subscription. This module computes per-subscription
 * histograms so the admin sees "of the last 200 deliveries, 152 were
 * 200, 47 were 503, 1 was a network error" at a glance.
 *
 * Cross-tenant safety: reads via `tenantDb(tenantId)` so RLS double-
 * binds even if a caller forgets the tenantId clause.
 *
 * Status code grouping: HTTP responses are bucketed into 2xx/3xx/4xx/5xx
 * + `network` (failed before any HTTP response) + `unknown` (anything
 * else). The raw `lastStatusCode` is also returned per delivery in the
 * top-N table so operators can pinpoint a specific failure code.
 */
import { tenantDb } from "@/lib/db";

export const DEFAULT_WINDOW_HOURS = 24;
export const MAX_WINDOW_HOURS = 24 * 90; // 90 days — bounded by reap cron
export const DEFAULT_TOP_CODES = 10;

export type DeliveryStatusBucket =
  | "PENDING"
  | "IN_FLIGHT"
  | "DELIVERED"
  | "DEAD_LETTERED";

export type ResponseCodeFamily = "2xx" | "3xx" | "4xx" | "5xx" | "network" | "unknown";

export type DeliveryStats = {
  windowHours: number;
  total: number;
  byStatus: Record<DeliveryStatusBucket, number>;
  byCodeFamily: Record<ResponseCodeFamily, number>;
  /**
   * Top-N exact HTTP codes by count. Includes a `network` entry for
   * deliveries that never reached an HTTP response (DNS failure, SSRF
   * block, timeout before response). Sorted by count desc.
   */
  topCodes: Array<{ code: number | "network"; count: number }>;
};

export function clampWindowHours(raw: number | undefined | null): number {
  if (raw == null) return DEFAULT_WINDOW_HOURS;
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_WINDOW_HOURS;
  if (raw > MAX_WINDOW_HOURS) return MAX_WINDOW_HOURS;
  return Math.floor(raw);
}

export function classifyCode(code: number | null | undefined): ResponseCodeFamily {
  if (code == null) return "network";
  if (!Number.isFinite(code)) return "unknown";
  if (code >= 200 && code < 300) return "2xx";
  if (code >= 300 && code < 400) return "3xx";
  if (code >= 400 && code < 500) return "4xx";
  if (code >= 500 && code < 600) return "5xx";
  return "unknown";
}

export type GetDeliveryStatsInput = {
  tenantId: string;
  subscriptionId: string;
  /** Window in hours. Defaults to 24, clamped to [1, MAX_WINDOW_HOURS]. */
  windowHours?: number;
  /** Top-N exact codes to return. Defaults to 10. */
  topN?: number;
  /** Clock injection for tests. */
  now?: Date;
};

export async function getDeliveryStats(
  input: GetDeliveryStatsInput,
): Promise<DeliveryStats> {
  const windowHours = clampWindowHours(input.windowHours);
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const topN = Math.max(1, Math.min(50, input.topN ?? DEFAULT_TOP_CODES));

  const db = tenantDb(input.tenantId);
  // Pull just the two fields we need — keeps the query cheap on a
  // hot subscription with thousands of recent deliveries.
  const rows = await db.webhookDelivery.findMany({
    where: {
      subscriptionId: input.subscriptionId,
      createdAt: { gte: since },
    },
    select: { status: true, lastStatusCode: true },
  });

  const byStatus: Record<DeliveryStatusBucket, number> = {
    PENDING: 0,
    IN_FLIGHT: 0,
    DELIVERED: 0,
    DEAD_LETTERED: 0,
  };
  const byCodeFamily: Record<ResponseCodeFamily, number> = {
    "2xx": 0,
    "3xx": 0,
    "4xx": 0,
    "5xx": 0,
    network: 0,
    unknown: 0,
  };
  const codeCounts = new Map<number | "network", number>();

  for (const r of rows) {
    if (r.status in byStatus) {
      byStatus[r.status as DeliveryStatusBucket] += 1;
    }
    const family = classifyCode(r.lastStatusCode);
    byCodeFamily[family] += 1;
    const key: number | "network" = r.lastStatusCode == null ? "network" : r.lastStatusCode;
    codeCounts.set(key, (codeCounts.get(key) ?? 0) + 1);
  }

  const topCodes = Array.from(codeCounts.entries())
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);

  return {
    windowHours,
    total: rows.length,
    byStatus,
    byCodeFamily,
    topCodes,
  };
}
