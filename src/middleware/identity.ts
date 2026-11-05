import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../context";
import { HttpError } from "../lib/http-error";
import { newId } from "../lib/ids";
import { readSession } from "../lib/session";
import { nowIso } from "../lib/time";
import type { UserRow } from "../types";

interface AccessExecutionContext {
  access?: {
    getIdentity(): Promise<{ email?: string } | undefined>;
  };
}

export async function accessEmail(c: Context<AppEnv>): Promise<string | null> {
  const executionCtx = c.executionCtx as unknown as AccessExecutionContext;
  const identity = await executionCtx.access?.getIdentity();
  return identity?.email?.toLowerCase() ?? null;
}

export async function upsertUserByEmail(
  db: D1Database,
  email: string,
  adminEmails: string | undefined,
): Promise<UserRow> {
  const normalized = email.trim().toLowerCase();
  const admins = (adminEmails ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const role = admins.includes(normalized) ? "admin" : "member";
  const existing = await db.prepare("SELECT * FROM users WHERE email = ?1").bind(normalized).first<UserRow>();
  if (existing) {
    const nextRole = role === "admin" ? "admin" : existing.role;
    const seenAt = nowIso();
    await db
      .prepare("UPDATE users SET last_seen_at = ?1, role = ?2 WHERE id = ?3")
      .bind(seenAt, nextRole, existing.id)
      .run();
    return { ...existing, role: nextRole, last_seen_at: seenAt };
  }

  const user: UserRow = {
    id: newId("usr"),
    email: normalized,
    display_name: null,
    role,
    status: "active",
    password_hash: null,
    password_updated_at: null,
    must_change_password: 0,
    auth_version: 1,
    last_seen_at: nowIso(),
    created_at: nowIso(),
  };
  await db
    .prepare(
      `INSERT INTO users
         (id, email, display_name, role, status, password_hash, password_updated_at,
          must_change_password, last_seen_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      user.id,
      user.email,
      user.display_name,
      user.role,
      user.status,
      user.password_hash,
      user.password_updated_at,
      user.must_change_password,
      user.last_seen_at,
      user.created_at,
    )
    .run();
  return user;
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  let user: UserRow | null = null;
  let mode: "development" | "access" | "session" = "session";

  // Local development escape hatch for scripts/curl. The SPA uses a session cookie.
  if (c.env.ENVIRONMENT === "development") {
    const devEmail = c.req.header("X-Dev-Email") ?? c.req.query("dev_email");
    if (devEmail) {
      user = await upsertUserByEmail(c.env.DB, devEmail, c.env.ADMIN_EMAILS);
      mode = "development";
    }
  }

  if (!user) user = await readSession(c);

  if (!user && c.env.AUTH_MODE === "access") {
    const email = await accessEmail(c);
    if (email) {
      user = await upsertUserByEmail(c.env.DB, email, c.env.ADMIN_EMAILS);
      mode = "access";
    }
  }

  if (!user) throw new HttpError(401, "UNAUTHENTICATED", "login required");
  if (user.status !== "active") {
    throw new HttpError(403, "FORBIDDEN", "user is disabled");
  }

  if (user.must_change_password === 1 && !new Set([
    "/api/v1/me", "/api/v1/auth/me", "/api/v1/auth/password", "/api/v1/auth/logout",
  ]).has(c.req.path)) {
    throw new HttpError(403, "PASSWORD_CHANGE_REQUIRED", "change your password before accessing the application");
  }

  c.set("user", user);
  if (mode !== "session") c.set("principal", { userId: user.id, authVersion: user.auth_version, sessionId: null, mode });
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  if (user.role !== "admin") throw new HttpError(403, "FORBIDDEN", "admin required");
  await next();
};

export function isAdmin(user: UserRow): boolean {
  return user.role === "admin";
}
