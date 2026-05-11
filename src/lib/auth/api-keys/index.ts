export {
  generateApiKey,
  parseApiKey,
  computeHash,
  hashesMatch,
  PREFIX_LEN,
  SECRET_LEN,
  BRAND,
} from "./secret";
export type { GeneratedKey, ParsedKey } from "./secret";

export {
  SCOPE_CATALOGUE,
  scopeDefinition,
  isKnownScope,
  isWildcard,
  assertAssignable,
  scopeAllows,
  ScopeError,
} from "./scopes";
export type { ApiScope, ScopeDefinition } from "./scopes";

export {
  createApiKey,
  revokeApiKey,
  listApiKeysForTenant,
  authenticateApiKey,
  recordAuthFailure,
  sweepInactiveOrExpiredApiKeys,
  ApiKeyValidationError,
} from "./store";
export type {
  PublicApiKey,
  CreateApiKeyResult,
  AuthenticatedApiKey,
  RevokeReason,
} from "./store";

export { withApiKey } from "./auth";
export type { ApiKeyContext, ApiKeyHandler, WithApiKeyOptions } from "./auth";

export {
  withIdempotency,
  hashRequestBody,
  validateKey as validateIdempotencyKey,
  purgeExpiredIdempotencyKeys,
  IdempotencyError,
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_TTL_MS,
  IDEMPOTENCY_MIN_KEY_LEN,
  IDEMPOTENCY_MAX_KEY_LEN,
  IDEMPOTENCY_RESPONSE_BODY_CAP_BYTES,
} from "./idempotency";
export type {
  IdempotencyErrorCode,
  WithIdempotencyInput,
  IdempotencyResult,
} from "./idempotency";
