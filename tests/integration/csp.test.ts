/**
 * CSP nonce + header construction (post-PRD opportunistic hardening).
 *
 * Coverage:
 *   - generateCspNonce returns 128 bits of base64 entropy each call.
 *   - Two successive nonces differ (collision probability is 2^-128;
 *     fail-loud if the random source is broken).
 *   - buildCspHeader embeds the nonce in script-src and includes
 *     'strict-dynamic' alongside 'unsafe-inline' (graceful degradation).
 *   - Every required directive is present with the expected value.
 *   - The header is a single ;-delimited string (no leading/trailing
 *     whitespace, no double-semicolons).
 */
import { describe, it, expect } from "vitest";
import { buildCspHeader, generateCspNonce } from "@/lib/security/csp";

describe("CSP nonce", () => {
  it("emits a 24-char base64 string (128 bits)", () => {
    const n = generateCspNonce();
    // 16 bytes -> ceil(16/3)*4 = 24 base64 chars with '=='-padding.
    expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it("emits a different value on each call", () => {
    const a = generateCspNonce();
    const b = generateCspNonce();
    expect(a).not.toBe(b);
  });
});

describe("CSP header construction", () => {
  const nonce = "test-nonce-aaaaaaaaaaaa==";

  it("embeds the nonce in script-src and keeps strict-dynamic + unsafe-inline", () => {
    const csp = buildCspHeader(nonce);
    const scriptSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src"));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).toContain(`'nonce-${nonce}'`);
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).toContain("'unsafe-inline'"); // graceful fallback for old browsers
  });

  it("locks down high-risk directives", () => {
    const csp = buildCspHeader(nonce);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("permits inline styles (Tailwind / next/font) but not arbitrary script", () => {
    const csp = buildCspHeader(nonce);
    expect(csp).toMatch(/style-src 'self' 'unsafe-inline'(?:;|$)/);
  });

  it("is well-formed — no leading/trailing whitespace or empty directives", () => {
    const csp = buildCspHeader(nonce);
    expect(csp).not.toMatch(/^\s|\s$/);
    expect(csp.split(";").map((d) => d.trim())).not.toContain("");
  });

  it("includes a different nonce on each construction", () => {
    const csp1 = buildCspHeader("alpha");
    const csp2 = buildCspHeader("beta");
    expect(csp1).toContain("'nonce-alpha'");
    expect(csp2).toContain("'nonce-beta'");
    expect(csp1).not.toBe(csp2);
  });
});
