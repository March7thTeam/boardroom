import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { newId } from "../lib/ids";
import { nowIso } from "../lib/time";
import { resolveProjectAgentReference } from "../domain/agent-projects";
import { agentActivationQuotaPredicate, rejectAgentStatusUpdate } from "../domain/agent-quota";
import { issueEnrollmentToken } from "../lib/project-token";
import { parseBody } from "../lib/http";
import { HttpError } from "../lib/http-error";
import { isAdmin, requireUser } from "../middleware/identity";
import {
  loadProjectIncludingArchived,
  requireProjectMember,
  requireProjectOwner,
} from "../middleware/project";
import { listVisibleProjects } from "../domain/project-visibility";
import type { ProjectRow, UserRow } from "../types";

export const projectRoutes = new Hono<AppEnv>();

const createProjectSchema = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, "slug must match ^[a-z][a-z0-9-]{1,30}$"),
  name: z.string().min(1).max(120),
  verification_mode: z.enum(["human", "rule"]).default("human"),
  exec_targets: z
    .array(
      z.object({
        provider: z.string().min(1),
        owner: z.string().min(1),
        repo: z.string().min(1),
        workflows: z.array(z.string().min(1)).min(1),
      }),
    )
    .default([]),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  verification_mode: z.enum(["human", "rule"]).optional(),
  exec_targets: z
    .array(
      z.object({
        provider: z.string().min(1),
        owner: z.string().min(1),
        repo: z.string().min(1),
        workflows: z.array(z.string().min(1)).min(1),
      }),
    )
    .optional(),
});

const addMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(["owner", "admin", "member"]).default("member"),
});

const updateMemberSchema = z.object({
  role: z.enum(["owner", "admin", "member"]),
});

const transferOwnerSchema = z.object({
  user_id: z.string().min(1),
});

/** A project has exactly one owner (issue #14); ownership changes hands via transfer. */
function singleOwnerError(): HttpError {
  return new HttpError(
    409,
    "SINGLE_OWNER",
    "a project has exactly one owner; use POST /projects/:pid/owner to transfer ownership",
  );
}

const archiveProjectSchema = z.object({
  confirm_slug: z.string().min(1).max(200),
  reason: z.string().trim().max(500).optional(),
});

const purgeProjectSchema = z.object({
  confirm_slug: z.string().min(1).max(200),
});

const agentStatusSchema = z.object({
  status: z.enum(["active", "disabled"]),
});

type ProjectMemberRole = "owner" | "admin" | "member";

type ProjectMemberRow = {
  id: string;
  email: string;
  display_name: string | null;
  global_role: "admin" | "member";
  global_status: "active" | "disabled";
  role: ProjectMemberRole;
  added_at: string;
};

const projectMemberSelect = `SELECT u.id, u.email, u.display_name, u.role AS global_role,
        u.status AS global_status, pm.role, pm.added_at
   FROM project_members pm
   JOIN users u ON u.id = pm.user_id
  WHERE pm.project_id = ?1`;

async function loadProjectMember(
  db: D1Database,
  projectId: string,
  userId: string,
): Promise<ProjectMemberRow | null> {
  return db
    .prepare(`${projectMemberSelect} AND pm.user_id = ?2`)
    .bind(projectId, userId)
    .first<ProjectMemberRow>();
}

async function countProjectOwners(db: D1Database, projectId: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM project_members WHERE project_id = ?1 AND role = 'owner'",
    )
    .bind(projectId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function assertNotLastOwner(
  db: D1Database,
  projectId: string,
  currentRole: ProjectMemberRole,
  nextRole: ProjectMemberRole,
): Promise<void> {
  if (currentRole !== "owner" || nextRole === "owner") return;
  if ((await countProjectOwners(db, projectId)) <= 1) {
    throw new HttpError(409, "LAST_OWNER", "cannot demote or remove the last project owner");
  }
}

/**
 * `access` tells how the caller reaches the project: as a listed member, or as
 * an instance admin without membership (implicit owner, issue #5).
 */
function projectSummary(
  project: ProjectRow,
  role: ProjectMemberRole,
  access: "member" | "admin" = "member",
) {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    verification_mode: project.verification_mode,
    exec_targets_json: project.exec_targets_json,
    created_at: project.created_at,
    archived_at: project.archived_at,
    role,
    access,
  };
}

