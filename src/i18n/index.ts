/**
 * Minimal, dependency-free i18n layer for the API.
 *
 * Dictionaries are flat, dot-namespaced string maps (`en` is the source of
 * truth, `zh` mirrors it). A translator is bound to one locale and resolves a
 * key with optional `{name}` interpolation.
 */
import { en } from "./en";
import { zh } from "./zh";

export const LOCALES = ["en", "zh"] as const;
export type Locale = (typeof LOCALES)[number];

/** Product default. The SPA defaults to Chinese too. */
export const DEFAULT_LOCALE: Locale = "zh";

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  zh: "中文",
};

export type MessageKey = keyof typeof en;
export type TranslateVars = Record<string, string | number>;
export type TranslateFn = (key: MessageKey, vars?: TranslateVars) => string;

const dictionaries: Record<Locale, Record<MessageKey, string>> = { en, zh };

/** Runtime guard for locale codes arriving from cookies, routes, or headers. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Bind `locale` to a dictionary returning a `t(key, vars?)` translator. */
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

/** Best-effort `Accept-Language` sniffing; returns `null` when nothing matches. */
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

/** Translate an error code if a dictionary key exists; otherwise keep the raw message. */
export function translateErrorCode(t: TranslateFn, code: string, fallback: string): string {
  const key = `error.${code}` as MessageKey;
  const translated = t(key);
  return translated === key ? fallback : translated;
}
