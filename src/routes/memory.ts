import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import {
  approveLink,
  createEntry,
  findExistingProjectEvent,
  listEntries,
  listLinks,
  loadEntry,
  rejectLink,
  requestLink,
  revokeLink,
  setShareable,
  spaceFor,
  updateEntry,
  type Actor,
  type LinkRow,
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

const shareableInput = z.object({
  shareable: z.boolean(),
  message_id: z.string().trim().min(1).max(200).optional(),
});

/** 申请链接：pid 是目标项目，entry_id 来自另一个项目。 */
const linkInput = z.object({
  entry_id: z.string().trim().min(1).max(64),
  message_id: z.string().trim().min(1).max(200).optional(),
});

const linkActionInput = z.object({
  reason: z.string().trim().max(500).optional(),
  message_id: z.string().trim().min(1).max(200).optional(),
});

async function loadLink(db: D1Database, linkId: string): Promise<LinkRow> {
  const link = await db.prepare("SELECT * FROM memory_entry_links WHERE id = ?1").bind(linkId).first<LinkRow>();
  if (!link) throw new HttpError(404, "NOT_FOUND", "memory link not found");
  return link;
}

/** pid 决定确认的是哪一侧；两侧都要人类确认才生效。 */
function sideFor(link: LinkRow, projectId: string): "source" | "target" {
  if (link.from_project_id === projectId) return "source";
  if (link.to_project_id === projectId) return "target";
  throw new HttpError(404, "NOT_FOUND", "memory link not found");
}

/** 审批与撤销是 owner/admin 动作：普通成员不能替他所在的项目放行内容。 */
function requireOwnerAdmin(c: Context<AppEnv>): void {
  const role = c.get("projectRole");
  if (role !== "owner" && role !== "admin") {
    throw new HttpError(403, "FORBIDDEN", "project owner/admin required");
  }
}

memoryRoutes.get("/projects/:pid/memory", requireUser, requireProjectMember, async (c) => {
  const project = c.get("project");
  const space = await spaceFor(c.env.DB, project.id);
  if (!space) {
    return c.json({ project_id: project.id, space: null, entry_count: 0, link_count: 0, links: [] });
  }
  const counts = await c.env.DB
    .prepare(`SELECT
      (SELECT COUNT(*) FROM memory_entries WHERE space_id = ?1 AND status = 'active') AS entry_count,
      (SELECT COUNT(*) FROM memory_entry_links l JOIN memory_entries e ON e.id = l.entry_id
        WHERE e.space_id = ?1 AND l.state = 'active') AS link_count`)
    .bind(space.id)
    .first<{ entry_count: number; link_count: number }>();
  return c.json({
    project_id: project.id,
    space: { id: space.id, slug: space.slug, name: space.name, created_at: space.created_at },
    entry_count: counts?.entry_count ?? 0,
    link_count: counts?.link_count ?? 0,
    links: await listLinks(c.env.DB, project.id),
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

/**
 * 作者级闸门：允许/禁止该条目被申请跨项目链接。作者本人或项目 owner/admin。
 * 关闭时同一批里撤销所有未结束的链接，立即生效。
 */
memoryRoutes.post("/projects/:pid/memory/entries/:eid/shareable", requireUser, requireProjectMember, async (c) => {
  const project = c.get("project");
  const body = await parseBody(c, shareableInput);
  const actor = humanActor(c);
  const entry = await loadEntry(c.env.DB, c.req.param("eid"));
  if (entry.project_id !== project.id) throw new HttpError(404, "NOT_FOUND", "memory entry not found");

  const role = c.get("projectRole");
  const isAuthor = entry.created_by_type === "user" && entry.created_by_id === actor.id;
  if (!isAuthor && role !== "owner" && role !== "admin") {
    throw new HttpError(403, "FORBIDDEN", "only the entry author or a project owner/admin can change the sharing flag");
  }

  if (body.message_id) {
    const previous = await findExistingProjectEvent(c, project.id, body.message_id);
    if (previous) return c.json({ ...previous }, 200);
  }

  const result = await setShareable(c, {
    projectId: project.id,
    entryId: entry.id,
    shareable: body.shareable,
    actor,
    messageId: body.message_id ?? null,
  });
  return c.json({ entry: result.entry, revoked_links: result.revoked_links, ...result.event });
});

memoryRoutes.get("/projects/:pid/memory/links", requireUser, requireProjectMember, async (c) => {
  const project = c.get("project");
  return c.json({ project_id: project.id, links: await listLinks(c.env.DB, project.id) });
});

/** 发起申请；pid 是**目标**项目（要引入这条记忆的项目）。 */
memoryRoutes.post("/projects/:pid/memory/links", requireUser, requireProjectMember, async (c) => {
  const project = c.get("project");
  const body = await parseBody(c, linkInput);
  const actor = humanActor(c);

  if (body.message_id) {
    const previous = await findExistingProjectEvent(c, project.id, body.message_id);
    if (previous) return c.json({ ...previous }, 200);
  }

  const result = await requestLink(c, {
    toProjectId: project.id,
    entryId: body.entry_id,
    actor,
    messageId: body.message_id ?? null,
  });
  return c.json({ link: result.link, ...result.event }, 201);
});

/** 确认链接：pid 决定是哪一侧（源项目 / 目标项目），两侧都确认才 active。 */
memoryRoutes.post("/projects/:pid/memory/links/:lid/approve", requireUser, requireProjectMember, async (c) => {
  const project = c.get("project");
  requireOwnerAdmin(c);
  const actor = humanActor(c);
  const link = await loadLink(c.env.DB, c.req.param("lid"));
  const side = sideFor(link, project.id);
  const body = await parseBody(c, linkActionInput);

  if (body.message_id) {
    const previous = await findExistingProjectEvent(c, project.id, body.message_id);
    if (previous) return c.json({ ...previous }, 200);
  }

  const result = await approveLink(c, {
    projectId: project.id,
    linkId: link.id,
    side,
    actor,
    messageId: body.message_id ?? null,
  });
  return c.json({ link: result.link, ...result.event });
});

memoryRoutes.post("/projects/:pid/memory/links/:lid/reject", requireUser, requireProjectMember, async (c) => {
  const project = c.get("project");
  requireOwnerAdmin(c);
  const actor = humanActor(c);
  const link = await loadLink(c.env.DB, c.req.param("lid"));
  sideFor(link, project.id);
  const body = await parseBody(c, linkActionInput);

  if (body.message_id) {
    const previous = await findExistingProjectEvent(c, project.id, body.message_id);
    if (previous) return c.json({ ...previous }, 200);
  }

  const result = await rejectLink(c, {
    projectId: project.id,
    linkId: link.id,
    actor,
    reason: body.reason ?? null,
    messageId: body.message_id ?? null,
  });
  return c.json({ link: result.link, ...result.event });
});

/** 撤销只能由源项目执行：内容属于源项目。 */
memoryRoutes.post("/projects/:pid/memory/links/:lid/revoke", requireUser, requireProjectMember, async (c) => {
  const project = c.get("project");
  requireOwnerAdmin(c);
  const actor = humanActor(c);
  const link = await loadLink(c.env.DB, c.req.param("lid"));
  if (link.from_project_id !== project.id) throw new HttpError(404, "NOT_FOUND", "memory link not found");
  const body = await parseBody(c, linkActionInput);

  if (body.message_id) {
    const previous = await findExistingProjectEvent(c, project.id, body.message_id);
    if (previous) return c.json({ ...previous }, 200);
  }

  const result = await revokeLink(c, {
    projectId: project.id,
    linkId: link.id,
    actor,
    reason: body.reason ?? null,
    messageId: body.message_id ?? null,
  });
  return c.json({ link: result.link, ...result.event });
});