/** `archived-<original slug>-<8 char suffix>`; the suffix makes the slug unique. */
function archivedSlug(slug: string): string {
  return `archived-${slug}-${newId("").slice(-8).toLowerCase()}`;
}

function originalSlugFromArchived(slug: string): string | null {
  if (!slug.startsWith("archived-")) return null;
  const rest = slug.slice("archived-".length);
  const separator = rest.lastIndexOf("-");
  if (separator <= 0) return null;
  const suffix = rest.slice(separator + 1);
  if (!/^[0-9a-z]{8}$/.test(suffix)) return null;
  return rest.slice(0, separator);
}

async function chooseRestoredSlug(
  db: D1Database,
  project: ProjectRow,
): Promise<string> {
  const original = originalSlugFromArchived(project.slug) ?? `${project.slug}-restored`;
  const conflict = await db
    .prepare("SELECT id FROM projects WHERE slug = ?1 AND id <> ?2")
    .bind(original, project.id)
    .first<{ id: string }>();
  if (!conflict) return original;
  return `${original}-${newId("").slice(-6).toLowerCase()}`;
}

async function projectRoleForUser(
  db: D1Database,
  projectId: string,
  user: UserRow,
): Promise<ProjectMemberRole | null> {
  const membership = await db
    .prepare("SELECT role FROM project_members WHERE project_id = ?1 AND user_id = ?2")
    .bind(projectId, user.id)
    .first<{ role: ProjectMemberRole }>();
  if (membership) return membership.role;
  return isAdmin(user) ? "owner" : null;
}

projectRoutes.get("/projects", requireUser, async (c) => {
  const user = c.get("user");
  const rows = await listVisibleProjects(c.env.DB, user);
  return c.json({
    projects: rows.map((row) => projectSummary(row, row.role, row.access)),
  });
});

projectRoutes.post("/projects", requireUser, async (c) => {
  const user = c.get("user");
  if (!isAdmin(user)) throw new HttpError(403, "FORBIDDEN", "admin required");
  const body = await parseBody(c, createProjectSchema);

  const existing = await c.env.DB.prepare("SELECT id FROM projects WHERE slug = ?1").bind(body.slug).first();
  if (existing) throw new HttpError(409, "CONFLICT", "project slug already exists");

  const project: ProjectRow = {
    id: newId("prj"),
    slug: body.slug,
    name: body.name,
    verification_mode: body.verification_mode,
    exec_targets_json: JSON.stringify(body.exec_targets),
    created_by: user.id,
    created_at: nowIso(),
    archived_at: null,
    archived_by: null,
    archive_reason: null,
  };

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO projects (id, slug, name, verification_mode, exec_targets_json, created_by, created_at)
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
    ).bind(project.id, user.id, project.created_at),
  ]);

  const enrollmentToken = await issueEnrollmentToken(c.env.DB, project.id, user.id, c.env.TOKEN_PEPPER);
  return c.json({ project: projectSummary(project, "owner"), enrollment_token: enrollmentToken }, 201);
});

