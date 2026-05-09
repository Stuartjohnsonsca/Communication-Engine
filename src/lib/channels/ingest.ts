import { createHash } from "node:crypto";
import { superDb } from "@/lib/db";
import { adapterFor, type Tokens } from "./adapters";
import { decryptJson } from "./crypto";
import { writeAuditEvent } from "@/lib/audit";

/**
 * Run an adapter ingest and persist rows as `IngestedMessage`. Returns
 * counts so the admin UI can confirm work happened.
 *
 * Idempotency: each (channelId, externalId) is unique by `hash` —
 * re-running the ingest doesn't duplicate rows. Adapter rows lacking an
 * externalId are deduped on a content-hash fallback.
 */
export async function runIngest(channelId: string): Promise<{
  fetched: number;
  inserted: number;
  skipped: number;
}> {
  const channel = await superDb.channel.findUnique({ where: { id: channelId } });
  if (!channel) throw new Error("channel not found");

  const auths = await superDb.channelAuth.findMany({
    where: { channelId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  const auth = auths[0];

  let tokens: Tokens = {};
  if (auth) {
    try {
      tokens = decryptJson<Tokens>(auth.encryptedTokens);
    } catch {
      tokens = {};
    }
  }

  const adapter = adapterFor(channel.kind);
  const rows = await adapter.ingest({
    tenantId: channel.tenantId,
    channelId,
    membershipId: auth?.membershipId ?? null,
    tokens,
    scope: auth?.scope ?? undefined,
  });

  let inserted = 0;
  let skipped = 0;
  for (const r of rows) {
    const hash = sha256(`${channelId}|${r.externalId ?? ""}|${r.body}`);
    const existing = await superDb.ingestedMessage.findFirst({
      where: { tenantId: channel.tenantId, channelId, hash },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      continue;
    }
    await superDb.ingestedMessage.create({
      data: {
        tenantId: channel.tenantId,
        channelId,
        externalId: r.externalId,
        threadId: r.threadId,
        direction: r.direction,
        sender: r.sender,
        recipients: r.recipients,
        subject: r.subject,
        body: r.body,
        sentAt: r.sentAt,
        hash,
      },
    });
    inserted++;
  }

  await writeAuditEvent({
    tenantId: channel.tenantId,
    eventType: "CHANNEL_AUTHORISED", // re-using; channel ingest events are operational not auth events
    actorMembershipId: auth?.membershipId ?? null,
    subjectType: "Channel",
    subjectId: channelId,
    payload: { kind: channel.kind, fetched: rows.length, inserted, skipped, op: "ingest" },
  });

  return { fetched: rows.length, inserted, skipped };
}

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}
