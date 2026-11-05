import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { HttpError } from "../lib/http-error";
import { parseBody } from "../lib/http";
import { newId } from "../lib/ids";
import { hashPassword, temporaryPassword, validatePassword } from "../lib/password";
import {
  hashIp,
  recordAuthEvent,
  requestFingerprint,
  revokeUserSessions,
  updatePassword,
} from "../lib/session";
import { nowIso } from "../lib/time";
import { requireAdmin, requireUser } from "../middleware/identity";
import { appBaseUrl, sendAndLogEmail, type EmailResult } from "../providers/email";
import type { UserRow } from "../types";
import { publicUser } from "./auth";

export const userRoutes = new Hono<AppEnv>();

const createUserSchema = z.object({
  email: z.string().email(),
  display_name: z.string().max(120).optional(),
  password: z.string().min(1).max(200),
  role: z.enum(["admin", "member"]).default("member"),
});

const inviteUserSchema = z.object({
  email: z.string().email(),
  display_name: z.string().max(120).optional(),
  role: z.enum(["admin", "member"]).default("member"),
  send_email: z.boolean().default(true),
});

const updateUserSchema = z.object({
  display_name: z.string().max(120).nullable().optional(),
  role: z.enum(["admin", "member"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

const resetPasswordSchema = z.object({
  password: z.string().min(1).max(200),
  must_change_password: z.boolean().default(true),
  send_email: z.boolean().default(false),
});

async function getInstanceName(db: D1Database): Promise<string> {
  try {
    const row = await db
      .prepare("SELECT v FROM instance_settings WHERE k = 'instance_name'")
      .first<{ v: string }>();
    return row?.v || "Boardroom";
  } catch {
    return "Boardroom";
  }
}

async function sendInviteEmail(
  c: Context<AppEnv>,
  user: UserRow,
  password: string,
): Promise<EmailResult> {
  const instanceName = await getInstanceName(c.env.DB);
  const base = appBaseUrl(c.env, c.req.url);
  return sendAndLogEmail(
    c.env,
    {
      to: user.email,
      subject: `${instanceName} 邀请你加入`,
      text: [
        "你好，",
        "",
        `管理员邀请你加入 ${instanceName}。`,
        "",
        `登录地址：${base}/`,
        `邮箱：${user.email}`,
        `临时密码：${password}`,
        "",
        "首次登录后需要修改密码。",
      ].join("\n"),
    },
    user.id,
  );
}

async function sendPasswordEmail(
  c: Context<AppEnv>,
  user: UserRow,
  password: string,
): Promise<EmailResult> {
  const instanceName = await getInstanceName(c.env.DB);
  const base = appBaseUrl(c.env, c.req.url);
  return sendAndLogEmail(
    c.env,
    {
      to: user.email,
      subject: `${instanceName} 密码已重置`,
      text: [
        "你好，",
        "",
        `你的 ${instanceName} 密码已被管理员重置。`,
        "",
        `登录地址：${base}/`,
        `邮箱：${user.email}`,
        `新临时密码：${password}`,
        "",
        "请登录后立即修改密码。",
      ].join("\n"),
    },
    user.id,
  );
}

async function assertLastAdminSafe(db: D1Database, target: UserRow, nextRole: string, nextStatus: string) {
  const losesAdmin = target.role === "admin" && target.status === "active" && (nextRole !== "admin" || nextStatus !== "active");
  if (!losesAdmin) return;
  const admins = await db
    .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'")
    .first<{ count: number }>();
  if ((admins?.count ?? 0) <= 1) {
    throw new HttpError(409, "LAST_ADMIN", "cannot disable or demote the last active admin");
  }
}

userRoutes.get("/users", requireUser, requireAdmin, async (c) => {
  const status = c.req.query("status");
  const role = c.req.query("role");
  const q = c.req.query("q")?.trim().toLowerCase();
  const filters: string[] = [];
  const bindings: unknown[] = [];

  if (status === "active" || status === "disabled") {
    filters.push(`status = ?${bindings.length + 1}`);
    bindings.push(status);
  }
  if (role === "admin" || role === "member") {
    filters.push(`role = ?${bindings.length + 1}`);
    bindings.push(role);
  }
  if (q) {
    filters.push(`(lower(email) LIKE ?${bindings.length + 1} OR lower(COALESCE(display_name,'')) LIKE ?${bindings.length + 1})`);
    bindings.push(`%${q}%`);
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = await c.env.DB.prepare(
    `SELECT * FROM users ${where} ORDER BY created_at DESC LIMIT 500`,
  )
    .bind(...bindings)
    .all<UserRow>();
  return c.json({ users: rows.results.map(publicUser) });
});

userRoutes.get("/users/:uid", requireUser, requireAdmin, async (c) => {
  const target = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?1")
    .bind(c.req.param("uid"))
    .first<UserRow>();
  if (!target) throw new HttpError(404, "NOT_FOUND", "user not found");

  const sessions = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM user_sessions WHERE user_id = ?1 AND revoked_at IS NULL AND expires_at > ?2",
  )
    .bind(target.id, nowIso())
    .first<{ count: number }>();
  const events = await c.env.DB.prepare(
    "SELECT event_type, ip_hash, user_agent, created_at FROM user_auth_events WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 20",
  )
    .bind(target.id)
    .all();

  return c.json({
    user: publicUser(target),
    active_sessions: sessions?.count ?? 0,
    auth_events: events.results,
  });
});

userRoutes.get("/users/:uid/auth-events", requireUser, requireAdmin, async (c) => {
  const target = await c.env.DB.prepare("SELECT id, email FROM users WHERE id = ?1")
    .bind(c.req.param("uid"))
    .first<{ id: string; email: string }>();
  if (!target) throw new HttpError(404, "NOT_FOUND", "user not found");
  const rows = await c.env.DB.prepare(
    "SELECT event_type, ip_hash, user_agent, created_at FROM user_auth_events WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 200",
  )
    .bind(target.id)
    .all();
  return c.json({ email: target.email, events: rows.results });
});

userRoutes.post("/users", requireUser, requireAdmin, async (c) => {
  const body = await parseBody(c, createUserSchema);
  const passwordError = validatePassword(body.password);
  if (passwordError) throw new HttpError(400, "INVALID_ARGUMENT", passwordError);

  const email = body.email.trim().toLowerCase();
  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind(email).first();
  if (existing) throw new HttpError(409, "CONFLICT", "user already exists");

  const now = nowIso();
  const user: UserRow = {
    id: newId("usr"),
    email,
    display_name: body.display_name?.trim() || null,
    role: body.role,
    status: "active",
    password_hash: await hashPassword(body.password),
    password_updated_at: now,
    must_change_password: 0,
    auth_version: 1,
    last_seen_at: null,
    created_at: now,
  };

  await c.env.DB.prepare(
    `INSERT INTO users
       (id, email, display_name, role, status, password_hash, password_updated_at,
        must_change_password, last_seen_at, created_at)
     VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, 0, NULL, ?6)`,
  )
    .bind(user.id, user.email, user.display_name, user.role, user.password_hash, now)
    .run();

  return c.json({ user: publicUser(user) }, 201);
});

userRoutes.post("/users/invite", requireUser, requireAdmin, async (c) => {
  const body = await parseBody(c, inviteUserSchema);
  const email = body.email.trim().toLowerCase();
  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind(email).first();
  if (existing) throw new HttpError(409, "CONFLICT", "user already exists");

  const now = nowIso();
  const password = temporaryPassword();
  const user: UserRow = {
    id: newId("usr"),
    email,
    display_name: body.display_name?.trim() || null,
    role: body.role,
    status: "active",
    password_hash: await hashPassword(password),
    password_updated_at: now,
    must_change_password: 1,
    auth_version: 1,
    last_seen_at: null,
    created_at: now,
  };

  await c.env.DB.prepare(
    `INSERT INTO users
       (id, email, display_name, role, status, password_hash, password_updated_at,
        must_change_password, last_seen_at, created_at)
     VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, 1, NULL, ?6)`,
  )
    .bind(user.id, user.email, user.display_name, user.role, user.password_hash, now)
    .run();

  const emailResult = body.send_email ? await sendInviteEmail(c, user, password) : null;
  return c.json(
    {
      user: publicUser(user),
      temporary_password: password,
      email: emailResult,
    },
    201,
  );
});

userRoutes.post("/users/:uid/invite", requireUser, requireAdmin, async (c) => {
  const target = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?1")
    .bind(c.req.param("uid"))
    .first<UserRow>();
  if (!target) throw new HttpError(404, "NOT_FOUND", "user not found");
  if (target.status !== "active") throw new HttpError(409, "CONFLICT", "user is disabled");

  const password = temporaryPassword();
  await updatePassword(c.env.DB, target, await hashPassword(password), true);

  const emailResult = await sendInviteEmail(c, target, password);
  return c.json({
    user: publicUser({ ...target, password_hash: null, must_change_password: 1 }),
    temporary_password: password,
    email: emailResult,
  });
});

userRoutes.patch("/users/:uid", requireUser, requireAdmin, async (c) => {
  const target = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?1")
    .bind(c.req.param("uid"))
    .first<UserRow>();
  if (!target) throw new HttpError(404, "NOT_FOUND", "user not found");
  const body = await parseBody(c, updateUserSchema);

  const nextRole = body.role ?? target.role;
  const nextStatus = body.status ?? target.status;
  await assertLastAdminSafe(c.env.DB, target, nextRole, nextStatus);

  const changedIdentity = nextRole !== target.role || nextStatus !== target.status;
  const results = await c.env.DB.batch([c.env.DB.prepare(
    `UPDATE users SET display_name = ?1, role = ?2, status = ?3, auth_version = auth_version + ?5
      WHERE id = ?4 AND auth_version = ?6
      AND (role <> 'admin' OR status <> 'active' OR (?2 = 'admin' AND ?3 = 'active')
        OR (SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = 'active') > 1)`,
  )
    .bind(
      body.display_name === undefined ? target.display_name : body.display_name,
      nextRole,
      nextStatus,
      target.id,
      changedIdentity ? 1 : 0,
      target.auth_version,
    )
    , c.env.DB.prepare(`UPDATE user_sessions SET revoked_at = ?1
      WHERE user_id = ?2 AND revoked_at IS NULL AND ?3 = 1 AND changes() = 1`)
      .bind(nowIso(), target.id, changedIdentity ? 1 : 0)]);
  if (results[0].meta.changes !== 1) throw new HttpError(409, "CONFLICT", "user changed or is the last active admin");

  const updated = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?1")
    .bind(target.id)
    .first<UserRow>();
  return c.json({ user: publicUser(updated ?? { ...target, role: nextRole, status: nextStatus }) });
});

userRoutes.delete("/users/:uid", requireUser, requireAdmin, async (c) => {
  const target = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?1")
    .bind(c.req.param("uid"))
    .first<UserRow>();
  if (!target) throw new HttpError(404, "NOT_FOUND", "user not found");
  const actor = c.get("user");
  if (target.id === actor.id) throw new HttpError(409, "CONFLICT", "cannot disable yourself");
  await assertLastAdminSafe(c.env.DB, target, target.role, "disabled");

  const results = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE users SET status = 'disabled', auth_version = auth_version + 1
      WHERE id = ?1 AND auth_version = ?2 AND (role <> 'admin' OR status <> 'active'
        OR (SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = 'active') > 1)`)
      .bind(target.id, target.auth_version),
    c.env.DB.prepare(`UPDATE user_sessions SET revoked_at = ?1 WHERE user_id = ?2
      AND revoked_at IS NULL AND changes() = 1`).bind(nowIso(), target.id),
  ]);
  if (results[0].meta.changes !== 1) throw new HttpError(409, "CONFLICT", "user changed or is the last active admin");
  return c.json({ ok: true, soft_deleted: true });
});

userRoutes.post("/users/:uid/revoke-sessions", requireUser, requireAdmin, async (c) => {
  const target = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?1")
    .bind(c.req.param("uid"))
    .first<UserRow>();
  if (!target) throw new HttpError(404, "NOT_FOUND", "user not found");
  await revokeUserSessions(c.env.DB, target.id);
  const fp = requestFingerprint(c);
  await recordAuthEvent(c.env.DB, {
    userId: target.id,
    email: target.email,
    eventType: "session_revoked",
    ipHash: await hashIp(c, fp.ip),
    userAgent: fp.userAgent,
  });
  return c.json({ ok: true });
});

userRoutes.post("/users/:uid/password", requireUser, requireAdmin, async (c) => {
  const target = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?1")
    .bind(c.req.param("uid"))
    .first<UserRow>();
  if (!target) throw new HttpError(404, "NOT_FOUND", "user not found");
  const body = await parseBody(c, resetPasswordSchema);
  const passwordError = validatePassword(body.password);
  if (passwordError) throw new HttpError(400, "INVALID_ARGUMENT", passwordError);

  await updatePassword(c.env.DB, target, await hashPassword(body.password), body.must_change_password, false);

  const fp = requestFingerprint(c);
  await recordAuthEvent(c.env.DB, {
    userId: target.id,
    email: target.email,
    eventType: "password_reset",
    ipHash: await hashIp(c, fp.ip),
    userAgent: fp.userAgent,
  });

  const emailResult = body.send_email ? await sendPasswordEmail(c, target, body.password) : null;
  return c.json({
    ok: true,
    user: publicUser({
      ...target,
      password_hash: null,
      must_change_password: body.must_change_password ? 1 : 0,
    }),
    email: emailResult,
  });
});
