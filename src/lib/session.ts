import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { randomSecret, sha256Hex } from "./crypto";
import { newId } from "./ids";
import { addDaysIso, nowIso } from "./time";
import type { UserRow } from "../types";
import { HttpError } from "./http-error";

const COOKIE_NAME = "boardroom_session";
const TTL_DAYS = 7;
const REFRESH_AFTER_MS = 60 * 60 * 1000;

export interface AuthPrincipal {
  userId: string;
  authVersion: number;
  sessionId: string | null;
  mode: "session" | "access" | "development";
}

interface SessionRow extends UserRow {
  session_id: string;
  session_expires_at: string;
  session_last_seen_at: string | null;
}

function isSecure(c: Context<AppEnv>): boolean {
  return new URL(c.req.url).protocol === "https:";
}

function setSessionCookie(c: Context<AppEnv>, token: string): void {
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true, secure: isSecure(c), sameSite: "Lax", path: "/",
    maxAge: TTL_DAYS * 24 * 60 * 60,
  });
}

export function requestFingerprint(c: Context<AppEnv>): {
  ip: string | null;
  userAgent: string | null;
} {
  return {
    ip:
      c.req.header("CF-Connecting-IP") ??
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
      null,
    userAgent: c.req.header("User-Agent")?.slice(0, 300) ?? null,
  };
}

export async function hashIp(c: Context<AppEnv>, ip: string | null): Promise<string | null> {
  return ip ? sha256Hex(`${ip}${c.env.TOKEN_PEPPER}`) : null;
}

export async function createSession(c: Context<AppEnv>, user: UserRow): Promise<void> {
  const token = randomSecret(32);
  const tokenHash = await sha256Hex(`${token}${c.env.TOKEN_PEPPER}`);
  const fp = requestFingerprint(c);
  const ipHash = await hashIp(c, fp.ip);
  const now = nowIso();
  const expiresAt = addDaysIso(TTL_DAYS);

  const result = await c.env.DB.prepare(
    `INSERT INTO user_sessions
       (id, user_id, token_hash, user_agent, ip_hash, created_at, last_seen_at, expires_at, auth_version)
     SELECT ?1, id, ?3, ?4, ?5, ?6, ?6, ?7, auth_version FROM users
      WHERE id = ?2 AND auth_version = ?8 AND status = 'active'`,
  )
    .bind(newId("ses"), user.id, tokenHash, fp.userAgent, ipHash, now, expiresAt, user.auth_version)
    .run();

  if (result.meta.changes !== 1) {
    throw new HttpError(401, "INVALID_CREDENTIALS", "credentials changed; sign in again");
  }

  setSessionCookie(c, token);
}

export async function readSession(c: Context<AppEnv>): Promise<UserRow | null> {
  const token = getCookie(c, COOKIE_NAME);
  if (!token) return null;
  const tokenHash = await sha256Hex(`${token}${c.env.TOKEN_PEPPER}`);
  const row = await c.env.DB.prepare(
    `SELECT s.id AS session_id, s.expires_at AS session_expires_at,
            s.last_seen_at AS session_last_seen_at, u.*
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?1
        AND s.revoked_at IS NULL
        AND s.expires_at > ?2
        AND s.auth_version = u.auth_version
        AND u.status = 'active'`,
  )
    .bind(tokenHash, nowIso())
    .first<SessionRow>();

  if (!row) {
    clearSessionCookie(c);
    return null;
  }

  c.set("principal", { userId: row.id, authVersion: row.auth_version, sessionId: row.session_id, mode: "session" });

  const lastSeen = row.session_last_seen_at ? Date.parse(row.session_last_seen_at) : 0;
  if (!lastSeen || Date.now() - lastSeen > REFRESH_AFTER_MS) {
    const nextExpiry = addDaysIso(TTL_DAYS);
    const refreshed = await c.env.DB.prepare(
        `UPDATE user_sessions SET last_seen_at = ?1, expires_at = ?2
          WHERE id = ?3 AND revoked_at IS NULL AND expires_at > ?1
            AND auth_version = ?4 AND EXISTS (SELECT 1 FROM users u
              WHERE u.id = user_sessions.user_id AND u.auth_version = ?4 AND u.status = 'active')`,
      )
        .bind(nowIso(), nextExpiry, row.session_id, row.auth_version)
        .run()
        .catch(() => null);
    if (refreshed?.meta.changes === 1) setSessionCookie(c, token);
  }

  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    role: row.role,
    status: row.status,
    password_hash: row.password_hash,
    password_updated_at: row.password_updated_at,
    must_change_password: row.must_change_password,
    auth_version: row.auth_version,
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
  };
}

export async function revokeCurrentSession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, COOKIE_NAME);
  if (token) {
    const tokenHash = await sha256Hex(`${token}${c.env.TOKEN_PEPPER}`);
    await c.env.DB.prepare(
      "UPDATE user_sessions SET revoked_at = ?1 WHERE token_hash = ?2 AND revoked_at IS NULL",
    )
      .bind(nowIso(), tokenHash)
      .run();
  }
  clearSessionCookie(c);
}

export async function revokeUserSessions(
  db: D1Database,
  userId: string,
): Promise<void> {
  await db.batch([
    db.prepare("UPDATE users SET auth_version = auth_version + 1 WHERE id = ?1").bind(userId),
    db.prepare("UPDATE user_sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL").bind(nowIso(), userId),
  ]);
}

/** Password CAS and invalidation share a transaction; stale verifications never win. */
export async function updatePassword(
  db: D1Database, user: UserRow, passwordHash: string, mustChange: boolean,
  requireActive = true,
): Promise<void> {
  const now = nowIso();
  const results = await db.batch([
    db.prepare(`UPDATE users SET password_hash = ?1, password_updated_at = ?2,
      must_change_password = ?3, auth_version = auth_version + 1
      WHERE id = ?4 AND auth_version = ?5 AND (?6 = 0 OR status = 'active')`)
      .bind(passwordHash, now, mustChange ? 1 : 0, user.id, user.auth_version, requireActive ? 1 : 0),
    db.prepare(`UPDATE user_sessions SET revoked_at = ?1
      WHERE user_id = ?2 AND revoked_at IS NULL AND changes() = 1`).bind(now, user.id),
  ]);
  if (results[0].meta.changes !== 1) {
    throw new HttpError(409, "CONFLICT", "credentials changed; reload and try again");
  }
}

/** Used for every SSE replay/broadcast and heartbeat, including individual logout. */
export async function principalCanReadProject(db: D1Database, principal: AuthPrincipal, projectId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT u.id FROM users u
    WHERE u.id = ?1 AND u.auth_version = ?2 AND u.status = 'active' AND u.must_change_password = 0
      AND EXISTS (SELECT 1 FROM projects p WHERE p.id = ?3 AND p.archived_at IS NULL)
      AND (u.role = 'admin' OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = ?3 AND pm.user_id = u.id))
      AND (?4 IS NULL OR EXISTS (SELECT 1 FROM user_sessions s WHERE s.id = ?4 AND s.user_id = u.id
        AND s.auth_version = u.auth_version AND s.revoked_at IS NULL AND s.expires_at > ?5))`)
    .bind(principal.userId, principal.authVersion, projectId, principal.sessionId, nowIso()).first();
  return Boolean(row);
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
}

export async function recordAuthEvent(
  db: D1Database,
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
    ipHash?: string | null;
    userAgent?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_auth_events (user_id, email, event_type, ip_hash, user_agent, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(
      input.userId,
      input.email,
      input.eventType,
      input.ipHash ?? null,
      input.userAgent ?? null,
      nowIso(),
    )
    .run();
}