projectRoutes.get("/projects/archived", requireUser, async (c) => {
  const user = c.get("user");
  const rows = isAdmin(user)
    ? await c.env.DB.prepare(
        `SELECT p.*, 'owner' AS role, u.email AS archived_by_email
           FROM projects p
           LEFT JOIN users u ON u.id = p.archived_by
          WHERE p.archived_at IS NOT NULL
          ORDER BY p.archived_at DESC`,
      ).all<ProjectRow & { role: "owner"; archived_by_email: string | null }>()
    : await c.env.DB.prepare(
        `SELECT p.*, pm.role, u.email AS archived_by_email
           FROM projects p
           JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?1 AND pm.role = 'owner'
           LEFT JOIN users u ON u.id = p.archived_by
          WHERE p.archived_at IS NOT NULL
          ORDER BY p.archived_at DESC`,
      )
        .bind(user.id)
        .all<ProjectRow & { role: ProjectMemberRole; archived_by_email: string | null }>();

  return c.json({
    projects: rows.results.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      archived_at: row.archived_at,
      archived_by_email: row.archived_by_email,
      archive_reason: row.archive_reason,
      role: row.role,
      original_slug: originalSlugFromArchived(row.slug),
    })),
  });
});

projectRoutes.post("/projects/:pid/archive", requireUser, async (c) => {
  const user = c.get("user");
  const project = await loadProjectIncludingArchived(c, c.req.param("pid")!);
  const role = await projectRoleForUser(c.env.DB, project.id, user);
  if (!role) throw new HttpError(404, "NOT_FOUND", "project not found");
  if (role !== "owner") throw new HttpError(403, "FORBIDDEN", "project owner required");
  if (project.archived_at) throw new HttpError(409, "ALREADY_ARCHIVED", "project is already archived");

  const body = await parseBody(c, archiveProjectSchema);
  const originalSlug = originalSlugFromArchived(project.slug) ?? project.slug;
  if (body.confirm_slug !== project.slug && body.confirm_slug !== originalSlug) {
    throw new HttpError(400, "CONFIRM_SLUG_MISMATCH", "confirm_slug does not match the project slug");
  }

  const now = nowIso();
  const nextSlug = archivedSlug(project.slug);
  const reason = body.reason?.trim() ? body.reason.trim() : null;
  const updated = await c.env.DB.prepare(
    `UPDATE projects
        SET archived_at = ?1, archived_by = ?2, archive_reason = ?3, slug = ?4
      WHERE id = ?5 AND archived_at IS NULL`,
  )
    .bind(now, user.id, reason, nextSlug, project.id)
    .run();
  if ((updated.meta.changes ?? 0) === 0) {
    throw new HttpError(409, "ALREADY_ARCHIVED", "project is already archived");
  }

  await c.env.DB.prepare(
    `UPDATE project_join_requests
        SET status = 'rejected', decided_by = ?2, decided_at = ?3
      WHERE project_id = ?1 AND status = 'pending'`,
  )
    .bind(project.id, user.id, now)
    .run();

  try {
    await c.env.BOARD_DO.getByName(project.id).closeConnections();
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        job: "project_archive",
        project_id: project.id,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  return c.json({
    project: projectSummary(
      { ...project, slug: nextSlug, archived_at: now, archived_by: user.id, archive_reason: reason },
      "owner",
    ),
    original_slug: project.slug,
  });
});

projectRoutes.post("/projects/:pid/restore", requireUser, async (c) => {
  const user = c.get("user");
  const project = await loadProjectIncludingArchived(c, c.req.param("pid")!);
  const role = await projectRoleForUser(c.env.DB, project.id, user);
  if (!role) throw new HttpError(404, "NOT_FOUND", "project not found");
  if (role !== "owner") throw new HttpError(403, "FORBIDDEN", "project owner required");
  if (!project.archived_at) {
    throw new HttpError(409, "PROJECT_NOT_ARCHIVED", "project is not archived");
  }

  const nextSlug = await chooseRestoredSlug(c.env.DB, project);
  const updated = await c.env.DB.prepare(
    `UPDATE projects
        SET archived_at = NULL, archived_by = NULL, archive_reason = NULL, slug = ?1
      WHERE id = ?2 AND archived_at IS NOT NULL`,
  )
    .bind(nextSlug, project.id)
    .run();
  if ((updated.meta.changes ?? 0) === 0) {
    throw new HttpError(409, "PROJECT_NOT_ARCHIVED", "project is not archived");
  }

  return c.json({
    project: projectSummary(
      { ...project, slug: nextSlug, archived_at: null, archived_by: null, archive_reason: null },
      role,
    ),
  });
});

projectRoutes.delete("/projects/:pid", requireUser, async (c) => {
  const user = c.get("user");
  if (!isAdmin(user)) throw new HttpError(403, "FORBIDDEN", "instance admin required");
  const project = await loadProjectIncludingArchived(c, c.req.param("pid")!);
  if (!project.archived_at) {
    throw new HttpError(409, "PROJECT_NOT_ARCHIVED", "project must be archived before permanent deletion");
  }

  const body = await parseBody(c, purgeProjectSchema);
  const originalSlug = originalSlugFromArchived(project.slug);
  if (body.confirm_slug !== project.slug && body.confirm_slug !== originalSlug) {
    throw new HttpError(400, "CONFIRM_SLUG_MISMATCH", "confirm_slug does not match the project slug");
  }

  const pid = project.id;
  const cardScope = "SELECT id FROM cards WHERE project_id = ?1";

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM event_outbox WHERE project_id = ?1").bind(pid),
    c.env.DB.prepare("DELETE FROM project_event_heads WHERE project_id = ?1").bind(pid),
    c.env.DB.prepare(`DELETE FROM interventions WHERE card_id IN (${cardScope})`).bind(pid),
    c.env.DB.prepare(`DELETE FROM evidence WHERE card_id IN (${cardScope})`).bind(pid),
    c.env.DB.prepare(`DELETE FROM attempts WHERE card_id IN (${cardScope})`).bind(pid),
    c.env.DB.prepare(`DELETE FROM contracts WHERE card_id IN (${cardScope})`).bind(pid),
    c.env.DB.prepare(
      `DELETE FROM proposals
        WHERE session_id IN (
          SELECT id FROM negotiation_sessions WHERE card_id IN (${cardScope})
        )`,
    ).bind(pid),
    c.env.DB.prepare(
      `DELETE FROM negotiation_sessions WHERE card_id IN (${cardScope})`,
    ).bind(pid),
    c.env.DB.prepare(
      `DELETE FROM card_deps
        WHERE card_id IN (${cardScope}) OR depends_on_card_id IN (${cardScope})`,
    ).bind(pid),
    c.env.DB.prepare("DELETE FROM card_events WHERE project_id = ?1").bind(pid),
    c.env.DB.prepare("DELETE FROM cards WHERE project_id = ?1").bind(pid),
    c.env.DB.prepare("DELETE FROM agent_registrations WHERE project_id = ?1").bind(pid),
    c.env.DB.prepare("DELETE FROM agent_tokens WHERE project_id = ?1").bind(pid),
    c.env.DB.prepare("DELETE FROM agent_projects WHERE project_id = ?1").bind(pid),
    // Agents keep a global identity; only rows without any remaining membership go away.
    c.env.DB.prepare("DELETE FROM agents WHERE id NOT IN (SELECT agent_id FROM agent_projects)"),
    c.env.DB.prepare("DELETE FROM project_tokens WHERE project_id = ?1").bind(pid),
    c.env.DB.prepare("DELETE FROM project_members WHERE project_id = ?1").bind(pid),
    c.env.DB.prepare("DELETE FROM project_join_requests WHERE project_id = ?1").bind(pid),
    c.env.DB.prepare("DELETE FROM audit_log WHERE project_id = ?1").bind(pid),
    c.env.DB.prepare("DELETE FROM projects WHERE id = ?1").bind(pid),
  ]);

  let eventsPurged = true;
  try {
    await c.env.BOARD_DO.getByName(pid).purgeProject();
  } catch (error) {
    eventsPurged = false;
    console.error(
      JSON.stringify({
        level: "error",
        job: "project_purge",
        project_id: pid,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  return c.json({ ok: true, events_purged: eventsPurged });
});

projectRoutes.get("/projects/:pid", requireUser, requireProjectMember, async (c) => {
  const project = c.get("project");
  return c.json({ project: projectSummary(project, c.get("projectRole"), c.get("projectAccess")) });
});

projectRoutes.patch("/projects/:pid", requireUser, requireProjectMember, requireProjectOwner, async (c) => {
  const project = c.get("project");
  const body = await parseBody(c, updateProjectSchema);
  const next = {
    name: body.name ?? project.name,
    verification_mode: body.verification_mode ?? project.verification_mode,
    exec_targets_json:
      body.exec_targets === undefined ? project.exec_targets_json : JSON.stringify(body.exec_targets),
  };
  await c.env.DB.prepare(
    "UPDATE projects SET name = ?1, verification_mode = ?2, exec_targets_json = ?3 WHERE id = ?4",
  )
    .bind(next.name, next.verification_mode, next.exec_targets_json, project.id)
    .run();
  return c.json({
    project: projectSummary(
      { ...project, ...next },
      c.get("projectRole"),
      c.get("projectAccess"),
    ),
  });
});

projectRoutes.post(
  "/projects/:pid/tokens",
  requireUser,
  requireProjectMember,
  requireProjectOwner,
  async (c) => {
    const project = c.get("project");
    const user = c.get("user");
    const token = await issueEnrollmentToken(c.env.DB, project.id, user.id, c.env.TOKEN_PEPPER, true);
    return c.json({ enrollment_token: token, expires_in_days: 90 }, 201);
  },
);

projectRoutes.get("/projects/:pid/members", requireUser, requireProjectMember, async (c) => {
  const project = c.get("project");
  const rows = await c.env.DB.prepare(
    `${projectMemberSelect}
      ORDER BY pm.role = 'owner' DESC, pm.added_at ASC`,
  )
    .bind(project.id)
    .all<ProjectMemberRow>();
  return c.json({ members: rows.results });
});

projectRoutes.post(
  "/projects/:pid/members",
  requireUser,
  requireProjectMember,
  requireProjectOwner,
  async (c) => {
    const project = c.get("project");
    const actor = c.get("user");
    const body = await parseBody(c, addMemberSchema);
    if (body.role === "owner") throw singleOwnerError();
    const email = body.email.toLowerCase();

    const user = await c.env.DB.prepare("SELECT * FROM users WHERE email = ?1")
      .bind(email)
      .first<UserRow>();
    if (!user) {
      throw new HttpError(
        404,
        "USER_NOT_FOUND",
        "user not found; create the account in the admin console first",
      );
    }
    if (user.status !== "active") {
      throw new HttpError(409, "USER_DISABLED", "cannot add a disabled user to a project");
    }

    const existing = await c.env.DB.prepare(
      "SELECT role FROM project_members WHERE project_id = ?1 AND user_id = ?2",
    )
      .bind(project.id, user.id)
      .first<{ role: ProjectMemberRole }>();
    if (existing) {
      await assertNotLastOwner(c.env.DB, project.id, existing.role, body.role);
    }

    const now = nowIso();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO project_members (project_id, user_id, role, added_by, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role
         WHERE project_members.role <> 'owner'
            OR excluded.role = 'owner'
            OR (SELECT COUNT(*) FROM project_members WHERE project_id = ?1 AND role = 'owner') > 1`,
      ).bind(project.id, user.id, body.role, actor.id, now),
      c.env.DB.prepare(
        `UPDATE project_join_requests
            SET status = 'approved', decided_by = ?3, decided_at = ?4
          WHERE project_id = ?1 AND user_id = ?2 AND status = 'pending'`,
      ).bind(project.id, user.id, actor.id, now),
    ]);

    const member = await loadProjectMember(c.env.DB, project.id, user.id);
    if (existing?.role === "owner" && member?.role !== "owner") {
      throw new HttpError(409, "LAST_OWNER", "cannot demote or remove the last project owner");
    }
    return c.json({ member }, 201);
  },
);

projectRoutes.patch(
  "/projects/:pid/members/:uid",
  requireUser,
  requireProjectMember,
  requireProjectOwner,
  async (c) => {
    const project = c.get("project");
    const uid = c.req.param("uid");
    const body = await parseBody(c, updateMemberSchema);
    const target = await loadProjectMember(c.env.DB, project.id, uid);
    if (!target) throw new HttpError(404, "NOT_FOUND", "member not found");
    if (body.role === "owner" && target.role !== "owner") throw singleOwnerError();

    await assertNotLastOwner(c.env.DB, project.id, target.role, body.role);
    if (target.role !== body.role) {
      const updated = await c.env.DB.prepare(
        `UPDATE project_members
            SET role = ?1
          WHERE project_id = ?2 AND user_id = ?3
            AND (role <> 'owner'
                 OR ?1 = 'owner'
                 OR (SELECT COUNT(*) FROM project_members WHERE project_id = ?2 AND role = 'owner') > 1)`,
      )
        .bind(body.role, project.id, uid)
        .run();
      if ((updated.meta.changes ?? 0) === 0) {
        throw new HttpError(409, "LAST_OWNER", "cannot demote or remove the last project owner");
      }
    }

    const member = await loadProjectMember(c.env.DB, project.id, uid);
    return c.json({ member });
  },
);

/**
 * Hand ownership to an existing member. The previous owner stays in the project
 * as a member. Both updates run in one batch so the single-owner index
 * (uq_project_single_owner) never sees two owners or a project without one.
 */
projectRoutes.post(
  "/projects/:pid/owner",
  requireUser,
  requireProjectMember,
  requireProjectOwner,
  async (c) => {
    const project = c.get("project");
    const body = await parseBody(c, transferOwnerSchema);
    const target = await loadProjectMember(c.env.DB, project.id, body.user_id);
    if (!target) throw new HttpError(404, "NOT_FOUND", "member not found");
    if (target.global_status !== "active") {
      throw new HttpError(409, "USER_DISABLED", "cannot transfer ownership to a disabled user");
    }
    if (target.role === "owner") return c.json({ owner: target, previous_owner_id: null });

    const previous = await c.env.DB.prepare(
      "SELECT user_id FROM project_members WHERE project_id = ?1 AND role = 'owner'",
    )
      .bind(project.id)
      .first<{ user_id: string }>();

    const [, promoted] = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE project_members SET role = 'member'
          WHERE project_id = ?1 AND role = 'owner'
            AND EXISTS (SELECT 1 FROM project_members
                         WHERE project_id = ?1 AND user_id = ?2 AND role IN ('member','admin'))`,
      ).bind(project.id, target.id),
      c.env.DB.prepare(
        `UPDATE project_members SET role = 'owner' WHERE project_id = ?1 AND user_id = ?2 AND role IN ('member','admin')`,
      ).bind(project.id, target.id),
    ]);
    if ((promoted.meta.changes ?? 0) === 0) {
      throw new HttpError(409, "CONFLICT", "membership changed concurrently; reload and retry");
    }

    const owner = await loadProjectMember(c.env.DB, project.id, target.id);
    return c.json({ owner, previous_owner_id: previous?.user_id ?? null });
  },
);

projectRoutes.delete(
  "/projects/:pid/members/:uid",
  requireUser,
  requireProjectMember,
  requireProjectOwner,
  async (c) => {
    const project = c.get("project");
    const uid = c.req.param("uid");
    const target = await c.env.DB.prepare(
      "SELECT role FROM project_members WHERE project_id = ?1 AND user_id = ?2",
    )
      .bind(project.id, uid)
      .first<{ role: ProjectMemberRole }>();
    if (!target) throw new HttpError(404, "NOT_FOUND", "member not found");
    await assertNotLastOwner(c.env.DB, project.id, target.role, "member");

    const removed = await c.env.DB.prepare(
      `DELETE FROM project_members
        WHERE project_id = ?1 AND user_id = ?2
          AND (role <> 'owner'
               OR (SELECT COUNT(*) FROM project_members WHERE project_id = ?1 AND role = 'owner') > 1)`,
    )
      .bind(project.id, uid)
      .run();
    if ((removed.meta.changes ?? 0) === 0) {
      throw new HttpError(409, "LAST_OWNER", "cannot demote or remove the last project owner");
    }
    return c.json({ ok: true });
  },
);

projectRoutes.get("/projects/:pid/agents", requireUser, requireProjectMember, async (c) => {
  const project = c.get("project");
  const rows = await c.env.DB.prepare(
    `SELECT ap.project_id || ':' || ap.local_slug AS id, ap.local_slug AS slug, ap.status, a.harness, a.harness_version,
            a.max_concurrency,
            (SELECT COUNT(*) FROM agent_projects ap2
               JOIN projects p2 ON p2.id = ap2.project_id
              WHERE ap2.agent_id = a.id AND p2.archived_at IS NULL) AS project_count,
            COALESCE(NULLIF(ap.display_name,''), NULLIF(a.display_name,''), NULLIF(a.self_reported_name,''), ap.local_slug, a.harness || ' agent') AS resolved_name
       FROM agent_projects ap
       JOIN agents a ON a.id = ap.agent_id
      WHERE ap.project_id = ?1
      ORDER BY ap.assigned_at DESC`,
  )
    .bind(project.id)
    .all<{
      id: string;
      slug: string;
      status: "pending" | "active" | "disabled";
      harness: string;
      harness_version: string;
      max_concurrency: number;
      project_count: number;
      resolved_name: string;
    }>();
  return c.json({ agents: rows.results });
});

projectRoutes.post(
  "/projects/:pid/agents/:aid/status",
  requireUser,
  requireProjectMember,
  requireProjectOwner,
  async (c) => {
    const project = c.get("project");
    const agentId = await resolveProjectAgentReference(c.env.DB, project.id, c.req.param("aid"));
    if (!agentId) throw new HttpError(404, "NOT_FOUND", "agent is not a member of this project");
    const membership = await c.env.DB.prepare("SELECT token_version FROM agent_projects WHERE agent_id = ?1 AND project_id = ?2")
      .bind(agentId, project.id).first<{ token_version: number }>();
    if (!membership) throw new HttpError(404, "NOT_FOUND", "agent is not a member of this project");
    const body = await parseBody(c, agentStatusSchema);
    const now = nowIso();
    const updated = await c.env.DB.prepare(
      `UPDATE agent_projects SET status = ?1, updated_at = ?2
        WHERE agent_id = ?3 AND project_id = ?4 AND token_version = ?5
          AND ${agentActivationQuotaPredicate(4, 1)}`,
    )
      .bind(body.status, now, agentId, project.id, membership.token_version)
      .run();
    if ((updated.meta.changes ?? 0) === 0) {
      await rejectAgentStatusUpdate(c.env.DB, agentId, project.id, membership.token_version, body.status);
    }
    const agent = await c.env.DB.prepare(
      `SELECT ap.project_id || ':' || ap.local_slug AS id, ap.local_slug AS slug, ap.status, a.harness, a.harness_version, a.max_concurrency,
              COALESCE(NULLIF(ap.display_name,''), NULLIF(a.display_name,''), NULLIF(a.self_reported_name,''), ap.local_slug, a.harness || ' agent') AS resolved_name
         FROM agent_projects ap
         JOIN agents a ON a.id = ap.agent_id
        WHERE ap.project_id = ?1 AND ap.agent_id = ?2`,
    )
      .bind(project.id, agentId)
      .first<{
        id: string;
        slug: string;
        status: "pending" | "active" | "disabled";
        harness: string;
        harness_version: string;
        max_concurrency: number;
        resolved_name: string;
      }>();
    return c.json({ agent });
  },
);
