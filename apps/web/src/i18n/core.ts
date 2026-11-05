/**
 * Minimal, dependency-free i18n core for the SPA.
 *
 * Dictionaries are flat, dot-namespaced string maps (`en` is the source of
 * truth, `zh` mirrors it). A translator is bound to one locale and resolves a
 * key with optional `{name}` interpolation.
 */
import { en } from "./en";
import { zh } from "./zh";

export const LOCALES = ["en", "zh"] as const;
export type Locale = (typeof LOCALES)[number];

/** Product default: the UI was originally Chinese. */
export const DEFAULT_LOCALE: Locale = "zh";

export const LOCALE_STORAGE_KEY = "boardroom.locale";

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  zh: "中文",
};

export type MessageKey = keyof typeof en;
export type TranslateVars = Record<string, string | number>;
export type TranslateFn = (key: MessageKey, vars?: TranslateVars) => string;

const dictionaries: Record<Locale, Record<MessageKey, string>> = { en, zh };

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function getTranslator(locale: Locale): TranslateFn {
  const dict = dictionaries[locale];
  return (key, vars) => {
    let str = dict[key] ?? en[key] ?? key;
    if (vars) {
      for (const [name, value] of Object.entries(vars)) {
        str = str.replaceAll(`{${name}}`, String(value));
      }
    }
    return str;
  };
}

export function parseAcceptLanguage(header: string | undefined | null): Locale | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const tag = (part.split(";")[0] ?? "").trim().toLowerCase();
    if (!tag || tag === "*") continue;
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("en")) return "en";
  }
  return null;
}

export function htmlLang(locale: Locale): string {
  return locale === "zh" ? "zh-CN" : "en";
}

/** Minimal browser globals, declared locally so this file also compiles in the Worker tsconfig. */
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface NavigatorLike {
  language?: string;
}

/** Read the persisted locale, then fall back to the browser language. */
export function readStoredLocale(): Locale {
  const storage = (globalThis as { localStorage?: StorageLike }).localStorage;
  try {
    const stored = storage?.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // ignore storage failures
  }
  const navigatorLocale = (globalThis as { navigator?: NavigatorLike }).navigator?.language
    ? parseAcceptLanguage((globalThis as { navigator?: NavigatorLike }).navigator?.language)
    : null;
  return navigatorLocale ?? DEFAULT_LOCALE;
}

export function writeStoredLocale(locale: Locale): void {
  const storage = (globalThis as { localStorage?: StorageLike }).localStorage;
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // ignore storage failures
  }
}
