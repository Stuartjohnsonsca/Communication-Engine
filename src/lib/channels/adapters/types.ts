/**
 * Channel adapter contract. Each kind implements `ingest(channel, since)`
 * which returns a normalised batch of `IngestedMessage` rows. The framework
 * decrypts tokens and hands the adapter a verified `Tokens` blob; the
 * adapter is otherwise free in how it talks to the upstream system.
 */

/**
 * Per-Member credentials passed to channel adapters.
 *
 * Two shapes coexist on a single widened type rather than a
 * discriminated union — to keep zero-churn back-compat with the 5
 * existing OAuth adapters (item 105's runtime mock fallback uses
 * `ctx.tokens.access_token` which stays valid as an optional field).
 *
 * - **OAuth shape** (default, absent `kind`): `access_token`,
 *   `refresh_token`, `expires_at`, `scope`, `mock`.
 * - **Password shape** (item 110, `kind: "password"`): `username`,
 *   `password`. The IMAP adapter checks `ctx.tokens.kind ===
 *   "password"` to discriminate; OAuth adapters never receive
 *   password creds because `adapterFor` routes IMAP channels to
 *   `imapAdapter` and OAuth channels to their kind-specific
 *   adapter — they're partitioned at routing time.
 */
export type Tokens = {
  // Item 110 — discriminator. Present + `"password"` → IMAP creds
  // path. Absent or `"oauth"` → OAuth path.
  kind?: "oauth" | "password";
  // OAuth shape (existing).
  access_token?: string;
  refresh_token?: string;
  expires_at?: number; // unix seconds
  scope?: string;
  // Mock adapter stores synthetic tokens here.
  mock?: boolean;
  // Password shape (item 110).
  username?: string;
  password?: string;
};

export type IngestRow = {
  externalId: string;
  threadId?: string;
  direction: "IN" | "OUT";
  sender?: string;
  recipients?: string[];
  subject?: string;
  body: string;
  sentAt?: Date;
};

/**
 * Item 110 — per-tenant IMAP server config, parsed from
 * `Channel.imapConfigJson`. Always present for `kind = "IMAP"` channels;
 * undefined for OAuth channels. Adapters that don't need it ignore it.
 */
export type ImapServerConfig = {
  imapHost: string;
  imapPort: number;
  imapSecurity: "TLS" | "STARTTLS" | "NONE";
};

export type AdapterContext = {
  tenantId: string;
  channelId: string;
  membershipId?: string | null;
  tokens: Tokens;
  scope?: string;
  /** Lower bound on `sentAt` — most adapters pass through to the upstream. */
  since?: Date;
  /** Item 110 — populated only for IMAP channels. */
  imapConfig?: ImapServerConfig;
};

export interface ChannelAdapter {
  /** Returns up to ~25 messages per call so the caller can page. */
  ingest(ctx: AdapterContext): Promise<IngestRow[]>;
}
