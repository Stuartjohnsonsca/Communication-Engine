/**
 * Re-encrypt every encrypted blob in the database with the current active
 * key version. Backwards-compatible: rows already on the active version
 * are skipped, legacy unversioned rows are treated as "v1".
 *
 * Operational flow:
 *   1. Operator adds a new key to ENCRYPTION_KEYS:
 *        {"v1": "<old base64>", "v2": "<new base64>"}
 *      and sets ENCRYPTION_KEY_ACTIVE_VERSION=v2.
 *   2. Operator deploys. New writes already land on v2; old reads continue
 *      to decrypt against v1 because both keys are in the registry.
 *   3. Operator runs `npm run rotate-encryption-keys` (or this script
 *      directly). Each row whose blob is on a non-active version is
 *      decrypted with its original key and re-encrypted with the active
 *      key. Idempotent — re-running after completion is a no-op.
 *   4. After all rows are migrated AND every ApiKey row's keyVersion has
 *      been advanced (via re-issuance or operator-driven revocation),
 *      v1 can be dropped from ENCRYPTION_KEYS at the next deploy.
 *
 * Scope: `ChannelAuth.encryptedTokens`, `UserTotp.secretEncrypted`,
 * `WebhookSubscription.secretEncrypted`. `ApiKey.hash` is one-way and
 * NOT rotated — operators force re-issuance of stale-version keys
 * separately (the column still records `keyVersion` so verification
 * keeps working until a key is revoked).
 *
 * Writes a single `ENCRYPTION_KEYS_ROTATED` audit event on the Acumon
 * operator tenant chain with summary counts per table.
 */
import { Prisma } from "@prisma/client";
import { superDb } from "../src/lib/db";
import {
  classifyBlob,
  decryptJsonWith,
  encryptJsonWith,
  getRegistry,
} from "../src/lib/crypto/keys";
import { writeAuditEvent } from "../src/lib/audit";

const BATCH = 100;

type TableSummary = {
  scanned: number;
  rotated: number;
  skipped: number;
  failed: number;
};

function makeSummary(): TableSummary {
  return { scanned: 0, rotated: 0, skipped: 0, failed: 0 };
}

async function rotateChannelAuths(activeVersion: string): Promise<TableSummary> {
  const registry = getRegistry();
  const summary = makeSummary();
  let cursor: string | null = null;

  for (;;) {
    const rows: Array<{ id: string; encryptedTokens: string }> = await superDb.channelAuth.findMany(
      {
        where: cursor ? { id: { gt: cursor } } : undefined,
        select: { id: true, encryptedTokens: true },
        orderBy: { id: "asc" },
        take: BATCH,
      },
    );
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;

    for (const row of rows) {
      summary.scanned += 1;
      const { version } = classifyBlob(row.encryptedTokens);
      if (version === activeVersion) {
        summary.skipped += 1;
        continue;
      }
      try {
        const decoded = decryptJsonWith(registry, row.encryptedTokens);
        const re = encryptJsonWith(registry, decoded);
        await superDb.channelAuth.update({
          where: { id: row.id },
          data: { encryptedTokens: re },
        });
        summary.rotated += 1;
      } catch (err) {
        summary.failed += 1;
        console.error(`channelAuth ${row.id}: rotate failed:`, err);
      }
    }
  }
  return summary;
}

