import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { HttpError } from "../lib/http-error";
import { parseBody } from "../lib/http";
import { newId } from "../lib/ids";
import { bootstrapClaim } from "../lib/bootstrap";
import { hashPassword, validatePassword, verifyPassword } from "../lib/password";
import {
  createSession,
  hashIp,
  readSession,
  recordAuthEvent,
  requestFingerprint,
  revokeCurrentSession,
  updatePassword,
} from "../lib/session";
import { nowIso } from "../lib/time";
import { requireUser } from "../middleware/identity";
import type { UserRow } from "../types";

export const authRoutes = new Hono<AppEnv>();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

const bootstrapSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
  display_name: z.string().max(120).optional(),
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(200),
  new_password: z.string().min(1).max(200),
});

const MAX_FAILED_LOGINS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export function publicUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
    status: user.status,
    must_change_password: user.must_change_password === 1,
    created_at: user.created_at,
    last_seen_at: user.last_seen_at,
  };
}

async function authEvent(
  c: Parameters<typeof parseBody>[0],
  input: {
    userId: string | null;
    email: string;
    eventType:
      | "bootstrap"
      | "login_success"
      | "login_failed"
      | "logout"
      | "password_changed"
      | "password_reset"
      | "session_revoked";
  },
): Promise<void> {
  const fp = requestFingerprint(c);
  await recordAuthEvent(c.env.DB, {
    ...input,
    ipHash: await hashIp(c, fp.ip),
    userAgent: fp.userAgent,
  });
}

authRoutes.get("/auth/status", async (c) => {
  const count = await c.env.DB.prepare("SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM instance_settings WHERE k = 'bootstrap_claim') AS count").first<{ count: number }>();
  return c.json({
    needs_bootstrap: (count?.count ?? 0) === 0,
    auth_mode: c.env.AUTH_MODE ?? "session",
  });
});

authRoutes.post("/auth/bootstrap", async (c) => {
  const count = await c.env.DB.prepare("SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM instance_settings WHERE k = 'bootstrap_claim') AS count").first<{ count: number }>();
  if ((count?.count ?? 0) > 0) {
    throw new HttpError(409, "BOOTSTRAP_COMPLETED", "bootstrap already completed");
  }

  const body = await parseBody(c, bootstrapSchema);
  const passwordError = validatePassword(body.password);
  if (passwordError) throw new HttpError(400, "INVALID_ARGUMENT", passwordError);

  const email = body.email.trim().toLowerCase();
  const now = nowIso();
  const user: UserRow = {
    id: newId("usr"),
    email,
    display_name: body.display_name?.trim() || null,
    role: "admin",
    status: "active",
    password_hash: await hashPassword(body.password),
    password_updated_at: now,
    must_change_password: 0,
    auth_version: 1,
    last_seen_at: now,
    created_at: now,
  };

  try {
    await c.env.DB.batch([bootstrapClaim(c.env.DB, user.id), c.env.DB.prepare(
      `INSERT INTO users
         (id, email, display_name, role, status, password_hash, password_updated_at,
          must_change_password, last_seen_at, created_at)
       VALUES (?1, ?2, ?3, 'admin', 'active', ?4, ?5, 0, ?5, ?5)`,
    )
      .bind(user.id, user.email, user.display_name, user.password_hash, now)]);
  } catch {
    throw new HttpError(409, "BOOTSTRAP_COMPLETED", "bootstrap already completed");
  }

  await authEvent(c, { userId: user.id, email: user.email, eventType: "bootstrap" });
  await createSession(c, user);
  return c.json({ user: publicUser(user), must_change_password: false }, 201);
});

authRoutes.post("/auth/login", async (c) => {
  const body = await parseBody(c, loginSchema);
  const email = body.email.trim().toLowerCase();
  const cutoff = new Date(Date.now() - LOGIN_WINDOW_MS).toISOString();

  const failures = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM user_auth_events
      WHERE email = ?1 AND event_type = 'login_failed' AND created_at > ?2`,
  )
    .bind(email, cutoff)
    .first<{ count: number }>();
  if ((failures?.count ?? 0) >= MAX_FAILED_LOGINS) {
    throw new HttpError(429, "RATE_LIMITED", "too many failed login attempts, try again later");
  }

  const user = await c.env.DB.prepare("SELECT * FROM users WHERE email = ?1").bind(email).first<UserRow>();
  const ok = user ? await verifyPassword(body.password, user.password_hash) : false;
  if (!user || !ok) {
    await authEvent(c, { userId: user?.id ?? null, email, eventType: "login_failed" });
    throw new HttpError(401, "INVALID_CREDENTIALS", "invalid email or password");
  }
  if (user.status !== "active") {
    await authEvent(c, { userId: user.id, email, eventType: "login_failed" });
    throw new HttpError(403, "USER_DISABLED", "user is disabled");
  }

  await createSession(c, user);
  await c.env.DB.prepare("UPDATE users SET last_seen_at = ?1 WHERE id = ?2").bind(nowIso(), user.id).run();
  await authEvent(c, { userId: user.id, email, eventType: "login_success" });
  return c.json({
    user: publicUser(user),
    must_change_password: user.must_change_password === 1,
  });
});

authRoutes.post("/auth/logout", async (c) => {
  const user = await readSession(c);
  if (user) {
    await authEvent(c, { userId: user.id, email: user.email, eventType: "logout" });
  }
  await revokeCurrentSession(c);
  return c.json({ ok: true });
});

authRoutes.get("/auth/me", requireUser, async (c) => {
  return c.json({ user: publicUser(c.get("user")) });
});

authRoutes.post("/auth/password", requireUser, async (c) => {
  const user = c.get("user");
  const body = await parseBody(c, changePasswordSchema);
  if (!(await verifyPassword(body.current_password, user.password_hash))) {
    throw new HttpError(401, "CURRENT_PASSWORD_INCORRECT", "current password is incorrect");
  }
  const passwordError = validatePassword(body.new_password);
  if (passwordError) throw new HttpError(400, "INVALID_ARGUMENT", passwordError);
  if (body.current_password === body.new_password) {
    throw new HttpError(400, "INVALID_ARGUMENT", "new password must differ from current password");
  }

  await updatePassword(c.env.DB, user, await hashPassword(body.new_password), false);
  await authEvent(c, { userId: user.id, email: user.email, eventType: "password_changed" });
  await revokeCurrentSession(c);
  return c.json({ ok: true, reauth_required: true });
});

