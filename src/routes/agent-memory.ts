import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import {
  createEntry,
  deleteEntry,
  findExistingProjectEvent,
  importRef,
  listEntries,
  listRefs,
  loadEntry,
  readRef,
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

const refInput = z.object({
  grant_id: z.string().trim().min(1).max(64),
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
  const space = await spaceFor(c.env.DB, projectId);
  if (!space) return c.json({ project_id: projectId, space: null, entry_count: 0, ref_count: 0 });
  const counts = await c.env.DB
    .prepare(`SELECT
      (SELECT COUNT(*) FROM memory_entries WHERE space_id = ?1 AND status = 'active') AS entry_count,
      (SELECT COUNT(*) FROM memory_refs WHERE space_id = ?1) AS ref_count`)
    .bind(space.id)
    .first<{ entry_count: number; ref_count: number }>();
  return c.json({
    project_id: projectId,
    space: { id: space.id, slug: space.slug, name: space.name, created_at: space.created_at },
    entry_count: counts?.entry_count ?? 0,
    ref_count: counts?.ref_count ?? 0,
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

agentMemoryRoutes.get("/memory/refs", requireAgent, async (c) => {
  const projectId = assertScope(c, c.req.query("project_id"));
  const space = await spaceFor(c.env.DB, projectId);
  if (!space) return c.json({ project_id: projectId, refs: [] });
  return c.json({ project_id: projectId, refs: await listRefs(c.env.DB, space.id) });
});

agentMemoryRoutes.post("/memory/refs", requireAgent, async (c) => {
  const body = await parseBody(c, refInput);
  const projectId = assertScope(c, body.project_id);
  const actor = agentActor(c);

  if (body.message_id) {
    const previous = await findExistingProjectEvent(c, projectId, body.message_id);
    if (previous) return c.json({ ...previous }, 200);
  }

  const result = await importRef(c, { projectId, actor, grantId: body.grant_id, messageId: body.message_id ?? null });
  return c.json({ ref: result.ref, ...result.event }, 201);
});

agentMemoryRoutes.get("/memory/refs/:rid", requireAgent, async (c) => {
  const projectId = assertScope(c, c.req.query("project_id"));
  const { ref, grant, entry } = await readRef(c.env.DB, projectId, c.req.param("rid"));
  return c.json({
    ref: {
      id: ref.id,
      grant_id: ref.grant_id,
      source_entry_id: ref.source_entry_id,
      source_version: ref.source_version,
      content_sha256: ref.content_sha256,
      title: ref.title,
      imported_at: ref.imported_at,
    },
    provenance: {
      granted_by: { type: grant.granted_by_type, id: grant.granted_by_id },
      granted_at: grant.granted_at,
      expires_at: grant.expires_at,
    },
    entry,
  });
});

/** 供人类接口复用：确认条目存在且属于该项目。 */
export { loadEntry };
