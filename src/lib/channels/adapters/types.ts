/**
 * Channel adapter contract. Each kind implements `ingest(channel, since)`
 * which returns a normalised batch of `IngestedMessage` rows. The framework
 * decrypts tokens and hands the adapter a verified `Tokens` blob; the
 * adapter is otherwise free in how it talks to the upstream system.
 */

export type Tokens = {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number; // unix seconds
  scope?: string;
  // Mock adapter stores synthetic tokens here.
  mock?: boolean;
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

export type AdapterContext = {
  tenantId: string;
  channelId: string;
  membershipId?: string | null;
  tokens: Tokens;
  scope?: string;
  /** Lower bound on `sentAt` — most adapters pass through to the upstream. */
  since?: Date;
};

export interface ChannelAdapter {
  /** Returns up to ~25 messages per call so the caller can page. */
  ingest(ctx: AdapterContext): Promise<IngestRow[]>;
}
