/**
 * RFC 9116 security.txt builder + parser (post-PRD hardening item 25).
 *
 * Coverage:
 *   - Required fields enforced: Contact + Expires.
 *   - Validation: contact-target shape (mailto/tel/http(s)), URL fields,
 *     BCP-47 preferred-languages, Expires future-only + ≤1-year ceiling.
 *   - parseSecurityTxt round-trips a built file.
 *   - buildForRequest produces a Canonical: pointing at the request's
 *     /.well-known/security.txt regardless of the rewrite target.
 */
import { describe, it, expect } from "vitest";
import {
  buildForRequest,
  buildSecurityTxt,
  parseSecurityTxt,
  SecurityTxtValidationError,
} from "@/lib/security-disclosure";

const NOW = new Date("2026-05-11T00:00:00.000Z");

describe("buildSecurityTxt — required fields", () => {
  it("rejects an empty contacts list", () => {
    expect(() =>
      buildSecurityTxt({
        contacts: [],
        canonical: ["https://example.com/.well-known/security.txt"],
        now: NOW,
      }),
    ).toThrow(SecurityTxtValidationError);
  });

  it("rejects a malformed contact value", () => {
    expect(() =>
      buildSecurityTxt({
        contacts: ["not-a-uri"],
        canonical: ["https://example.com/.well-known/security.txt"],
        now: NOW,
      }),
    ).toThrow(/Contact value/);
  });

  it("accepts mailto:, tel:, and https:// contacts", () => {
    const body = buildSecurityTxt({
      contacts: [
        "mailto:security@acumon.com",
        "tel:+44-20-7946-0000",
        "https://acumon.com/security-form",
      ],
      canonical: ["https://acumon.com/.well-known/security.txt"],
      now: NOW,
    });
    expect(body).toContain("Contact: mailto:security@acumon.com");
    expect(body).toContain("Contact: tel:+44-20-7946-0000");
    expect(body).toContain("Contact: https://acumon.com/security-form");
  });
});

