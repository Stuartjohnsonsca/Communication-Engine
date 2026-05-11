/**
 * AES-256-GCM helpers for encrypting OAuth tokens at rest in
 * `ChannelAuth.encryptedTokens` (PRD §12.7) and similar sensitive blobs in
 * `UserTotp.secretEncrypted` + `WebhookSubscription.secretEncrypted`.
 *
 * Since item 27 the cipher is version-aware: blobs written before the
 * rotation infrastructure have no version prefix and are read with the
 * legacy `ENCRYPTION_KEY` (treated as "v1"); new writes carry a `v<N>:`
 * prefix and decrypt against whichever version that prefix names. See
 * `src/lib/crypto/keys.ts` for the registry contract.
 *
 * Backwards-compatible re-export: callers that imported `{encryptJson,
 * decryptJson}` from this module continue to work unchanged.
 */
import {
  decryptJsonWith,
  encryptJsonWith,
  getRegistry,
} from "@/lib/crypto/keys";

export function encryptJson(value: unknown): string {
  return encryptJsonWith(getRegistry(), value);
}

export function decryptJson<T = unknown>(blob: string): T {
  return decryptJsonWith<T>(getRegistry(), blob);
}
