import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE as API_DEFAULT,
  getTranslator as getApiTranslator,
  isLocale as isApiLocale,
  parseAcceptLanguage as parseApiAcceptLanguage,
} from "../../src/i18n";
import {
  DEFAULT_LOCALE as UI_DEFAULT,
  getTranslator as getUiTranslator,
  isLocale as isUiLocale,
  parseAcceptLanguage as parseUiAcceptLanguage,
} from "../../apps/web/src/i18n/core";

describe("API i18n", () => {
  it("interpolates and falls back", () => {
    const t = getApiTranslator("zh");
    expect(t("error.NOT_FOUND")).toBe("资源不存在");
    expect(getApiTranslator("en")("error.NOT_FOUND")).toBe("Not found");
  });

  it("guards locales and parses Accept-Language", () => {
    expect(isApiLocale("zh")).toBe(true);
    expect(isApiLocale("fr")).toBe(false);
    expect(parseApiAcceptLanguage("zh-CN,zh;q=0.9,en;q=0.8")).toBe("zh");
    expect(parseApiAcceptLanguage("en-US")).toBe("en");
    expect(parseApiAcceptLanguage("fr-FR")).toBeNull();
    expect(API_DEFAULT).toBe("zh");
  });
});

describe("UI i18n", () => {
  it("interpolates placeholders", () => {
    const t = getUiTranslator("en");
    expect(t("card.priorityUrgent", { priority: 90 })).toBe("P90 Urgent");
    expect(t("app.agents", { count: 3 })).toBe("◈ Agents (3)");
  });

  it("guards locales and parses browser language", () => {
    expect(isUiLocale("en")).toBe(true);
    expect(isUiLocale("ja")).toBe(false);
    expect(parseUiAcceptLanguage("zh-TW")).toBe("zh");
    expect(parseUiAcceptLanguage("en-GB")).toBe("en");
    expect(UI_DEFAULT).toBe("zh");
  });
});
