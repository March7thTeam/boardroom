import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import {
  createEntry,
  findExistingProjectEvent,
  issueGrant,
  listEntries,
  listRefs,
  loadEntry,
  revokeGrant,
  spaceFor,
  updateEntry,
  type Actor,
} from "../domain/memory";
import { HttpError } from "../lib/http-error";
import { parseBody } from "../lib/http";
import { requireUser } from "../middleware/identity";
import { requireProjectMember } from "../middleware/project";

/**
 * 人类侧记忆接口（P1）。
 *
 * 权限收敛为两条：
 *   * 项目成员可读写本项目空间的条目（写入一律过密钥扫描）；
 *   * 签发跨项目引用凭据需要「条目作者本人」或「项目 owner/admin」——对外可见
 *     属于人类决策，不是 agent 凭借项目内写权限就能获得的。
 */
export const memoryRoutes = new Hono<AppEnv>();

function humanActor(c: Context<AppEnv>): Actor {
  return { type: "user", id: c.get("user").id };
}

function expectedVersion(c: Context<AppEnv>): number {
  const raw = c.req.header("If-Match");
  if (!raw) throw new HttpError(428, "PRECONDITION_REQUIRED", "If-Match header is required");
  const value = Number(raw.trim().replace(/^W\//, "").replace(/^"|"$/g, ""));
  if (!Number.isInteger(value) || value < 1) {
    throw new HttpError(400, "INVALID_ARGUMENT", "If-Match must be a memory entry version");
  }
  return value;
}

const entryInput = z.object({
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string().max(64)).max(20).optional(),
  source_card_id: z.string().trim().min(1).max(64).optional().nullable(),
  message_id: z.string().trim().min(1).max(200).optional(),
});

const updateInput = entryInput.extend({
  message_id: z.string().trim().min(1).max(200).optional(),
});

const grantInput = z.object({
  to_project_id: z.string().trim().min(1).max(64),
  ttl_hours: z.number().int().min(1).max(24 * 365).optional(),
  message_id: z.string().trim().min(1).max(200).optional(),
});

const revokeInput = z.object({
  reason: z.string().trim().max(500).optional(),
  message_id: z.string().trim().min(1).max(200).optional(),
});

memoryRoutes.get("/projects/:pid/memory", requireUser, requireProjectMember, async (c) => {
  const project = c.get("project");
  const space = await spaceFor(c.env.DB, project.id);
  if (!space) {
    return c.json({ project_id: project.id, space: null, entry_count: 0, ref_count: 0, refs: [] });
  }
  const counts = await c.env.DB
    .prepare(`SELECT
      (SELECT COUNT(*) FROM memory_entries WHERE space_id = ?1 AND status = 'active') AS entry_count,
      (SELECT COUNT(*) FROM memory_refs WHERE space_id = ?1) AS ref_count`)
    .bind(space.id)
    .first<{ entry_count: number; ref_count: number }>();
  return c.json({
    project_id: project.id,
    space: { id: space.id, slug: space.slug, name: space.name, created_at: space.created_at },
    entry_count: counts?.entry_count ?? 0,
    ref_count: counts?.ref_count ?? 0,
    refs: await listRefs(c.env.DB, space.id),
  });
});

memoryRoutes.get("/projects/:pid/memory/entries", requireUser, requireProjectMember, async (c) => {
  const project = c.get("project");
  const space = await spaceFor(c.env.DB, project.id);
  if (!space) return c.json({ entries: [], next_cursor: null, has_more: false });
  const limitRaw = Number(c.req.query("limit") ?? 50);
  const result = await listEntries(c.env.DB, space.id, {
    since: c.req.query("since"),
    cursor: c.req.query("cursor"),
    limit: Number.isInteger(limitRaw) ? limitRaw : 50,
  });
  return c.json(result);
});

memoryRoutes.post("/projects/:pid/memory/entries", requireUser, requireProjectMember, async (c) => {
  const project = c.get("project");
  const body = await parseBody(c, entryInput);
  const actor = humanActor(c);

  if (body.message_id) {
    const previous = await findExistingProjectEvent(c, project.id, body.message_id);
    if (previous) return c.json({ ...previous }, 200);
  }

  const result = await createEntry(c, {
    projectId: project.id,
    actor,
    title: body.title,
    body: body.body,
    tags: body.tags,
    sourceCardId: body.source_card_id ?? null,
    messageId: body.message_id ?? null,
  });
  return c.json({ entry: result.entry, ...result.event }, 201);
});

memoryRoutes.patch("/projects/:pid/memory/entries/:eid", requireUser, requireProjectMember, async (c) => {
  const project = c.get("project");
  const body = await parseBody(c, updateInput);
  const version = expectedVersion(c);
  const actor = humanActor(c);

  if (body.message_id) {
    const previous = await findExistingProjectEvent(c, project.id, body.message_id);
    if (previous) return c.json({ ...previous }, 200);
  }

  const result = await updateEntry(c, {
    projectId: project.id,
    actor,
    entryId: c.req.param("eid"),
    expectedVersion: version,
    title: body.title,
    body: body.body,
    tags: body.tags,
    messageId: body.message_id ?? null,
  });
  return c.json({ entry: result.entry, ...result.event });
});

memoryRoutes.post("/projects/:pid/memory/entries/:eid/grants", requireUser, requireProjectMember, async (c) => {
  const project = c.get("project");
  const body = await parseBody(c, grantInput);
  const actor = humanActor(c);
  const entry = await loadEntry(c.env.DB, c.req.param("eid"));
  if (entry.project_id !== project.id) throw new HttpError(404, "NOT_FOUND", "memory entry not found");

  const role = c.get("projectRole");
  const isAuthor = entry.created_by_type === "user" && entry.created_by_id === actor.id;
  if (!isAuthor && role !== "owner" && role !== "admin") {
    throw new HttpError(403, "FORBIDDEN", "only the entry author or a project owner/admin can grant cross-project access");
  }

  if (body.message_id) {
    const previous = await findExistingProjectEvent(c, project.id, body.message_id);
    if (previous) return c.json({ ...previous }, 200);
  }

  const result = await issueGrant(c, {
    projectId: project.id,
    entryId: entry.id,
    toProjectId: body.to_project_id,
    actor,
    ttlHours: body.ttl_hours ?? null,
    messageId: body.message_id ?? null,
  });
  return c.json({ grant: result.grant, ...result.event }, 201);
});

memoryRoutes.post("/projects/:pid/memory/grants/:gid/revoke", requireUser, requireProjectMember, async (c) => {
  const project = c.get("project");
  const body = await parseBody(c, revokeInput);
  const actor = humanActor(c);

  const grant = await c.env.DB
    .prepare("SELECT * FROM memory_ref_grants WHERE id = ?1")
    .bind(c.req.param("gid"))
    .first<{ id: string; entry_id: string; granted_by_type: string; granted_by_id: string }>();
  if (!grant) throw new HttpError(404, "NOT_FOUND", "memory grant not found");
  const entry = await loadEntry(c.env.DB, grant.entry_id);
  if (entry.project_id !== project.id) throw new HttpError(404, "NOT_FOUND", "memory grant not found");

  const role = c.get("projectRole");
  const isIssuer = grant.granted_by_type === "user" && grant.granted_by_id === actor.id;
  if (!isIssuer && role !== "owner" && role !== "admin") {
    throw new HttpError(403, "FORBIDDEN", "only the grant issuer or a project owner/admin can revoke");
  }

  if (body.message_id) {
    const previous = await findExistingProjectEvent(c, project.id, body.message_id);
    if (previous) return c.json({ ...previous }, 200);
  }

  const result = await revokeGrant(c, {
    projectId: project.id,
    grantId: grant.id,
    actor,
    reason: body.reason ?? null,
    messageId: body.message_id ?? null,
  });
  return c.json(result);
});
