-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Jurisdiction" AS ENUM ('UK', 'EU_IE', 'EU_DE', 'EU_FR');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('PROVISIONING', 'ACTIVE', 'SANDBOX', 'SUSPENDED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('FIRM_ADMIN', 'FCT_MEMBER', 'USER', 'SALES_REVIEWER', 'CURATOR', 'ACUMON_ADMIN');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'LEAVER_FROZEN', 'ANONYMISED');

-- CreateEnum
CREATE TYPE "FCGStatus" AS ENUM ('DRAFT', 'PROPOSED', 'COMMITTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "FCGCategory" AS ENUM ('TONE', 'RESPONSE_TIME', 'SALUTATION', 'SIGNOFF', 'SIGNATURE', 'MANDATORY_PHRASE', 'PROHIBITED_PHRASE', 'ESCALATION', 'REGULATORY', 'LANGUAGE');

-- CreateEnum
CREATE TYPE "CommChannel" AS ENUM ('EMAIL', 'SLACK', 'TEAMS', 'LETTER', 'REPORT', 'WHATSAPP_BUSINESS', 'ANY');

-- CreateEnum
CREATE TYPE "ProposalState" AS ENUM ('DRAFTING', 'OPEN_FOR_VOTE', 'PASSED', 'FAILED', 'EXPIRED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "VoteDecision" AS ENUM ('APPROVE', 'REJECT', 'ABSTAIN');

-- CreateEnum
CREATE TYPE "UCGStatus" AS ENUM ('DRAFT', 'JUDGED_PASS', 'JUDGED_FAIL', 'COMMITTED', 'SUPERSEDED', 'FROZEN');

-- CreateEnum
CREATE TYPE "Verdict" AS ENUM ('PASS', 'FAIL', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "DraftKind" AS ENUM ('EMAIL', 'HOLDING', 'TECHNICAL', 'ACTION_ONLY');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('PROPOSED', 'EDITED', 'ACCEPTED', 'DISCARDED', 'SENT');

-- CreateEnum
CREATE TYPE "AuditEventType" AS ENUM ('TENANT_PROVISIONED', 'USER_INVITED', 'USER_JOINED', 'USER_LEFT', 'MEMBERSHIP_CHANGED', 'CHANNEL_AUTHORISED', 'CHANNEL_REVOKED', 'FCG_DRAFT_CREATED', 'FCG_PROPOSED', 'FCG_VOTE_CAST', 'FCG_COMMITTED', 'FCG_PROPOSAL_FAILED', 'FCG_PROPOSAL_EXPIRED', 'UCG_DRAFTED', 'UCG_JUDGED', 'UCG_COMMITTED', 'UCG_AMENDED', 'COMPLIANCE_RULING', 'COMPLIANCE_OVERRIDE', 'DRAFT_PRODUCED', 'DRAFT_SENT_MARKED', 'DPIA_ATTESTED', 'DSAR_OPENED', 'DSAR_FULFILLED', 'AUDIT_EXPORTED');

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "jurisdiction" "Jurisdiction" NOT NULL DEFAULT 'UK',
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "isSandbox" BOOLEAN NOT NULL DEFAULT false,
    "parentTenantId" TEXT,
    "retentionDays" INTEGER NOT NULL DEFAULT 2555,
    "quorumPct" INTEGER NOT NULL DEFAULT 50,
    "votingWindowDays" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "image" TEXT,
    "emailVerified" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "perfDashOptIn" BOOLEAN NOT NULL DEFAULT false,
    "sentimentOutOptIn" BOOLEAN NOT NULL DEFAULT false,
    "alternateForId" TEXT,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FirmCultureGuide" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "FCGStatus" NOT NULL DEFAULT 'DRAFT',
    "language" TEXT NOT NULL DEFAULT 'en-GB',
    "effectiveAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "parentId" TEXT,
    "committedById" TEXT,
    "signatureBlock" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FirmCultureGuide_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FCGRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fcgId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "category" "FCGCategory" NOT NULL,
    "channel" "CommChannel" NOT NULL DEFAULT 'ANY',
    "statement" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "rationale" TEXT,
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "evidenceRefs" JSONB,
    "channelOverrides" JSONB,

    CONSTRAINT "FCGRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FCGProposal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "parentFcgId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "diff" JSONB NOT NULL,
    "proposedById" TEXT NOT NULL,
    "isEmergency" BOOLEAN NOT NULL DEFAULT false,
    "state" "ProposalState" NOT NULL DEFAULT 'DRAFTING',
    "votingOpenedAt" TIMESTAMP(3),
    "votingClosesAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "newFcgId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FCGProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FCGChatTurn" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "membershipId" TEXT,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "toolCalls" JSONB,
    "modelRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FCGChatTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FCGVote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "castByMembershipId" TEXT,
    "decision" "VoteDecision" NOT NULL,
    "comment" TEXT,
    "castAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FCGVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserCultureGuide" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "UCGStatus" NOT NULL DEFAULT 'DRAFT',
    "basedOnFcgId" TEXT NOT NULL,
    "parentId" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en-GB',
    "signatureBlock" JSONB,
    "judgeStatus" TEXT,
    "committedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserCultureGuide_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UCGRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ucgId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "category" "FCGCategory" NOT NULL,
    "channel" "CommChannel" NOT NULL DEFAULT 'ANY',
    "statement" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "narrowsFcgRule" TEXT,
    "evidenceRefs" JSONB,
    "channelOverrides" JSONB,

    CONSTRAINT "UCGRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UCGChatTurn" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ucgId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "toolCalls" JSONB,
    "modelRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UCGChatTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceRuling" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ucgId" TEXT NOT NULL,
    "ucgRuleId" TEXT,
    "fcgRuleId" TEXT,
    "verdict" "Verdict" NOT NULL,
    "severity" TEXT,
    "explanation" TEXT NOT NULL,
    "suggestedFix" TEXT,
    "judgeModel" TEXT NOT NULL,
    "judgeRunId" TEXT,
    "appealedById" TEXT,
    "overrideById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceRuling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Draft" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "ingestedMessageId" TEXT,
    "kind" "DraftKind" NOT NULL DEFAULT 'EMAIL',
    "status" "DraftStatus" NOT NULL DEFAULT 'PROPOSED',
    "channel" "CommChannel" NOT NULL DEFAULT 'EMAIL',
    "language" TEXT NOT NULL DEFAULT 'en-GB',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "citations" JSONB,
    "holdingRequired" BOOLEAN NOT NULL DEFAULT false,
    "holdingReason" TEXT,
    "fcgWindowDeadline" TIMESTAMP(3),
    "noGoSubjectHit" BOOLEAN NOT NULL DEFAULT false,
    "researchTaskRequired" BOOLEAN NOT NULL DEFAULT false,
    "modelRunId" TEXT,
    "fcgVersionUsed" INTEGER,
    "ucgVersionUsed" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentMarkedAt" TIMESTAMP(3),

    CONSTRAINT "Draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Action" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "draftId" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "type" TEXT NOT NULL DEFAULT 'task',
    "dueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "externalSystem" TEXT,
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "eventType" "AuditEventType" NOT NULL,
    "actorMembershipId" TEXT,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "scope" JSONB,
    "status" TEXT NOT NULL DEFAULT 'INACTIVE',
    "dpiaApproved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelAuth" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "membershipId" TEXT,
    "encryptedTokens" TEXT NOT NULL,
    "scope" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelAuth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestedMessage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channelId" TEXT,
    "externalId" TEXT,
    "threadId" TEXT,
    "direction" TEXT NOT NULL,
    "sender" TEXT,
    "recipients" JSONB,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "hash" TEXT,
    "redactFlags" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IngestedMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Meeting" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "externalId" TEXT,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "paperAuthorMembershipId" TEXT,
    "transcriptOptIns" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityCandidate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jurisdiction" TEXT,
    "serviceLine" TEXT,
    "classification" TEXT,
    "confidence" DOUBLE PRECISION,
    "rationale" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "reviewerMembershipId" TEXT,
    "partnerType" TEXT NOT NULL DEFAULT 'DEFAULT',
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SentimentSignal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ingestedMessageId" TEXT,
    "classification" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "trigger" TEXT,
    "evidence" JSONB,
    "shouldEscalate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SentimentSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdherenceScore" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "overall" DOUBLE PRECISION NOT NULL,
    "sampleN" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdherenceScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DPIAAttestation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "scope" JSONB NOT NULL,
    "signedByName" TEXT NOT NULL,
    "signedByRole" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "documentRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DPIAAttestation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DSARequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectIdent" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "packageRef" TEXT,

    CONSTRAINT "DSARequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoGoSubject" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NoGoSubject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputHash" TEXT,
    "outputHash" TEXT,
    "latencyMs" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cacheReadTokens" INTEGER,
    "cacheCreationTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE INDEX "Tenant_status_idx" ON "Tenant"("status");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Membership_tenantId_role_idx" ON "Membership"("tenantId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_tenantId_userId_key" ON "Membership"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "FirmCultureGuide_tenantId_status_idx" ON "FirmCultureGuide"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FirmCultureGuide_tenantId_version_key" ON "FirmCultureGuide"("tenantId", "version");

-- CreateIndex
CREATE INDEX "FCGRule_tenantId_fcgId_idx" ON "FCGRule"("tenantId", "fcgId");

-- CreateIndex
CREATE UNIQUE INDEX "FCGRule_fcgId_externalId_key" ON "FCGRule"("fcgId", "externalId");

-- CreateIndex
CREATE INDEX "FCGProposal_tenantId_state_idx" ON "FCGProposal"("tenantId", "state");

-- CreateIndex
CREATE INDEX "FCGChatTurn_tenantId_proposalId_idx" ON "FCGChatTurn"("tenantId", "proposalId");

-- CreateIndex
CREATE INDEX "FCGVote_tenantId_idx" ON "FCGVote"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "FCGVote_proposalId_membershipId_key" ON "FCGVote"("proposalId", "membershipId");

-- CreateIndex
CREATE INDEX "UserCultureGuide_tenantId_status_idx" ON "UserCultureGuide"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "UserCultureGuide_membershipId_version_key" ON "UserCultureGuide"("membershipId", "version");

-- CreateIndex
CREATE INDEX "UCGRule_tenantId_ucgId_idx" ON "UCGRule"("tenantId", "ucgId");

-- CreateIndex
CREATE UNIQUE INDEX "UCGRule_ucgId_externalId_key" ON "UCGRule"("ucgId", "externalId");

-- CreateIndex
CREATE INDEX "UCGChatTurn_tenantId_ucgId_idx" ON "UCGChatTurn"("tenantId", "ucgId");

-- CreateIndex
CREATE INDEX "ComplianceRuling_tenantId_ucgId_idx" ON "ComplianceRuling"("tenantId", "ucgId");

-- CreateIndex
CREATE INDEX "Draft_tenantId_membershipId_status_idx" ON "Draft"("tenantId", "membershipId", "status");

-- CreateIndex
CREATE INDEX "Action_tenantId_membershipId_status_idx" ON "Action"("tenantId", "membershipId", "status");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_eventType_createdAt_idx" ON "AuditEvent"("tenantId", "eventType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_tenantId_seq_key" ON "AuditEvent"("tenantId", "seq");

-- CreateIndex
CREATE INDEX "Channel_tenantId_kind_idx" ON "Channel"("tenantId", "kind");

-- CreateIndex
CREATE INDEX "ChannelAuth_tenantId_channelId_idx" ON "ChannelAuth"("tenantId", "channelId");

-- CreateIndex
CREATE INDEX "IngestedMessage_tenantId_threadId_idx" ON "IngestedMessage"("tenantId", "threadId");

-- CreateIndex
CREATE INDEX "Meeting_tenantId_startsAt_idx" ON "Meeting"("tenantId", "startsAt");

-- CreateIndex
CREATE INDEX "OpportunityCandidate_tenantId_status_idx" ON "OpportunityCandidate"("tenantId", "status");

-- CreateIndex
CREATE INDEX "SentimentSignal_tenantId_classification_idx" ON "SentimentSignal"("tenantId", "classification");

-- CreateIndex
CREATE INDEX "AdherenceScore_tenantId_period_idx" ON "AdherenceScore"("tenantId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "AdherenceScore_membershipId_period_key" ON "AdherenceScore"("membershipId", "period");

-- CreateIndex
CREATE INDEX "DPIAAttestation_tenantId_idx" ON "DPIAAttestation"("tenantId");

-- CreateIndex
CREATE INDEX "DSARequest_tenantId_status_idx" ON "DSARequest"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "NoGoSubject_tenantId_label_key" ON "NoGoSubject"("tenantId", "label");

-- CreateIndex
CREATE INDEX "ModelRun_tenantId_purpose_createdAt_idx" ON "ModelRun"("tenantId", "purpose", "createdAt");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_parentTenantId_fkey" FOREIGN KEY ("parentTenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FirmCultureGuide" ADD CONSTRAINT "FirmCultureGuide_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "FirmCultureGuide"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FirmCultureGuide" ADD CONSTRAINT "FirmCultureGuide_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FCGRule" ADD CONSTRAINT "FCGRule_fcgId_fkey" FOREIGN KEY ("fcgId") REFERENCES "FirmCultureGuide"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FCGProposal" ADD CONSTRAINT "FCGProposal_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FCGProposal" ADD CONSTRAINT "FCGProposal_proposedById_fkey" FOREIGN KEY ("proposedById") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FCGChatTurn" ADD CONSTRAINT "FCGChatTurn_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "FCGProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FCGVote" ADD CONSTRAINT "FCGVote_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "FCGProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FCGVote" ADD CONSTRAINT "FCGVote_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FCGVote" ADD CONSTRAINT "FCGVote_castByMembershipId_fkey" FOREIGN KEY ("castByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCultureGuide" ADD CONSTRAINT "UserCultureGuide_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "UserCultureGuide"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCultureGuide" ADD CONSTRAINT "UserCultureGuide_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCultureGuide" ADD CONSTRAINT "UserCultureGuide_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCultureGuide" ADD CONSTRAINT "UserCultureGuide_basedOnFcgId_fkey" FOREIGN KEY ("basedOnFcgId") REFERENCES "FirmCultureGuide"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UCGRule" ADD CONSTRAINT "UCGRule_ucgId_fkey" FOREIGN KEY ("ucgId") REFERENCES "UserCultureGuide"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UCGChatTurn" ADD CONSTRAINT "UCGChatTurn_ucgId_fkey" FOREIGN KEY ("ucgId") REFERENCES "UserCultureGuide"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceRuling" ADD CONSTRAINT "ComplianceRuling_ucgId_fkey" FOREIGN KEY ("ucgId") REFERENCES "UserCultureGuide"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_ingestedMessageId_fkey" FOREIGN KEY ("ingestedMessageId") REFERENCES "IngestedMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Action" ADD CONSTRAINT "Action_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Action" ADD CONSTRAINT "Action_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Action" ADD CONSTRAINT "Action_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "Draft"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorMembershipId_fkey" FOREIGN KEY ("actorMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelAuth" ADD CONSTRAINT "ChannelAuth_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelAuth" ADD CONSTRAINT "ChannelAuth_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestedMessage" ADD CONSTRAINT "IngestedMessage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestedMessage" ADD CONSTRAINT "IngestedMessage_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_paperAuthorMembershipId_fkey" FOREIGN KEY ("paperAuthorMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityCandidate" ADD CONSTRAINT "OpportunityCandidate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityCandidate" ADD CONSTRAINT "OpportunityCandidate_reviewerMembershipId_fkey" FOREIGN KEY ("reviewerMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SentimentSignal" ADD CONSTRAINT "SentimentSignal_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdherenceScore" ADD CONSTRAINT "AdherenceScore_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdherenceScore" ADD CONSTRAINT "AdherenceScore_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DPIAAttestation" ADD CONSTRAINT "DPIAAttestation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DSARequest" ADD CONSTRAINT "DSARequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoGoSubject" ADD CONSTRAINT "NoGoSubject_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

