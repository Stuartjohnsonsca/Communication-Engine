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
