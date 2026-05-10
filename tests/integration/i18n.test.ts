/**
 * Backlog item 10 — UI internationalisation.
 *
 * Coverage:
 *  - resolveLocale precedence: membership.locale > tenant.defaultLocale > fallback
 *  - Unknown codes fall back rather than throw
 *  - getT returns the requested locale's string, with en-GB fallback for
 *    keys absent in the secondary locale (no key should be — TS enforces
 *    Dictionary shape — but the runtime should be defensive)
 *  - Dictionary parity at runtime: every key in en-GB walks to a string in
 *    fr (catches accidental nested-shape drift that TS would miss because
 *    `as const` widens to readonly)
 *  - Interpolation: `{var}` substitution
 *  - Migration 30 applied (defaultLocale on Tenant, locale on Membership)
 */
import { describe, it, expect } from "vitest";
import { superDb } from "@/lib/db";
import {
  FALLBACK_LOCALE,
  SUPPORTED_LOCALES,
  getT,
  getDictionary,
  isSupportedLocale,
  resolveLocale,
} from "@/lib/i18n";
import { createTestTenant, createTestUserAndMembership } from "../helpers/fixtures";

describe("i18n: resolveLocale", () => {
  it("falls back to en-GB when both inputs are null", () => {
    expect(resolveLocale({ membership: null, tenant: null })).toBe("en-GB");
  });

  it("uses tenant.defaultLocale when membership has no preference", () => {
    expect(
      resolveLocale({
        membership: { locale: null },
        tenant: { defaultLocale: "fr" },
      }),
    ).toBe("fr");
  });

  it("prefers membership.locale over tenant.defaultLocale", () => {
    expect(
      resolveLocale({
        membership: { locale: "fr" },
        tenant: { defaultLocale: "en-GB" },
      }),
    ).toBe("fr");
  });

  it("ignores unsupported codes (falls through to the next tier)", () => {
    expect(
      resolveLocale({
        membership: { locale: "kr" }, // unsupported
        tenant: { defaultLocale: "fr" },
      }),
    ).toBe("fr");
    expect(
      resolveLocale({
        membership: { locale: null },
        tenant: { defaultLocale: "zh" }, // unsupported
      }),
    ).toBe(FALLBACK_LOCALE);
  });
});

describe("i18n: getT", () => {
  it("returns the requested locale's translation", () => {
    expect(getT("en-GB")("nav.dashboard")).toBe("Dashboard");
    expect(getT("fr")("nav.dashboard")).toBe("Tableau de bord");
  });

  it("interpolates {var} placeholders", () => {
    const t = getT("en-GB");
    expect(t("account.inheritFromTenant", { locale: "fr" })).toContain("(fr)");
  });

  it("never throws on an unknown key — returns the path", () => {
    const t = getT("fr");
    // Cast intentional — runtime defensiveness check.
    const out = t("nav.zzz_missing" as never);
    expect(out).toBe("nav.zzz_missing");
  });

  it("isSupportedLocale guards correctly", () => {
    expect(isSupportedLocale("en-GB")).toBe(true);
    expect(isSupportedLocale("fr")).toBe(true);
    expect(isSupportedLocale("zh")).toBe(false);
    expect(isSupportedLocale(null)).toBe(false);
    expect(isSupportedLocale(42)).toBe(false);
  });
});

describe("i18n: dictionary parity", () => {
  function walk(obj: unknown, prefix = ""): string[] {
    if (typeof obj === "string") return [prefix];
    if (obj && typeof obj === "object") {
      const out: string[] = [];
      for (const [k, v] of Object.entries(obj)) {
        out.push(...walk(v, prefix ? `${prefix}.${k}` : k));
      }
      return out;
    }
    return [];
  }

  it("every key present in en-GB also resolves to a string in fr", () => {
    const enKeys = walk(getDictionary("en-GB")).sort();
    const frKeys = walk(getDictionary("fr")).sort();
    expect(frKeys).toEqual(enKeys);
  });

  it("supports the locales advertised in SUPPORTED_LOCALES", () => {
    for (const code of SUPPORTED_LOCALES) {
      // Sanity: the dictionary self-identifies its locale.
      expect(getDictionary(code).locale).toBe(code);
    }
  });
});

describe("i18n: persistence (migration 30)", () => {
  it("Tenant.defaultLocale defaults to en-GB and is round-trippable", async () => {
    const t = await createTestTenant();
    expect(t.defaultLocale).toBe("en-GB");

    const updated = await superDb.tenant.update({
      where: { id: t.id },
      data: { defaultLocale: "fr" },
    });
    expect(updated.defaultLocale).toBe("fr");
  });

  it("Membership.locale is nullable + round-trippable", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id);
    expect(membership.locale).toBeNull();

    const set = await superDb.membership.update({
      where: { id: membership.id },
      data: { locale: "fr" },
    });
    expect(set.locale).toBe("fr");

    const cleared = await superDb.membership.update({
      where: { id: membership.id },
      data: { locale: null },
    });
    expect(cleared.locale).toBeNull();
  });

  it("resolveLocale uses real persisted values end-to-end", async () => {
    const tenant = await superDb.tenant.create({
      data: { slug: `i18n-${Date.now()}`, name: "i18n test", defaultLocale: "fr" },
    });
    const { membership } = await createTestUserAndMembership(tenant.id);
    expect(resolveLocale({ membership, tenant })).toBe("fr");

    const withOwn = await superDb.membership.update({
      where: { id: membership.id },
      data: { locale: "en-GB" },
    });
    expect(resolveLocale({ membership: withOwn, tenant })).toBe("en-GB");
  });
});
