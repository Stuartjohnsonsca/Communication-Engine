import { superDb } from "@/lib/db";

/**
 * DSAR extraction (PRD §12.4).
 *
 * Two subject types:
 *   • USER         — a member of this tenant. We hold the canonical record:
 *                    UCG (rules, history, chat), drafts, actions,
 *                    adherence scores, sentiment-as-assignee, and audit-as-actor.
 *   • COUNTERPARTY — a third party whose data is in firm correspondence. We
 *                    don't hold a row for them; we extract any IngestedMessage
 *                    where the email appears as sender or recipient. Per PRD
 *                    these requests are *routed to the Client* — the platform
 *                    supplies the extraction tooling, the Client fulfils.
 *
 * Erasure note (PRD §14.4 + §12.5): the audit chain is immutable. Hash-chain
 * integrity overrides erasure for audit-event payloads, so the package
 * includes the audit trail but a separate flag warns the operator.
 */

export type DsarPackageMeta = {
  generatedAt: string;
  tenantId: string;
  tenantSlug: string;
  subjectType: "USER" | "COUNTERPARTY";
  subjectIdent: string;
  notes: string[];
};

export type UserDsarPackage = {
  meta: DsarPackageMeta;
  user: {
    id: string;
    email: string;
    name: string | null;
    createdAt: string;
  } | null;
  membership: {
    id: string;
    role: string;
    status: string;
    perfDashOptIn: boolean;
    sentimentOutOptIn: boolean;
    joinedAt: string;
    leftAt: string | null;
  } | null;
  ucgs: unknown[];
  drafts: unknown[];
  actions: unknown[];
  adherenceScores: unknown[];
  communicationAdherence: unknown[];
  sentimentAssigned: unknown[];
  sentimentAcknowledged: unknown[];
  channelAuths: unknown[];
  meetingsAsPaperAuthor: unknown[];
  meetingsAsCreator: unknown[];
  auditEventsAsActor: unknown[];
};

export type CounterpartyDsarPackage = {
  meta: DsarPackageMeta;
  ingestedMessages: unknown[];
  draftsReferencing: unknown[];
  sentimentSignals: unknown[];
};

export async function extractUserPackage(args: {
  tenantId: string;
  tenantSlug: string;
  email: string;
}): Promise<UserDsarPackage> {
  const email = args.email.trim().toLowerCase();
  const user = await superDb.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
  });
  // Membership(s) for this user in *this* tenant. PRD §3.2: never surface
  // another tenant's data here.
  const membership = user
    ? await superDb.membership.findFirst({
        where: { tenantId: args.tenantId, userId: user.id },
      })
    : null;

  const notes: string[] = [];
  if (!user) notes.push("No User row matched this email in the platform.");
  if (user && !membership) {
    notes.push(`User exists but holds no membership in this tenant — only audit-by-email lookups returned.`);
  }
  notes.push(
    "Audit events are immutable per the hash-chain integrity guarantee (PRD §6.2). They are included for completeness but cannot be erased, even on an ERASE request — refer this to your retention exception register.",
  );

  if (!user || !membership) {
    return {
      meta: makeMeta(args, "USER", email, notes),
      user: user
        ? {
            id: user.id,
            email: user.email,
            name: user.name,
            createdAt: user.createdAt.toISOString(),
          }
        : null,
      membership: null,
      ucgs: [],
      drafts: [],
      actions: [],
      adherenceScores: [],
      communicationAdherence: [],
      sentimentAssigned: [],
      sentimentAcknowledged: [],
      channelAuths: [],
      meetingsAsPaperAuthor: [],
      meetingsAsCreator: [],
      auditEventsAsActor: [],
    };
  }

  const tenantId = args.tenantId;
  const where = { tenantId, membershipId: membership.id };

  const [
    ucgs,
    drafts,
    actions,
    adherenceScores,
    communicationAdherence,
    sentimentAssigned,
    sentimentAcknowledged,
    channelAuths,
    meetingsAsPaperAuthor,
    meetingsAsCreator,
    auditEventsAsActor,
  ] = await Promise.all([
    superDb.userCultureGuide.findMany({
      where,
      include: { rules: true, rulings: true, chatTurns: true },
    }),
    superDb.draft.findMany({
      where,
      include: { actions: true, adherence: true, ingestedMessage: true },
    }),
    superDb.action.findMany({ where }),
    superDb.adherenceScore.findMany({ where }),
    superDb.communicationAdherence.findMany({ where }),
    superDb.sentimentSignal.findMany({
      where: { tenantId, assignedToMembershipId: membership.id },
    }),
    superDb.sentimentSignal.findMany({
      where: { tenantId, acknowledgedById: membership.id },
    }),
    superDb.channelAuth.findMany({ where: { tenantId, membershipId: membership.id } }),
    superDb.meeting.findMany({
      where: { tenantId, paperAuthorMembershipId: membership.id },
      include: { participants: true },
    }),
    superDb.meeting.findMany({
      where: { tenantId, createdByMembershipId: membership.id },
      include: { participants: true },
    }),
    superDb.auditEvent.findMany({
      where: { tenantId, actorMembershipId: membership.id },
      orderBy: { seq: "asc" },
    }),
  ]);

  return {
    meta: makeMeta(args, "USER", email, notes),
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt.toISOString(),
    },
    membership: {
      id: membership.id,
      role: membership.role,
      status: membership.status,
      perfDashOptIn: membership.perfDashOptIn,
      sentimentOutOptIn: membership.sentimentOutOptIn,
      joinedAt: membership.joinedAt.toISOString(),
      leftAt: membership.leftAt?.toISOString() ?? null,
    },
    ucgs: serialise(ucgs),
    drafts: serialise(drafts),
    actions: serialise(actions),
    adherenceScores: serialise(adherenceScores),
    communicationAdherence: serialise(communicationAdherence),
    sentimentAssigned: serialise(sentimentAssigned),
    sentimentAcknowledged: serialise(sentimentAcknowledged),
    channelAuths: serialise(channelAuths.map(stripTokens)),
    meetingsAsPaperAuthor: serialise(meetingsAsPaperAuthor),
    meetingsAsCreator: serialise(meetingsAsCreator),
    auditEventsAsActor: serialise(auditEventsAsActor),
  };
}

