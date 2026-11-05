import { describe, expect, it } from "vitest";
import {
  emailStatus,
  getEmailProvider,
  getSmtpConfig,
  type EmailMessage,
} from "../../src/providers/email";
import type { Env } from "../../src/types";

const baseEnv = {
  ENVIRONMENT: "development",
  TOKEN_PEPPER: "pepper",
  DB: {} as D1Database,
  BOARD_DO: {} as Env["BOARD_DO"],
  ASSETS: {} as Fetcher,
} as Env;

const message: EmailMessage = {
  to: "user@example.com",
  subject: "Hello",
  text: "Body",
};

describe("email provider", () => {
  it("uses the console provider in development without SMTP", async () => {
    const provider = getEmailProvider(baseEnv);
    expect(provider.name).toBe("console");
    const result = await provider.send(message);
    expect(result.provider).toBe("console");
    expect(result.status).toBe("skipped");
    expect(result.ok).toBe(true);
  });

  it("uses disabled outside development without SMTP", async () => {
    const env = { ...baseEnv, ENVIRONMENT: "production" };
    const provider = getEmailProvider(env);
    expect(provider.name).toBe("disabled");
    const result = await provider.send(message);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
  });

  it("reads SMTP configuration", () => {
    const env = {
      ...baseEnv,
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
      SMTP_USER: "user",
      SMTP_PASSWORD: "secret",
      SMTP_FROM: "Boardroom <no-reply@example.com>",
      SMTP_SECURE: "starttls" as const,
    };
    const config = getSmtpConfig(env);
    expect(config).toMatchObject({
      host: "smtp.example.com",
      port: 587,
      user: "user",
      secure: "starttls",
    });
    expect(getEmailProvider(env).name).toBe("smtp");
    expect(emailStatus(env)).toMatchObject({
      configured: true,
      provider: "smtp",
      host: "smtp.example.com",
      port: 587,
    });
  });

  it("falls back to SMTP_USER when SMTP_FROM is omitted", () => {
    const env = {
      ...baseEnv,
      SMTP_HOST: "smtp.example.com",
      SMTP_USER: "no-reply@example.com",
      SMTP_PASSWORD: "secret",
    };
    expect(getSmtpConfig(env)).toMatchObject({
      host: "smtp.example.com",
      user: "no-reply@example.com",
      from: "no-reply@example.com",
    });
    expect(getEmailProvider(env).name).toBe("smtp");
    expect(emailStatus(env)).toMatchObject({
      configured: true,
      from: "no-reply@example.com",
    });
  });

  it("requires a sender identity even when a host is set", () => {
    const env = { ...baseEnv, SMTP_HOST: "smtp.example.com" };
    expect(getSmtpConfig(env)).toBeNull();
    expect(getEmailProvider(env).name).toBe("console");
  });
});
