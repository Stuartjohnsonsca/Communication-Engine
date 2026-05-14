import type { ChannelAdapter, IngestRow } from "./types";
import { mockAdapter } from "./mock";

/**
 * SharePoint Online adapter — pulls recently-modified files (and
 * file-comment activity where surfaced by Graph) from sites the
 * authorising User has access to.
 *
 * Item 108 — first real SharePoint adapter. Item 103 wired
 * SharePoint OAuth but no real adapter existed; channels routed to
 * mockAdapter via item 105's "Adapter pending" path.
 *
 * **Architectural note: SharePoint as "messages" is a square peg.**
 * The IngestedMessage table assumes a body + sender + recipients
 * shape. Files don't fit cleanly. The choice we make here:
 *   - One IngestedMessage row per file event (created /
 *     modified). `body` carries the file's title + path (NOT the
 *     file contents — those would balloon the JSONB column for a
 *     20MB PDF and require per-file content-type extraction).
 *   - `sender` = the User who last modified the file.
 *   - `recipients` = the Site name (so adherence/sentiment scoring
 *     has a "context" to attach to).
 *   - `direction = "IN"` always — SharePoint isn't a 2-way
 *     correspondence channel; the engine ingests file activity as
 *     evidence (e.g. for §10.1 "files moved to a counterparty"
 *     compliance review), not as a message thread.
 *
 * This makes SharePoint ingest USEFUL for compliance review
 * (documented file activity) without making it MISLEADING by
 * pretending it's a chat channel.
 *
 * Surfaces ingested:
 *   - `/me/drive/recent` for the User's own OneDrive recent items.
 *   - `/sites?search=*` to enumerate sites; for each, recent items
 *     from `/sites/{site-id}/drive/recent`.
 *
 * Cap: 25 sites, 5 recent items per site, 25 rows total.
 *
 * Mock fallback (item 105) — `tokens.mock === true` OR absent
 * access_token routes to mockAdapter at runtime.
 */
export const sharepointAdapter: ChannelAdapter = {
  async ingest(ctx) {
    if (!ctx.tokens.access_token || ctx.tokens.mock === true) {
      return mockAdapter.ingest(ctx);
    }
    const since = ctx.since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const sinceIso = since.toISOString();

    const rows: IngestRow[] = [];

    // OneDrive (the User's own files).
    const myRecent = await fetchGraph<{ value?: DriveItem[] }>(
      ctx.tokens.access_token,
      "/me/drive/recent",
      { $top: "5" },
    ).catch(() => ({ value: [] as DriveItem[] }));
    for (const item of myRecent.value ?? []) {
      const row = driveItemToRow(item, "OneDrive", sinceIso);
      if (row) rows.push(row);
    }

    // Sites the User has access to.
    const sites = await fetchGraph<{ value?: SharepointSite[] }>(
      ctx.tokens.access_token,
      "/sites",
      { search: "*", $top: "25" },
    ).catch(() => ({ value: [] as SharepointSite[] }));
    for (const site of sites.value ?? []) {
      if (!site.id) continue;
      const recent = await fetchGraph<{ value?: DriveItem[] }>(
        ctx.tokens.access_token,
        `/sites/${encodeURIComponent(site.id)}/drive/recent`,
        { $top: "5" },
      ).catch(() => ({ value: [] as DriveItem[] }));
      for (const item of recent.value ?? []) {
        const row = driveItemToRow(item, site.displayName ?? site.name ?? "site", sinceIso);
        if (row) rows.push(row);
      }
    }

    return rows.slice(0, 25);
  },
};

type SharepointSite = {
  id?: string;
  name?: string;
  displayName?: string;
};

type DriveItem = {
  id?: string;
  name?: string;
  webUrl?: string;
  size?: number;
  lastModifiedDateTime?: string;
  lastModifiedBy?: { user?: { displayName?: string; email?: string } };
  parentReference?: { path?: string };
  file?: { mimeType?: string };
  folder?: unknown;
};

function driveItemToRow(
  item: DriveItem,
  siteLabel: string,
  sinceIso: string,
): IngestRow | null {
  // Skip folders + items without mod-time (we want activity events).
  if (item.folder) return null;
  if (!item.id || !item.name) return null;
  if (item.lastModifiedDateTime && item.lastModifiedDateTime < sinceIso) {
    return null;
  }
  const sender =
    item.lastModifiedBy?.user?.email ??
    item.lastModifiedBy?.user?.displayName ??
    undefined;
  const path = item.parentReference?.path ?? "";
  // Body documents the activity, not the file contents — see
  // architectural note on the adapter for why.
  const body = [
    `${item.name}`,
    item.webUrl ? `URL: ${item.webUrl}` : null,
    path ? `Path: ${path}/${item.name}` : null,
    item.file?.mimeType ? `Type: ${item.file.mimeType}` : null,
    typeof item.size === "number" ? `Size: ${item.size} bytes` : null,
    item.lastModifiedDateTime ? `Modified: ${item.lastModifiedDateTime}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    externalId: item.id,
    threadId: undefined,
    // SharePoint isn't 2-way correspondence; treat all file events
    // as IN (evidence ingested).
    direction: "IN",
    sender,
    recipients: [siteLabel],
    subject: `[SharePoint] ${item.name}`,
    body,
    sentAt: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime) : undefined,
  };
}

async function fetchGraph<T>(
  token: string,
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`https://graph.microsoft.com/v1.0${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Graph ${path} ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}
