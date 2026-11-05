import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { DEFAULT_LOCALE, LOCALE_LABELS, LOCALES, isLocale } from "../i18n";
import { parseBody } from "../lib/http";
import { setLocaleCookie } from "../middleware/locale";

export const localeRoutes = new Hono<AppEnv>();

const localeSchema = z.object({
  locale: z.enum(LOCALES),
});

localeRoutes.get("/locale", (c) => {
  return c.json({
    locale: c.get("locale") ?? DEFAULT_LOCALE,
    default_locale: DEFAULT_LOCALE,
    locales: LOCALES,
    labels: LOCALE_LABELS,
  });
});

localeRoutes.post("/locale", async (c) => {
  const body = await parseBody(c, localeSchema);
  setLocaleCookie(c, body.locale);
  return c.json({ locale: body.locale });
});

export const languageRoutes = new Hono<AppEnv>();

export function safeRedirectPath(next: string, requestUrl: string): string {
  if (!next.startsWith("/") || next.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(next)) return "/";
  try {
    const base = new URL(requestUrl);
    const target = new URL(next, base);
    return target.origin === base.origin ? `${target.pathname}${target.search}${target.hash}` : "/";
  } catch {
    return "/";
  }
}

languageRoutes.get("/language/:code", (c) => {
  const code = c.req.param("code");
  if (isLocale(code)) setLocaleCookie(c, code);

  const next = c.req.query("next") ?? "/";
  const safeNext = safeRedirectPath(next, c.req.url);
  return c.redirect(safeNext);
});
