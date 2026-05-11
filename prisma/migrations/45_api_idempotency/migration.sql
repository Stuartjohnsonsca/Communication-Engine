-- Post-PRD hardening: Stripe-style idempotency keys for /api/v1/* write
-- endpoints. See 45_api_idempotency README + src/lib/auth/api-keys/idempotency.ts.

CREATE TABLE "ApiIdempotencyKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "methodPath" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER,
    "responseBody" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiIdempotencyKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiIdempotencyKey_apiKeyId_key_methodPath_key"
    ON "ApiIdempotencyKey"("apiKeyId", "key", "methodPath");

CREATE INDEX "ApiIdempotencyKey_tenantId_idx"
    ON "ApiIdempotencyKey"("tenantId");

CREATE INDEX "ApiIdempotencyKey_expiresAt_idx"
    ON "ApiIdempotencyKey"("expiresAt");

ALTER TABLE "ApiIdempotencyKey"
    ADD CONSTRAINT "ApiIdempotencyKey_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApiIdempotencyKey"
    ADD CONSTRAINT "ApiIdempotencyKey_apiKeyId_fkey"
    FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
