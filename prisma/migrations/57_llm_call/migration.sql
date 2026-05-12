-- Post-PRD hardening item 55: persist one row per LLM call so an
-- operator can answer "how many tokens did we burn this month and on
-- what?" without scraping provider invoices. Surfaces on /admin/usage
-- as a 30-day per-role / per-context breakdown.

CREATE TABLE "LlmCall" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "membershipId" TEXT,
    "role" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "modelRunId" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationTokens" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "succeeded" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmCall_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LlmCall_tenantId_createdAt_idx"
    ON "LlmCall"("tenantId", "createdAt" DESC);

CREATE INDEX "LlmCall_tenantId_role_createdAt_idx"
    ON "LlmCall"("tenantId", "role", "createdAt");

CREATE INDEX "LlmCall_tenantId_context_createdAt_idx"
    ON "LlmCall"("tenantId", "context", "createdAt");

ALTER TABLE "LlmCall"
    ADD CONSTRAINT "LlmCall_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LlmCall"
    ADD CONSTRAINT "LlmCall_membershipId_fkey"
    FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
