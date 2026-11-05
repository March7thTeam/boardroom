import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  LOCALES,
  LOCALE_LABELS,
  getTranslator,
  htmlLang,
  readStoredLocale,
  writeStoredLocale,
  type Locale,
  type TranslateFn,
} from "./core";

export interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TranslateFn;
  locales: readonly Locale[];
  labels: Record<Locale, string>;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [locale, setLocaleState] = useState<Locale>(() => readStoredLocale());

  const setLocale = (next: Locale) => {
    setLocaleState(next);
    writeStoredLocale(next);
  };

  useEffect(() => {
    document.documentElement.lang = htmlLang(locale);
    document.documentElement.setAttribute("data-locale", locale);
  }, [locale]);

  const t = useMemo(() => getTranslator(locale), [locale]);
  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale,
      t,
      locales: LOCALES,
      labels: LOCALE_LABELS,
    }),
    [locale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used within I18nProvider");
  return value;
}

export * from "./core";
