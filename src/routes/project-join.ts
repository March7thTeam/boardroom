import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody } from "../lib/http";
import { HttpError } from "../lib/http-error";
import { nowIso } from "../lib/time";
import { requireUser } from "../middleware/identity";
import {
  loadProject,
  requireProjectMember,
  requireProjectOwner,
} from "../middleware/project";

export const projectJoinRoutes = new Hono<AppEnv>();

const requestSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

const decisionSchema = z.object({
  status: z.enum(["approved", "rejected"]),
});

type JoinRequestRow = {
  project_id: string;
  user_id: string;
  status: "pending" | "approved" | "rejected";
  note: string | null;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
};

const joinRequestSelect = `SELECT project_id, user_id, status, note, requested_at, decided_by, decided_at
   FROM project_join_requests
  WHERE project_id = ?1 AND user_id = ?2`;

async function loadJoinRequest(
  db: D1Database,
  projectId: string,
  userId: string,
): Promise<JoinRequestRow | null> {
  return db
    .prepare(joinRequestSelect)
    .bind(projectId, userId)
    .first<JoinRequestRow>();
}

projectJoinRoutes.post(
  "/projects/:pid/join-requests",
  requireUser,
  async (c) => {
    const project = await loadProject(c, c.req.param("pid")!);
    if (project.archived_at) {
      throw new HttpError(404, "NOT_FOUND", "project not found");
    }

    const user = c.get("user");
    const body = await parseBody(c, requestSchema);
    const note = body.note?.trim() ? body.note.trim() : null;

    const membership = await c.env.DB.prepare(
      "SELECT role FROM project_members WHERE project_id = ?1 AND user_id = ?2",
    )
      .bind(project.id, user.id)
      .first<{ role: "owner" | "admin" | "member" }>();
    if (membership) {
      throw new HttpError(409, "ALREADY_MEMBER", "you are already a member of this project");
    }

    const existing = await loadJoinRequest(c.env.DB, project.id, user.id);
    if (existing?.status === "pending") {
      return c.json({ join_request: existing }, 200);
    }

    await c.env.DB.prepare(
      `INSERT INTO project_join_requests
         (project_id, user_id, status, note, requested_at, decided_by, decided_at)
       VALUES (?1, ?2, 'pending', ?3, ?4, NULL, NULL)
       ON CONFLICT(project_id, user_id) DO UPDATE SET
         status = 'pending',
         note = excluded.note,
         requested_at = excluded.requested_at,
         decided_by = NULL,
         decided_at = NULL`,
    )
      .bind(project.id, user.id, note, nowIso())
      .run();

    const joinRequest = await loadJoinRequest(c.env.DB, project.id, user.id);
    return c.json({ join_request: joinRequest }, 201);
  },
);

projectJoinRoutes.get(
  "/projects/:pid/join-requests",
  requireUser,
  requireProjectMember,
  requireProjectOwner,
  async (c) => {
    const project = c.get("project");
    const rows = await c.env.DB.prepare(
      `SELECT r.project_id, r.user_id, r.status, r.note, r.requested_at,
              u.email, u.display_name, u.status AS user_status
         FROM project_join_requests r
         JOIN users u ON u.id = r.user_id
        WHERE r.project_id = ?1 AND r.status = 'pending'
        ORDER BY r.requested_at ASC`,
    )
      .bind(project.id)
      .all<{
        project_id: string;
        user_id: string;
        status: "pending";
        note: string | null;
        requested_at: string;
        email: string;
        display_name: string | null;
        user_status: "active" | "disabled";
      }>();
    return c.json({ join_requests: rows.results });
  },
);

projectJoinRoutes.patch(
  "/projects/:pid/join-requests/:uid",
  requireUser,
  requireProjectMember,
  requireProjectOwner,
  async (c) => {
    const project = c.get("project");
    const actor = c.get("user");
    const uid = c.req.param("uid");
    const body = await parseBody(c, decisionSchema);

    const target = await c.env.DB.prepare(
      `SELECT project_id, user_id, status, note, requested_at, decided_by, decided_at
         FROM project_join_requests
        WHERE project_id = ?1 AND user_id = ?2 AND status = 'pending'`,
    )
      .bind(project.id, uid)
      .first<JoinRequestRow>();
    if (!target) {
      const existing = await loadJoinRequest(c.env.DB, project.id, uid);
      if (!existing) {
        throw new HttpError(404, "JOIN_REQUEST_NOT_FOUND", "join request not found");
      }
      throw new HttpError(409, "JOIN_REQUEST_DECIDED", "join request has already been decided");
    }

    const now = nowIso();
    if (body.status === "approved") {
      const results = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO project_members
             (project_id, user_id, role, added_by, added_at)
           SELECT ?1, ?2, 'member', ?3, ?4
            WHERE EXISTS (
              SELECT 1 FROM project_join_requests
               WHERE project_id = ?1 AND user_id = ?2 AND status = 'pending'
            )`,
        ).bind(project.id, uid, actor.id, now),
        c.env.DB.prepare(
          `UPDATE project_join_requests
              SET status = 'approved', decided_by = ?3, decided_at = ?4
            WHERE project_id = ?1 AND user_id = ?2 AND status = 'pending'`,
        ).bind(project.id, uid, actor.id, now),
      ]);
      if ((results[1]?.meta.changes ?? 0) === 0) {
        throw new HttpError(409, "JOIN_REQUEST_DECIDED", "join request has already been decided");
      }
    } else {
      const updated = await c.env.DB.prepare(
        `UPDATE project_join_requests
            SET status = 'rejected', decided_by = ?3, decided_at = ?4
          WHERE project_id = ?1 AND user_id = ?2 AND status = 'pending'`,
      )
        .bind(project.id, uid, actor.id, now)
        .run();
      if ((updated.meta.changes ?? 0) === 0) {
        throw new HttpError(409, "JOIN_REQUEST_DECIDED", "join request has already been decided");
      }
    }

    const joinRequest = await loadJoinRequest(c.env.DB, project.id, uid);
    return c.json({ join_request: joinRequest });
  },
);

projectJoinRoutes.get("/join-requests", requireUser, async (c) => {
  const user = c.get("user");
  const rows = await c.env.DB.prepare(
    `SELECT r.project_id, p.name AS project_name, p.slug AS project_slug,
            r.status, r.note, r.requested_at, r.decided_at
       FROM project_join_requests r
       JOIN projects p ON p.id = r.project_id
      WHERE r.user_id = ?1 AND r.status IN ('pending','rejected')
        AND p.archived_at IS NULL
      ORDER BY r.requested_at DESC`,
  )
    .bind(user.id)
    .all<{
      project_id: string;
      project_name: string;
      project_slug: string;
      status: "pending" | "rejected";
      note: string | null;
      requested_at: string;
      decided_at: string | null;
    }>();
  return c.json({ join_requests: rows.results });
});
