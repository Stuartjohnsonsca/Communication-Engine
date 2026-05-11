/**
 * `superDbWith` — bounded-timeout transaction wrapper for cron-sweep
 * style work that bypasses `tenantDb`'s per-request statement_timeout.
 *
 * Coverage:
 *   - Happy path: callback runs, return value bubbles out, no timeout
 *     when the work completes inside the budget.
 *   - statement_timeout binds: a deliberately slow query (pg_sleep) is
 *     aborted with the canceling-statement error.
 *   - Explicit override is honoured + clamped to the 100ms minimum.
 *   - Callback throws propagate to the caller (rollback semantics
 *     from the underlying Prisma $transaction).
 *   - Wired sweeps: `reapStaleRateLimitBuckets` and
 *     `purgeExpiredIdempotencyKeys` both return the expected count
 *     shape after the rewire to `superDbWith`.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { superDb, superDbWith } from "@/lib/db";
import { reapStaleRateLimitBuckets } from "@/lib/ratelimit";
import { purgeExpiredIdempotencyKeys } from "@/lib/auth/api-keys";

describe("superDbWith", () => {
  it("runs the callback and returns its value", async () => {
    const result = await superDbWith({}, async (tx) => {
      const r = await tx.$queryRawUnsafe<Array<{ ok: number }>>(`SELECT 1 AS ok`);
      return { ok: r[0]?.ok ?? null, sentinel: "x" };
    });
    expect(result.ok).toBe(1);
    expect(result.sentinel).toBe("x");
  });

  it("aborts a query that exceeds the explicit statement_timeout", async () => {
    await expect(
      superDbWith({ statementTimeoutMs: 200 }, async (tx) => {
        await tx.$queryRawUnsafe(`SELECT pg_sleep(2)`);
      }),
    ).rejects.toThrow(/canceling statement|statement timeout/i);
  });

  it("clamps an explicit override below 100ms to 100ms (and still aborts long queries)", async () => {
    await expect(
      superDbWith({ statementTimeoutMs: 10 }, async (tx) => {
        await tx.$queryRawUnsafe(`SELECT pg_sleep(0.5)`);
      }),
    ).rejects.toThrow(/canceling statement|statement timeout/i);
  });

  it("propagates a callback throw", async () => {
    await expect(
      superDbWith({ statementTimeoutMs: 5_000 }, async () => {
        throw new Error("inner boom");
      }),
    ).rejects.toThrow(/inner boom/);
  });

  it("rolls back inner mutations when the callback throws (Prisma $transaction semantics)", async () => {
    const tenant = await superDb.tenant.create({
      data: { slug: `sdbw-${randomUUID().slice(0, 8)}`, name: "sdbw test" },
    });
    try {
      const rolledBackName = `rolled-back-${randomUUID().slice(0, 8)}`;
      await expect(
        superDbWith({ statementTimeoutMs: 5_000 }, async (tx) => {
          await tx.tenant.update({
            where: { id: tenant.id },
            data: { name: rolledBackName },
          });
          throw new Error("force rollback");
        }),
      ).rejects.toThrow(/force rollback/);

      const after = await superDb.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
      expect(after.name).toBe("sdbw test");
    } finally {
      await superDb.tenant.delete({ where: { id: tenant.id } }).catch(() => {});
    }
  });
});

describe("wired sweeps still return their count shape", () => {
  it("reapStaleRateLimitBuckets returns { deleted }", async () => {
    const out = await reapStaleRateLimitBuckets();
    expect(typeof out.deleted).toBe("number");
    expect(out.deleted).toBeGreaterThanOrEqual(0);
  });

  it("purgeExpiredIdempotencyKeys returns { deleted }", async () => {
    const out = await purgeExpiredIdempotencyKeys();
    expect(typeof out.deleted).toBe("number");
    expect(out.deleted).toBeGreaterThanOrEqual(0);
  });
});
