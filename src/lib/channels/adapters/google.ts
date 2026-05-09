import type { ChannelAdapter, IngestRow } from "./types";
import { mockAdapter } from "./mock";

/**
 * Google Workspace adapter — pulls recent Gmail messages via the Gmail API.
 *
 * Falls through to the mock adapter when no tokens are present. Like the
 * M365 adapter this is intentionally minimal in real mode: list IDs in the
 * INBOX and SENT labels, hydrate each, normalise into IngestRow.
 */
export const googleAdapter: ChannelAdapter = {
  async ingest(ctx) {
    if (!ctx.tokens.access_token) {
      return mockAdapter.ingest(ctx);
    }
    const ids = await listIds(ctx.tokens.access_token, ["INBOX"], 15);
    const sentIds = await listIds(ctx.tokens.access_token, ["SENT"], 15);

    const rows: IngestRow[] = [];
    for (const id of ids) rows.push(await hydrate(ctx.tokens.access_token, id, "IN"));
    for (const id of sentIds) rows.push(await hydrate(ctx.tokens.access_token, id, "OUT"));
    return rows.slice(0, 25);
  },
};

async function listIds(token: string, labelIds: string[], max: number): Promise<string[]> {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("maxResults", String(max));
  for (const l of labelIds) url.searchParams.append("labelIds", l);
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Gmail list ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { messages?: { id: string }[] };
  return (data.messages ?? []).map((m) => m.id);
}

async function hydrate(token: string, id: string, direction: "IN" | "OUT"): Promise<IngestRow> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Gmail get ${id}: ${res.status}`);
  const data = (await res.json()) as {
    threadId?: string;
    snippet?: string;
    internalDate?: string;
    payload?: { headers?: { name: string; value: string }[] };
  };
  const headers = Object.fromEntries((data.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
  return {
    externalId: id,
    threadId: data.threadId,
    direction,
    sender: headers["from"],
    recipients: (headers["to"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    subject: headers["subject"],
    body: data.snippet ?? "",
    sentAt: data.internalDate ? new Date(Number(data.internalDate)) : undefined,
  };
}
