import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import {
  createEntry,
  deleteEntry,
  findExistingProjectEvent,
  listEntries,
  listPointers,
  loadEntry,
  readPointer,
  requestLink,
  spaceFor,
  updateEntry,
  type Actor,
} from "../domain/memory";
import { HttpError } from "../lib/http-error";
import { parseBody } from "../lib/http";
import { requireAgent } from "../middleware/agent";

/**
 * Agent 侧记忆接口（P1）。
 *
 * 只能访问当前凭据所属项目的那一份空间；这里没有跨项目读取的入口——
 * 跨项目内容一律通过 /agent/memory/refs 引用，且引用必须由源项目签发凭据。
 */
export const agentMemoryRoutes = new Hono<AppEnv>();

function scopeOf(c: Context<AppEnv>): string {
  const scope = c.get("agentCredentialProject");
  if (!scope) throw new HttpError(401, "UNAUTHENTICATED", "agent token required");
  return scope;
}

function assertScope(c: Context<AppEnv>, requested: string | null | undefined): string {
  const scope = scopeOf(c);
  if (requested && requested !== scope) {
    throw new HttpError(
      403,
      "CREDENTIAL_SCOPE_MISMATCH",
      "this agent token is bound to another project; use the token issued for that project",
    );
  }
  return scope;
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
  project_id: z.string().trim().min(1).max(64).optional(),
});

const linkInput = z.object({
  entry_id: z.string().trim().min(1).max(64),
  message_id: z.string().trim().min(1).max(200).optional(),
  project_id: z.string().trim().min(1).max(64).optional(),
});

const deleteInput = z.object({
  message_id: z.string().trim().min(1).max(200).optional(),
  project_id: z.string().trim().min(1).max(64).optional(),
});

function agentActor(c: { get(key: "agent"): { id: string } }): Actor {
  return { type: "agent", id: c.get("agent").id };
}

/** 空间概览：1 项目 : 1 空间，所以这里最多返回一个空间。 */
agentMemoryRoutes.get("/memory", requireAgent, async (c) => {
  const projectId = assertScope(c, c.req.query("project_id"));
  const agent = c.get("agent");
  const space = await spaceFor(c.env.DB, projectId);
  if (!space) return c.json({ project_id: projectId, space: null, entry_count: 0, pointer_count: 0 });
  const counts = await c.env.DB
    .prepare(`SELECT
      (SELECT COUNT(*) FROM memory_entries WHERE space_id = ?1 AND status = 'active') AS entry_count,
      (SELECT COUNT(*) FROM memory_entry_links l
        JOIN memory_entries e ON e.id = l.entry_id
        JOIN agent_projects ap ON ap.agent_id = ?2 AND ap.project_id = l.from_project_id AND ap.status = 'active'
        WHERE l.to_project_id = ?3 AND l.state = 'active' AND e.status = 'active') AS pointer_count`)
    .bind(space.id, agent.id, projectId)
    .first<{ entry_count: number; pointer_count: number }>();
  return c.json({
    project_id: projectId,
    space: { id: space.id, slug: space.slug, name: space.name, created_at: space.created_at },
    entry_count: counts?.entry_count ?? 0,
    pointer_count: counts?.pointer_count ?? 0,
  });
});

agentMemoryRoutes.get("/memory/entries", requireAgent, async (c) => {
  const projectId = assertScope(c, c.req.query("project_id"));
  const space = await spaceFor(c.env.DB, projectId);
  if (!space) return c.json({ project_id: projectId, entries: [], next_cursor: null, has_more: false });
  const limitRaw = Number(c.req.query("limit") ?? 50);
  const result = await listEntries(c.env.DB, space.id, {
    since: c.req.query("since"),
    cursor: c.req.query("cursor"),
    limit: Number.isInteger(limitRaw) ? limitRaw : 50,
  });
  return c.json({ project_id: projectId, ...result });
});

agentMemoryRoutes.post("/memory/entries", requireAgent, async (c) => {
  const body = await parseBody(c, entryInput);
  const projectId = assertScope(c, body.project_id);
  const actor = agentActor(c);

  if (body.message_id) {
    const previous = await findExistingProjectEvent(c, projectId, body.message_id);
    if (previous) return c.json({ ...previous }, 200);
  }

  const result = await createEntry(c, {
    projectId,
    actor,
    title: body.title,
    body: body.body,
    tags: body.tags,
    sourceCardId: body.source_card_id ?? null,
    messageId: body.message_id ?? null,
  });
  return c.json({ entry: result.entry, ...result.event }, 201);
});

agentMemoryRoutes.patch("/memory/entries/:eid", requireAgent, async (c) => {
  const body = await parseBody(c, entryInput);
  const projectId = assertScope(c, body.project_id);
  const version = expectedVersion(c);
  const actor = agentActor(c);
  const entryId = c.req.param("eid");

  if (body.message_id) {
    const previous = await findExistingProjectEvent(c, projectId, body.message_id);
    if (previous) return c.json({ ...previous }, 200);
  }

  const result = await updateEntry(c, {
    projectId,
    actor,
    entryId,
    expectedVersion: version,
    title: body.title,
    body: body.body,
    tags: body.tags,
    messageId: body.message_id ?? null,
  });
  return c.json({ entry: result.entry, ...result.event });
});

agentMemoryRoutes.delete("/memory/entries/:eid", requireAgent, async (c) => {
  const projectId = assertScope(c, c.req.query("project_id"));
  const version = expectedVersion(c);
  const actor = agentActor(c);
  const entryId = c.req.param("eid");
  const messageId = c.req.query("message_id") ?? null;

  if (messageId) {
    const previous = await findExistingProjectEvent(c, projectId, messageId);
    if (previous) return c.json({ ...previous }, 200);
  }

  const result = await deleteEntry(c, { projectId, actor, entryId, expectedVersion: version, messageId });
  return c.json(result);
});

agentMemoryRoutes.get("/memory/pointers", requireAgent, async (c) => {
  const projectId = assertScope(c, c.req.query("project_id"));
  const agent = c.get("agent");
  const pointers = await listPointers(c.env.DB, agent.id, projectId);
  return c.json({
    project_id: projectId,
    pointers: pointers.map(({ link, entry }) => ({
      link_id: link.id,
      entry_id: entry.id,
      title: entry.title,
      version: entry.version,
      from_project_id: link.from_project_id,
      activated_at: link.target_approved_at,
    })),
  });
});

/** 发起链接申请：agent 只能申请，须由源项目与目标项目的人类各确认一次。 */
agentMemoryRoutes.post("/memory/links", requireAgent, async (c) => {
  const body = await parseBody(c, linkInput);
  const projectId = assertScope(c, body.project_id);
  const actor = agentActor(c);

  if (body.message_id) {
    const previous = await findExistingProjectEvent(c, projectId, body.message_id);
    if (previous) return c.json({ ...previous }, 200);
  }

  const result = await requestLink(c, {
    toProjectId: projectId,
    entryId: body.entry_id,
    actor,
    messageId: body.message_id ?? null,
  });
  return c.json({ link: result.link, ...result.event }, 201);
});

agentMemoryRoutes.get("/memory/pointers/:lid", requireAgent, async (c) => {
  const projectId = assertScope(c, c.req.query("project_id"));
  const agent = c.get("agent");
  const { link, entry } = await readPointer(c.env.DB, agent.id, projectId, c.req.param("lid"));
  return c.json({
    link: {
      id: link.id,
      entry_id: link.entry_id,
      from_project_id: link.from_project_id,
      to_project_id: link.to_project_id,
      state: link.state,
      activated_at: link.target_approved_at,
    },
    entry,
  });
});
