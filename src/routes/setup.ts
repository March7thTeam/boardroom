import { bootstrapClaim } from "../lib/bootstrap";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { HttpError } from "../lib/http-error";
import { parseBody } from "../lib/http";
import { newId } from "../lib/ids";
import { hashPassword, validatePassword } from "../lib/password";
import { issueEnrollmentToken } from "../lib/project-token";
import {
  createSession,
  hashIp,
  recordAuthEvent,
  requestFingerprint,
} from "../lib/session";
import { nowIso } from "../lib/time";
import type { ProjectRow, UserRow } from "../types";
import { publicUser } from "./auth";

export const setupRoutes = new Hono<AppEnv>();

const setupSchema = z.object({
  instance_name: z.string().min(1).max(80),
  admin: z.object({
    email: z.string().email(),
    password: z.string().min(1).max(200),
    display_name: z.string().max(120).optional(),
  }),
  project: z
    .object({
      slug: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
      name: z.string().min(1).max(120),
      verification_mode: z.enum(["human", "rule"]).default("human"),
    })
    .optional(),
});

const DEFAULT_INSTANCE_NAME = "Boardroom";

async function userCount(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM instance_settings WHERE k = 'bootstrap_claim') AS count").first<{ count: number }>();
  return row?.count ?? 0;
}

async function getInstanceName(db: D1Database): Promise<string> {
  const row = await db
    .prepare("SELECT v FROM instance_settings WHERE k = 'instance_name'")
    .first<{ v: string }>();
  return row?.v || DEFAULT_INSTANCE_NAME;
}

setupRoutes.get("/setup/status", async (c) => {
  return c.json({
    needs_setup: (await userCount(c.env.DB)) === 0,
    instance_name: await getInstanceName(c.env.DB),
    auth_mode: c.env.AUTH_MODE ?? "session",
  });
});

setupRoutes.get("/instance", async (c) => {
  return c.json({ instance_name: await getInstanceName(c.env.DB) });
});

setupRoutes.post("/setup", async (c) => {
  if ((await userCount(c.env.DB)) > 0) {
    throw new HttpError(409, "SETUP_COMPLETED", "instance is already configured");
  }

  const body = await parseBody(c, setupSchema);
  const passwordError = validatePassword(body.admin.password);
  if (passwordError) throw new HttpError(400, "INVALID_ARGUMENT", passwordError);
  const instanceName = body.instance_name.trim();
  if (!instanceName) throw new HttpError(400, "INVALID_ARGUMENT", "instance name is required");

  const now = nowIso();
  const admin: UserRow = {
    id: newId("usr"),
    email: body.admin.email.trim().toLowerCase(),
    display_name: body.admin.display_name?.trim() || null,
    role: "admin",
    status: "active",
    password_hash: await hashPassword(body.admin.password),
    password_updated_at: now,
    must_change_password: 0,
    auth_version: 1,
    last_seen_at: now,
    created_at: now,
  };

  let project: ProjectRow | null = null;
  if (body.project) {
    project = {
      id: newId("prj"),
      slug: body.project.slug,
      name: body.project.name,
      verification_mode: body.project.verification_mode,
      exec_targets_json: "[]",
      created_by: admin.id,
      created_at: now,
      archived_at: null,
      archived_by: null,
      archive_reason: null,
    };
  }

  const statements = [
    bootstrapClaim(c.env.DB, admin.id),
    c.env.DB.prepare(
      `INSERT INTO users
         (id, email, display_name, role, status, password_hash, password_updated_at,
          must_change_password, last_seen_at, created_at)
       VALUES (?1, ?2, ?3, 'admin', 'active', ?4, ?5, 0, ?5, ?5)`,
    ).bind(admin.id, admin.email, admin.display_name, admin.password_hash, now),
    c.env.DB.prepare(
      `INSERT INTO instance_settings (k, v, updated_at) VALUES ('instance_name', ?1, ?2)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
    ).bind(instanceName, now),
    c.env.DB.prepare(
      `INSERT INTO instance_settings (k, v, updated_at) VALUES ('setup_completed_at', ?1, ?1)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
    ).bind(now),
  ];

  if (project) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO projects
           (id, slug, name, verification_mode, exec_targets_json, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      ).bind(
        project.id,
        project.slug,
        project.name,
        project.verification_mode,
        project.exec_targets_json,
        project.created_by,
        project.created_at,
      ),
      c.env.DB.prepare(
        `INSERT INTO project_members (project_id, user_id, role, added_by, added_at)
         VALUES (?1, ?2, 'owner', ?2, ?3)`,
      ).bind(project.id, admin.id, now),
    );
  }

  try {
    await c.env.DB.batch(statements);
  } catch {
    throw new HttpError(409, "CONFLICT", "setup failed: project slug or admin email already exists");
  }

  let enrollmentToken: string | null = null;
  if (project) {
    enrollmentToken = await issueEnrollmentToken(
      c.env.DB,
      project.id,
      admin.id,
      c.env.TOKEN_PEPPER,
    );
  }

  const fp = requestFingerprint(c);
  await recordAuthEvent(c.env.DB, {
    userId: admin.id,
    email: admin.email,
    eventType: "bootstrap",
    ipHash: await hashIp(c, fp.ip),
    userAgent: fp.userAgent,
  });
  await createSession(c, admin);

  return c.json(
    {
      user: publicUser(admin),
      instance_name: instanceName,
      project: project
        ? {
            id: project.id,
            slug: project.slug,
            name: project.name,
            role: "owner",
            verification_mode: project.verification_mode,
          }
        : null,
      enrollment_token: enrollmentToken,
    },
    201,
  );
});