describe("buildSecurityTxt — Expires field", () => {
  it("rejects a past Expires", () => {
    expect(() =>
      buildSecurityTxt({
        contacts: ["mailto:security@acumon.com"],
        canonical: ["https://example.com/.well-known/security.txt"],
        expiresAt: new Date(NOW.getTime() - 60_000),
        now: NOW,
      }),
    ).toThrow(/future/);
  });

  it("rejects an Expires more than 1 year out (RFC 9116 §2.5.5)", () => {
    expect(() =>
      buildSecurityTxt({
        contacts: ["mailto:security@acumon.com"],
        canonical: ["https://example.com/.well-known/security.txt"],
        expiresAt: new Date(NOW.getTime() + 400 * 24 * 60 * 60 * 1000),
        now: NOW,
      }),
    ).toThrow(/year/);
  });

  it("defaults Expires to ~350 days in the future when omitted", () => {
    const body = buildSecurityTxt({
      contacts: ["mailto:security@acumon.com"],
      canonical: ["https://example.com/.well-known/security.txt"],
      now: NOW,
    });
    const parsed = parseSecurityTxt(body);
    expect(parsed.expires).not.toBeNull();
    const days = (parsed.expires!.getTime() - NOW.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(300);
    expect(days).toBeLessThan(365);
  });
});

describe("buildSecurityTxt — optional URL fields", () => {
  it("rejects non-URL values for Canonical/Encryption/Policy/Acknowledgments/Hiring", () => {
    for (const field of [
      "encryption",
      "acknowledgments",
      "policy",
      "hiring",
    ] as const) {
      expect(() =>
        buildSecurityTxt({
          contacts: ["mailto:s@e.com"],
          canonical: ["https://e.com/.well-known/security.txt"],
          [field]: "not-a-url",
          now: NOW,
        } as Parameters<typeof buildSecurityTxt>[0]),
      ).toThrow(SecurityTxtValidationError);
    }
    expect(() =>
      buildSecurityTxt({
        contacts: ["mailto:s@e.com"],
        canonical: ["not-a-url"],
        now: NOW,
      }),
    ).toThrow(SecurityTxtValidationError);
  });

  it("rejects malformed BCP-47 preferred-languages tags", () => {
    expect(() =>
      buildSecurityTxt({
        contacts: ["mailto:s@e.com"],
        canonical: ["https://e.com/.well-known/security.txt"],
        preferredLanguages: ["en", "x_y"],
        now: NOW,
      }),
    ).toThrow(/BCP-47/);
  });

  it("emits Preferred-Languages joined by ', ' when provided", () => {
    const body = buildSecurityTxt({
      contacts: ["mailto:s@e.com"],
      canonical: ["https://e.com/.well-known/security.txt"],
      preferredLanguages: ["en", "fr"],
      now: NOW,
    });
    expect(body).toContain("Preferred-Languages: en, fr");
  });
});

describe("parseSecurityTxt", () => {
  it("round-trips a fully-populated build", () => {
    const built = buildSecurityTxt({
      contacts: ["mailto:s@acumon.com", "https://acumon.com/form"],
      canonical: ["https://acumon.com/.well-known/security.txt"],
      encryption: "https://acumon.com/pgp.asc",
      acknowledgments: "https://acumon.com/hall-of-fame",
      policy: "https://github.com/x/y/blob/main/SECURITY.md",
      hiring: "https://acumon.com/jobs",
      preferredLanguages: ["en"],
      now: NOW,
    });
    const parsed = parseSecurityTxt(built);
    expect(parsed.contacts).toEqual([
      "mailto:s@acumon.com",
      "https://acumon.com/form",
    ]);
    expect(parsed.canonical).toEqual(["https://acumon.com/.well-known/security.txt"]);
    expect(parsed.encryption).toBe("https://acumon.com/pgp.asc");
    expect(parsed.acknowledgments).toBe("https://acumon.com/hall-of-fame");
    expect(parsed.policy).toBe("https://github.com/x/y/blob/main/SECURITY.md");
    expect(parsed.hiring).toBe("https://acumon.com/jobs");
    expect(parsed.preferredLanguages).toEqual(["en"]);
    expect(parsed.expires).not.toBeNull();
    expect(parsed.unknown).toEqual([]);
  });

  it("ignores comments and blank lines", () => {
    const body = [
      "# this is a comment",
      "",
      "Contact: mailto:s@e.com",
      "Expires: 2030-01-01T00:00:00Z",
      "# trailing comment",
      "",
    ].join("\n");
    const parsed = parseSecurityTxt(body);
    expect(parsed.contacts).toEqual(["mailto:s@e.com"]);
    expect(parsed.expires?.toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });

  it("accepts the alternative spelling 'Acknowledgements'", () => {
    const parsed = parseSecurityTxt(
      [
        "Contact: mailto:s@e.com",
        "Expires: 2030-01-01T00:00:00Z",
        "Acknowledgements: https://acumon.com/thanks",
      ].join("\n"),
    );
    expect(parsed.acknowledgments).toBe("https://acumon.com/thanks");
  });

  it("captures unknown fields in `unknown` for diagnostics", () => {
    const parsed = parseSecurityTxt(
      [
        "Contact: mailto:s@e.com",
        "Expires: 2030-01-01T00:00:00Z",
        "X-Custom: experimental-value",
      ].join("\n"),
    );
    expect(parsed.unknown).toEqual([{ name: "x-custom", value: "experimental-value" }]);
  });
});

describe("buildForRequest", () => {
  it("emits a Canonical: pointing at the request's /.well-known/security.txt", () => {
    const body = buildForRequest(
      new URL("https://acumon.example.com/api/security-txt"),
      {
        contactEmail: "security@acumon.example.com",
        policyUrl: "https://acumon.example.com/policy",
        acknowledgmentsUrl: null,
        preferredLanguages: ["en"],
      },
      NOW,
    );
    const parsed = parseSecurityTxt(body);
    expect(parsed.canonical).toEqual([
      "https://acumon.example.com/.well-known/security.txt",
    ]);
    expect(parsed.contacts).toEqual(["mailto:security@acumon.example.com"]);
    expect(parsed.policy).toBe("https://acumon.example.com/policy");
  });
});
