/**
 * Backlog item 10 — UI internationalisation entry point.
 *
 * Server-side helpers (`resolveLocale`, `getT`) and the shared dictionary
 * registry. The runtime is intentionally tiny and dependency-free:
 *   - Locales are statically registered here so bundling stays predictable
 *     under Next 15 / Edge.
 *   - `t(path, vars?)` walks dotted paths with a typed surface; missing
 *     translations transparently fall back to en-GB so a partial second-
 *     locale dictionary never breaks the chrome.
 *   - `resolveLocale({ membership, tenant })` reads Membership.locale first,
 *     then Tenant.defaultLocale, then "en-GB". Unknown codes also fall
 *     back to en-GB.
 *
 * Why not next-intl: every server component would need locale-context
 * threading, and PR §13.5's commitment is "ship en-GB + one more as proof"
 * — an in-tree micro-runtime is a better fit for the current scope and
 * leaves the door open to swap in next-intl later when the surface grows.
 */
import { enGB, type Dictionary } from "./dictionaries/en-GB";
import { fr } from "./dictionaries/fr";

export type LocaleCode = "en-GB" | "fr";

export const SUPPORTED_LOCALES: ReadonlyArray<LocaleCode> = ["en-GB", "fr"];

export const LOCALE_LABELS: Record<LocaleCode, { name: string; nativeName: string }> = {
  "en-GB": { name: "English (United Kingdom)", nativeName: "English" },
  fr: { name: "French", nativeName: "Français" },
};

const DICTIONARIES: Record<LocaleCode, Dictionary> = {
  "en-GB": enGB,
  fr,
};

export const FALLBACK_LOCALE: LocaleCode = "en-GB";

export function isSupportedLocale(value: unknown): value is LocaleCode {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Resolve the effective UI locale for a request:
 *  1. Membership.locale, when set and supported
 *  2. Tenant.defaultLocale, when supported
 *  3. FALLBACK_LOCALE (en-GB)
 */
export function resolveLocale(input: {
  membership?: { locale?: string | null } | null;
  tenant?: { defaultLocale?: string | null } | null;
}): LocaleCode {
  const m = input.membership?.locale;
  if (isSupportedLocale(m)) return m;
  const t = input.tenant?.defaultLocale;
  if (isSupportedLocale(t)) return t;
  return FALLBACK_LOCALE;
}

/**
 * Dotted-path lookup with `{var}` interpolation. Falls back to en-GB on a
 * miss in the requested locale; falls back to the path itself if even
 * en-GB is missing the key (developer signal — never seen by a translator
 * because adding a key in en-GB but not in fr is a TS build error via the
 * `Dictionary` constraint).
 */
export type TFunction = (path: DictionaryPath, vars?: Record<string, string | number>) => string;

export type DictionaryPath =
  | `nav.${keyof Dictionary["nav"]}`
  | `shell.${keyof Dictionary["shell"]}`
  | `dpia.${keyof Dictionary["dpia"]}`
  | `account.${keyof Dictionary["account"]}`
  | `twofa.${keyof Dictionary["twofa"]}`
  | `sessions.${keyof Dictionary["sessions"]}`
  | `notifications.mutedByPreference`
  | `notifications.kinds.${keyof Dictionary["notifications"]["kinds"]}`
  | `audit.${keyof Dictionary["audit"]}`
  | "locale";

export function getT(locale: LocaleCode): TFunction {
  const primary = DICTIONARIES[locale] ?? DICTIONARIES[FALLBACK_LOCALE];
  const fallback = DICTIONARIES[FALLBACK_LOCALE];
  return (path, vars) => {
    const value =
      walk(primary, path) ??
      (locale === FALLBACK_LOCALE ? undefined : walk(fallback, path)) ??
      path;
    return interpolate(value, vars);
  };
}

export function getDictionary(locale: LocaleCode): Dictionary {
  return DICTIONARIES[locale] ?? DICTIONARIES[FALLBACK_LOCALE];
}

function walk(dict: Dictionary, path: string): string | undefined {
  const parts = path.split(".");
  let cur: unknown = dict;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return typeof cur === "string" ? cur : undefined;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) => {
    const v = vars[k];
    return v === undefined || v === null ? m : String(v);
  });
}
