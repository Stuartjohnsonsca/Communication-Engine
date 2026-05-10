"use client";

import { createContext, useContext, useMemo } from "react";
import { getT, type LocaleCode, type TFunction, FALLBACK_LOCALE } from "./index";

/**
 * Client-side mirror of `getT`. The server resolves the locale once per
 * request and passes it down through `<LocaleProvider locale=…>`; child
 * client components read translations via `useT()`.
 *
 * The dictionaries themselves are statically imported, so the bundler
 * tree-shakes nothing here — both locales currently ship to every page.
 * That's fine at this size (the dictionaries are <2KB combined). If they
 * grow, swap to dynamic `import()` per locale.
 */

type Ctx = {
  locale: LocaleCode;
  t: TFunction;
};

const LocaleContext = createContext<Ctx>({
  locale: FALLBACK_LOCALE,
  t: getT(FALLBACK_LOCALE),
});

export function LocaleProvider({
  locale,
  children,
}: {
  locale: LocaleCode;
  children: React.ReactNode;
}) {
  const value = useMemo<Ctx>(() => ({ locale, t: getT(locale) }), [locale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useT(): TFunction {
  return useContext(LocaleContext).t;
}

export function useLocale(): LocaleCode {
  return useContext(LocaleContext).locale;
}