async function rotateUserTotps(activeVersion: string): Promise<TableSummary> {
  const registry = getRegistry();
  const summary = makeSummary();
  let cursor: string | null = null;

  for (;;) {
    const rows: Array<{ id: string; secretEncrypted: string }> = await superDb.userTotp.findMany({
      where: cursor ? { id: { gt: cursor } } : undefined,
      select: { id: true, secretEncrypted: true },
      orderBy: { id: "asc" },
      take: BATCH,
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;

    for (const row of rows) {
      summary.scanned += 1;
      const { version } = classifyBlob(row.secretEncrypted);
      if (version === activeVersion) {
        summary.skipped += 1;
        continue;
      }
      try {
        const decoded = decryptJsonWith(registry, row.secretEncrypted);
        const re = encryptJsonWith(registry, decoded);
        await superDb.userTotp.update({
          where: { id: row.id },
          data: { secretEncrypted: re },
        });
        summary.rotated += 1;
      } catch (err) {
        summary.failed += 1;
        console.error(`userTotp ${row.id}: rotate failed:`, err);
      }
    }
  }
  return summary;
}

async function rotateWebhookSubscriptions(activeVersion: string): Promise<TableSummary> {
  const registry = getRegistry();
  const summary = makeSummary();
  let cursor: string | null = null;

  for (;;) {
    const rows: Array<{ id: string; secretEncrypted: string }> =
      await superDb.webhookSubscription.findMany({
        where: cursor ? { id: { gt: cursor } } : undefined,
        select: { id: true, secretEncrypted: true },
        orderBy: { id: "asc" },
        take: BATCH,
      });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;

    for (const row of rows) {
      summary.scanned += 1;
      const { version } = classifyBlob(row.secretEncrypted);
      if (version === activeVersion) {
        summary.skipped += 1;
        continue;
      }
      try {
        const decoded = decryptJsonWith(registry, row.secretEncrypted);
        const re = encryptJsonWith(registry, decoded);
        await superDb.webhookSubscription.update({
          where: { id: row.id },
          data: { secretEncrypted: re },
        });
        summary.rotated += 1;
      } catch (err) {
        summary.failed += 1;
        console.error(`webhookSubscription ${row.id}: rotate failed:`, err);
      }
    }
  }
  return summary;
}

async function countApiKeysByVersion(): Promise<Record<string, number>> {
  // Reporting only — not rotated. Operators see how many keys are still on
  // legacy versions and plan re-issuance.
  const rows = await superDb.apiKey.groupBy({
    by: ["keyVersion"],
    _count: { _all: true },
    where: { revokedAt: null },
  });
  const out: Record<string, number> = {};
  for (const r of rows) {
    out[r.keyVersion] = r._count._all;
  }
  return out;
}

async function logRotationAudit(payload: Prisma.JsonObject): Promise<void> {
  const acumon = await superDb.tenant.findUnique({ where: { slug: "acumon" } });
  if (!acumon) {
    console.warn(
      "No 'acumon' operator tenant — skipping ENCRYPTION_KEYS_ROTATED audit. Run seed.ts first.",
    );
    return;
  }
  await writeAuditEvent({
    tenantId: acumon.id,
    eventType: "ENCRYPTION_KEYS_ROTATED",
    actorMembershipId: null,
    subjectType: "EncryptionKey",
    subjectId: payload.activeVersion as string,
    payload,
  });
}

export type RotationResult = {
  activeVersion: string;
  channelAuth: TableSummary;
  userTotp: TableSummary;
  webhookSubscription: TableSummary;
  apiKeysByVersion: Record<string, number>;
};

export async function runRotation(): Promise<RotationResult> {
  const registry = getRegistry();
  const activeVersion = registry.active;

  const [channelAuth, userTotp, webhookSubscription, apiKeysByVersion] = [
    await rotateChannelAuths(activeVersion),
    await rotateUserTotps(activeVersion),
    await rotateWebhookSubscriptions(activeVersion),
    await countApiKeysByVersion(),
  ];

  const totalRotated =
    channelAuth.rotated + userTotp.rotated + webhookSubscription.rotated;
  const totalFailed = channelAuth.failed + userTotp.failed + webhookSubscription.failed;

  // Only write an audit if we did something OR if there's a failure to
  // record. Idempotent re-runs with nothing to do are silent — operators
  // can shell-pipe summary output if they want a trail of every invocation.
  if (totalRotated > 0 || totalFailed > 0) {
    await logRotationAudit({
      activeVersion,
      channelAuth: channelAuth as unknown as Prisma.JsonObject,
      userTotp: userTotp as unknown as Prisma.JsonObject,
      webhookSubscription: webhookSubscription as unknown as Prisma.JsonObject,
      apiKeysByVersion: apiKeysByVersion as Prisma.JsonObject,
    });
  }

  return {
    activeVersion,
    channelAuth,
    userTotp,
    webhookSubscription,
    apiKeysByVersion,
  };
}

async function main() {
  const result = await runRotation();
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && process.argv[1].endsWith("rotate-encryption-keys.ts")) {
  main()
    .catch((err) => {
      console.error("rotate-encryption-keys failed:", err);
      process.exit(1);
    })
    .finally(() => superDb.$disconnect());
}