export async function extractCounterpartyPackage(args: {
  tenantId: string;
  tenantSlug: string;
  email: string;
}): Promise<CounterpartyDsarPackage> {
  const email = args.email.trim().toLowerCase();
  const tenantId = args.tenantId;

  // recipients is JSON; matching needs path query support. We do a coarse
  // string-search over `body` and direct match on `sender`, which matches
  // the platform's posture in v1: counterparty DSARs are routed to the
  // Client and the platform supplies extraction tooling — Clients run
  // additional verification against their primary mail store.
  const [bySender, byBody] = await Promise.all([
    superDb.ingestedMessage.findMany({
      where: { tenantId, sender: { equals: email, mode: "insensitive" } },
    }),
    superDb.ingestedMessage.findMany({
      where: { tenantId, body: { contains: email, mode: "insensitive" } },
      take: 500,
    }),
  ]);
  const dedup = new Map<string, (typeof bySender)[number]>();
  for (const m of [...bySender, ...byBody]) dedup.set(m.id, m);
  const ingestedMessages = Array.from(dedup.values());

  // Drafts whose snapshotted inbound carries this email
  const draftsReferencing = await superDb.draft.findMany({
    where: {
      tenantId,
      OR: [
        { inboundSender: { equals: email, mode: "insensitive" } },
        { inboundBody: { contains: email, mode: "insensitive" } },
      ],
    },
    take: 500,
  });

  const ingestedIds = ingestedMessages.map((m) => m.id);
  const sentimentSignals = ingestedIds.length
    ? await superDb.sentimentSignal.findMany({
        where: { tenantId, ingestedMessageId: { in: ingestedIds } },
      })
    : [];

  const notes: string[] = [
    "Counterparty DSARs are routed to the Client per PRD §12.4. This package is extraction tooling output — verify against the firm's primary mail store before fulfilling.",
    "Body-text matching is coarse and may include false positives where the email appears inside a quoted history. Review before release.",
  ];

  return {
    meta: makeMeta(args, "COUNTERPARTY", email, notes),
    ingestedMessages: serialise(ingestedMessages),
    draftsReferencing: serialise(draftsReferencing),
    sentimentSignals: serialise(sentimentSignals),
  };
}

function makeMeta(
  args: { tenantId: string; tenantSlug: string },
  subjectType: "USER" | "COUNTERPARTY",
  email: string,
  notes: string[],
): DsarPackageMeta {
  return {
    generatedAt: new Date().toISOString(),
    tenantId: args.tenantId,
    tenantSlug: args.tenantSlug,
    subjectType,
    subjectIdent: email,
    notes,
  };
}

/**
 * Strip OAuth tokens from a ChannelAuth row before export. The encrypted
 * tokens are never the data subject's data — they're firm credentials —
 * but they leak through to JSON if we serialise blindly.
 */
function stripTokens<T extends { encryptedTokens: string }>(row: T): Omit<T, "encryptedTokens"> & {
  encryptedTokens: "<redacted>";
} {
  return { ...row, encryptedTokens: "<redacted>" as const };
}

/** JSON-safe serialisation: BigInt → string, Date → ISO. */
function serialise<T>(rows: T[]): unknown[] {
  return JSON.parse(JSON.stringify(rows, replacer)) as unknown[];
}
function replacer(_key: string, value: unknown) {
  if (typeof value === "bigint") return value.toString();
  return value;
}
