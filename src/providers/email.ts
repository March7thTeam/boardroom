/**
 * Email provider seam.
 *
 * SMTP is loaded lazily so this module stays importable in Node-based unit
 * tests (which cannot resolve `cloudflare:sockets`).
 */
import { newId } from "../lib/ids";
import { nowIso } from "../lib/time";
import type { Env } from "../types";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailResult {
  ok: boolean;
  provider: string;
  status: "sent" | "failed" | "skipped";
  error?: string;
}

export interface EmailProvider {
  name: string;
  send(message: EmailMessage): Promise<EmailResult>;
}

export interface EmailStatus {
  configured: boolean;
  provider: string;
  from: string | null;
  host: string | null;
  port: number | null;
  secure: "on" | "starttls" | "off";
}

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  password?: string;
  from: string;
  secure: "on" | "starttls" | "off";
  replyTo?: string;
}

class ConsoleEmailProvider implements EmailProvider {
  name = "console";

  async send(message: EmailMessage): Promise<EmailResult> {
    console.log(
      JSON.stringify({
        level: "info",
        provider: "console",
        event: "email",
        to: message.to,
        subject: message.subject,
      }),
    );
    return {
      ok: true,
      provider: "console",
      status: "skipped",
      error: "SMTP is not configured; only delivery metadata was logged",
    };
  }
}

class DisabledEmailProvider implements EmailProvider {
  name = "disabled";

  async send(): Promise<EmailResult> {
    return {
      ok: false,
      provider: "disabled",
      status: "failed",
      error: "SMTP is not configured",
    };
  }
}

class SmtpEmailProvider implements EmailProvider {
  name = "smtp";

  constructor(private readonly config: SmtpConfig) {}

  async send(message: EmailMessage): Promise<EmailResult> {
    try {
      const { sendSmtp } = await import("./smtp");
      await sendSmtp(this.config, message);
      return { ok: true, provider: "smtp", status: "sent" };
    } catch {
      return {
        ok: false,
        provider: "smtp",
        status: "failed",
        error: "SMTP delivery failed",
      };
    }
  }
}

export function getSmtpConfig(env: Env): SmtpConfig | null {
  // Minimal configuration: SMTP_HOST is required, and the envelope sender is
  // SMTP_FROM when provided. Many providers let the authenticated account send
  // as itself, so fall back to SMTP_USER instead of requiring a separate FROM.
  const from = env.SMTP_FROM?.trim() || env.SMTP_USER?.trim();
  if (!env.SMTP_HOST || !from) return null;
  const secure = env.SMTP_SECURE ?? (Number(env.SMTP_PORT ?? 465) === 465 ? "on" : "starttls");
  return {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT ?? 465),
    user: env.SMTP_USER,
    password: env.SMTP_PASSWORD,
    from,
    secure,
    replyTo: env.SMTP_REPLY_TO,
  };
}

export function getEmailProvider(env: Env): EmailProvider {
  const config = getSmtpConfig(env);
  if (config) return new SmtpEmailProvider(config);
  if (env.ENVIRONMENT === "development") return new ConsoleEmailProvider();
  return new DisabledEmailProvider();
}

export function emailStatus(env: Env): EmailStatus {
  const config = getSmtpConfig(env);
  return {
    configured: Boolean(config),
    provider: config ? "smtp" : env.ENVIRONMENT === "development" ? "console" : "disabled",
    from: config?.from ?? null,
    host: config?.host ?? null,
    port: config?.port ?? null,
    secure: config?.secure ?? "on",
  };
}

export async function sendAndLogEmail(
  env: Env,
  message: EmailMessage,
  userId?: string | null,
): Promise<EmailResult> {
  const provider = getEmailProvider(env);
  let result: EmailResult;
  try {
    result = await provider.send(message);
  } catch {
    result = {
      ok: false,
      provider: provider.name,
      status: "failed",
      error: "Email delivery failed",
    };
  }

  try {
    await env.DB.prepare(
      `INSERT INTO email_log
         (id, user_id, to_email, subject, body_text, provider, status, error, created_at, sent_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
      .bind(
        newId("eml"),
        userId ?? null,
        message.to,
        message.subject,
        null,
        result.provider,
        result.status,
        result.error ?? null,
        nowIso(),
        result.status === "sent" ? nowIso() : null,
      )
      .run();
  } catch {
    console.error(
      JSON.stringify({
        level: "error",
        event: "email_log_write_failed",
        message: "Email delivery log could not be written",
      }),
    );
  }

  return result;
}

export function appBaseUrl(env: Env, requestUrl: string): string {
  return (env.APP_BASE_URL ?? new URL(requestUrl).origin).replace(/\/+$/, "");
}
