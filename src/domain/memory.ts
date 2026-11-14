import type { Context } from "hono";
import type { AppEnv } from "../context";
import { sha256Hex } from "../lib/crypto";
import { commitAndPublish, eventRequestHash, publishCommitted, type OutboxRow } from "../lib/event-store";
import { HttpError } from "../lib/http-error";
import { newId } from "../lib/ids";
import { nowIso } from "../lib/time";

/**
 * 项目记忆空间（P1）。
 *
 * 语义边界（与 GitHub #11 的决策一致）：
 *   * 1 项目 : 1 空间。空间随项目存在，没有独立 owner，也没有跨项目挂载。
 *   * 跨项目不是共享视图，而是「A 侧签发凭据 + B 侧显式登记引用」。
 *   * 引用绑定 (entry_id, entry_version, content_sha256)；源条目更新不回溯。
 *   * 凭据撤销只停止后续读取，无法收回下游已取得的副本。
 */

export const MEMORY_BODY_MAX_BYTES = 8192;
export const MEMORY_TITLE_MAX_CHARS = 200;
export const MEMORY_ENTRIES_PER_SPACE = 2000;

/** 写入即扫描；命中即拒绝。这是启发式，不能当作「内容可公开」的证明。 */
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "boardroom_token", pattern: /\bkb[t|e]1\.[A-Za-z0-9_-]{8,}/ },
  { name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "github_pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: "openai_key", pattern: /\bsk-[A-Za-z0-9]{16,}/ },
  { name: "aws_key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

export interface SpaceRow {
  id: string;
  project_id: string;
  slug: string;
  name: string;
  created_at: string;
  archived_at: string | null;
}

export interface EntryRow {
  id: string;
  space_id: string;
  project_id: string;
  title: string;
  body: string;
  tags_json: string;
  status: "active" | "deleted";
  version: number;
  source_card_id: string | null;
  created_by_type: "agent" | "user" | "system";
  created_by_id: string;
  created_at: string;
  updated_at: string;
}

export interface RevisionRow {
  id: string;
  entry_id: string;
  version: number;
  title: string;
  body: string;
  body_hash: string;
  actor_type: "agent" | "user" | "system";
  actor_id: string;
  project_id: string;
  created_at: string;
}

export interface GrantRow {
  id: string;
  entry_id: string;
  entry_version: number;
  content_sha256: string;
  to_project_id: string;
  granted_by_type: "agent" | "user" | "system";
  granted_by_id: string;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export interface RefRow {
  id: string;
  project_id: string;
  space_id: string;
  grant_id: string;
  source_entry_id: string;
  source_version: number;
  content_sha256: string;
  title: string;
  imported_by_type: "agent" | "user" | "system";
  imported_by_id: string;
  imported_at: string;
  revoked_at: string | null;
}

export type Actor = { type: "agent" | "user" | "system"; id: string };

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function publicEntry(row: EntryRow) {
  let tags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.tags_json);
    if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === "string");
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    space_id: row.space_id,
    project_id: row.project_id,
    title: row.title,
    body: row.body,
    tags,
    status: row.status,
    version: row.version,
    source_card_id: row.source_card_id,
    created_by: { type: row.created_by_type, id: row.created_by_id },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function scanForSecrets(text: string): string[] {
  return SECRET_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}

export function assertEntryContent(title: string, body: string): void {
  if (!title.trim()) throw new HttpError(400, "INVALID_ARGUMENT", "memory entry title is required");
  if (title.length > MEMORY_TITLE_MAX_CHARS) {
    throw new HttpError(400, "INVALID_ARGUMENT", `memory entry title must be at most ${MEMORY_TITLE_MAX_CHARS} characters`);
  }
  if (!body.trim()) throw new HttpError(400, "INVALID_ARGUMENT", "memory entry body is required");
  const bytes = byteLength(body);
  if (bytes > MEMORY_BODY_MAX_BYTES) {
    throw new HttpError(400, "INVALID_ARGUMENT", `memory entry body must be at most ${MEMORY_BODY_MAX_BYTES} bytes`, { bytes });
  }
  const hits = scanForSecrets(`${title}\n${body}`);
  if (hits.length) {
    throw new HttpError(422, "SECRET_DETECTED", "memory entry looks like it contains a credential", { matched: hits });
  }
}

/** Space 与 project 是 1:1：首次写入时惰性创建，冲突时复用已存在的那一行。 */
export async function ensureSpace(db: D1Database, projectId: string): Promise<SpaceRow> {
  const existing = await db
    .prepare("SELECT * FROM memory_spaces WHERE project_id = ?1")
    .bind(projectId)
    .first<SpaceRow>();
  if (existing) return existing;

  const project = await db
    .prepare("SELECT id, slug, name FROM projects WHERE id = ?1 AND archived_at IS NULL")
    .bind(projectId)
    .first<{ id: string; slug: string; name: string }>();
  if (!project) throw new HttpError(404, "NOT_FOUND", "project not found");

  await db
    .prepare("INSERT INTO memory_spaces(id, project_id, slug, name, created_at) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(project_id) DO NOTHING")
    .bind(newId("ms"), project.id, project.slug, project.name, nowIso())
    .run();

  const created = await db
    .prepare("SELECT * FROM memory_spaces WHERE project_id = ?1")
    .bind(projectId)
    .first<SpaceRow>();
  if (!created) throw new HttpError(500, "INTERNAL", "memory space could not be created");
  return created;
}

export async function spaceFor(db: D1Database, projectId: string): Promise<SpaceRow | null> {
  return db.prepare("SELECT * FROM memory_spaces WHERE project_id = ?1").bind(projectId).first<SpaceRow>();
}

function decodeCursor(cursor: string): { updated_at: string; id: string; since: string | null; space: string } {
  try {
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(cursor)) throw new Error("invalid encoding");
    const base64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))) as Record<string, unknown>;
    if (typeof parsed.updated_at !== "string" || typeof parsed.id !== "string" || typeof parsed.space !== "string") {
      throw new Error("shape");
    }
    return {
      updated_at: parsed.updated_at,
      id: parsed.id,
      since: typeof parsed.since === "string" ? parsed.since : null,
      space: parsed.space,
    };
  } catch {
    throw new HttpError(400, "INVALID_ARGUMENT", "invalid cursor");
  }
}

/** 增量同步：与 /agent/cards 同一套 updated_at 键集，避免记忆另造一套序号。 */
export async function listEntries(
  db: D1Database,
  spaceId: string,
  query: { since?: string; cursor?: string; limit?: number },
): Promise<{ entries: ReturnType<typeof publicEntry>[]; next_cursor: string | null; has_more: boolean }> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const since = query.since ?? null;
  const filters: string[] = ["space_id = ?1", "status = 'active'"];
  const bindings: unknown[] = [spaceId];

  if (since) {
    filters.push(`updated_at > ?${bindings.length + 1}`);
    bindings.push(since);
  }

  let cursor: ReturnType<typeof decodeCursor> | null = null;
  if (query.cursor) {
    cursor = decodeCursor(query.cursor);
    if (cursor.space !== spaceId || cursor.since !== since) {
      throw new HttpError(400, "INVALID_ARGUMENT", "cursor does not match the current query");
    }
    filters.push(`(updated_at > ?${bindings.length + 1} OR (updated_at = ?${bindings.length + 1} AND id > ?${bindings.length + 2}))`);
    bindings.push(cursor.updated_at, cursor.id);
  }

  const rows = await db
    .prepare(`SELECT * FROM memory_entries WHERE ${filters.join(" AND ")} ORDER BY updated_at ASC, id ASC LIMIT ?${bindings.length + 1}`)
    .bind(...bindings, limit + 1)
    .all<EntryRow>();

  const page = rows.results.slice(0, limit);
  const hasMore = rows.results.length > limit;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last
    ? btoa(JSON.stringify({ updated_at: last.updated_at, id: last.id, since, space: spaceId }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    : null;
  return { entries: page.map(publicEntry), next_cursor: nextCursor, has_more: hasMore };
}

/** 项目级事件（card_id = NULL）的幂等回放；与 findExistingEvent 同一份 receipt 语义。 */
export async function findExistingProjectEvent(
  c: Context<AppEnv>,
  projectId: string,
  messageId: string,
): Promise<Record<string, unknown> | null> {
  const row = await c.env.DB
    .prepare("SELECT * FROM event_outbox WHERE project_id = ?1 AND card_id IS NULL AND message_id = ?2")
    .bind(projectId, messageId)
    .first<OutboxRow>();
  if (!row) return null;
  const actor = c.get("agent")?.id ?? c.get("user")?.id;
  if (row.request_hash && (row.request_hash !== await eventRequestHash(c) || row.actor_id !== actor)) {
    throw new HttpError(409, "CONFLICT", "message_id already belongs to a different request");
  }
  const result = await publishCommitted(c.env, { row, card: null, duplicate: true });
  return {
    ...JSON.parse(row.payload_json) as Record<string, unknown>,
    ...result.receipt,
    event_id: result.event_id,
    seq: result.seq,
    event_pending: result.event_pending,
    duplicate: true,
  };
}

async function revisionHash(title: string, body: string): Promise<string> {
  return sha256Hex(`${title}\n${body}`);
}

export async function createEntry(
  c: Context<AppEnv>,
  input: {
    projectId: string;
    actor: Actor;
    title: string;
    body: string;
    tags?: string[];
    sourceCardId?: string | null;
    messageId?: string | null;
  },
): Promise<{ entry: ReturnType<typeof publicEntry>; event: Record<string, unknown> }> {
  const db = c.env.DB;
  assertEntryContent(input.title, input.body);
  const space = await ensureSpace(db, input.projectId);

  const used = await db
    .prepare("SELECT COUNT(*) AS c FROM memory_entries WHERE space_id = ?1 AND status = 'active'")
    .bind(space.id)
    .first<{ c: number }>();
  if ((used?.c ?? 0) >= MEMORY_ENTRIES_PER_SPACE) {
    throw new HttpError(409, "QUOTA_EXCEEDED", `memory space is limited to ${MEMORY_ENTRIES_PER_SPACE} active entries`);
  }

  const id = newId("me");
  const now = nowIso();
  const bodyHash = await revisionHash(input.title, input.body);
  const tagsJson = JSON.stringify(input.tags ?? []);

  const entryInsert = db
    .prepare(`INSERT INTO memory_entries
      (id, space_id, project_id, title, body, tags_json, source_card_id, created_by_type, created_by_id, created_at, updated_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)`)
    .bind(id, space.id, input.projectId, input.title, input.body, tagsJson, input.sourceCardId ?? null, input.actor.type, input.actor.id, now);
  const revisionInsert = db
    .prepare(`INSERT INTO memory_revisions
      (id, entry_id, version, title, body, body_hash, actor_type, actor_id, project_id, created_at)
      VALUES (?1,?2,1,?3,?4,?5,?6,?7,?8,?9)`)
    .bind(newId("mr"), id, input.title, input.body, bodyHash, input.actor.type, input.actor.id, input.projectId, now);

  const result = await commitAndPublish(c, [entryInsert, revisionInsert], {
    projectId: input.projectId,
    cardId: null,
    eventType: "memory.entry_created",
    actorType: input.actor.type,
    actorId: input.actor.id,
    payload: { entry_id: id, space_id: space.id, version: 1, body_hash: bodyHash },
    messageId: input.messageId ?? null,
    receipt: { entry_id: id, version: 1, body_hash: bodyHash },
  });
  if (!result) throw new HttpError(409, "CONFLICT", "memory entry was not created");

  const entry = await db.prepare("SELECT * FROM memory_entries WHERE id = ?1").bind(id).first<EntryRow>();
  if (!entry) throw new HttpError(500, "INTERNAL", "memory entry missing after write");
  return {
    entry: publicEntry(entry),
    event: {
      seq: result.seq,
      event_id: result.event_id,
      event_pending: result.event_pending,
      ...(result.duplicate ? { duplicate: true } : {}),
    },
  };
}

export async function loadEntry(db: D1Database, entryId: string): Promise<EntryRow> {
  const row = await db.prepare("SELECT * FROM memory_entries WHERE id = ?1").bind(entryId).first<EntryRow>();
  if (!row) throw new HttpError(404, "NOT_FOUND", "memory entry not found");
  return row;
}

function assertEntryWriter(entry: EntryRow, actor: Actor): void {
  if (entry.created_by_type !== actor.type || entry.created_by_id !== actor.id) {
    throw new HttpError(403, "FORBIDDEN", "only the entry author can change this memory entry");
  }
}

export async function updateEntry(
  c: Context<AppEnv>,
  input: {
    projectId: string;
    actor: Actor;
    entryId: string;
    expectedVersion: number;
    title: string;
    body: string;
    tags?: string[];
    messageId?: string | null;
  },
): Promise<{ entry: ReturnType<typeof publicEntry>; event: Record<string, unknown> }> {
  const db = c.env.DB;
  const current = await loadEntry(db, input.entryId);
  if (current.project_id !== input.projectId) throw new HttpError(404, "NOT_FOUND", "memory entry not found");
  if (current.status === "deleted") throw new HttpError(409, "CARD_STATE_INVALID", "memory entry is deleted");
  if (current.version !== input.expectedVersion) {
    throw new HttpError(409, "VERSION_CONFLICT", "memory entry version does not match If-Match", { current_version: current.version });
  }
  assertEntryWriter(current, input.actor);
  assertEntryContent(input.title, input.body);

  const nextVersion = current.version + 1;
  const now = nowIso();
  const bodyHash = await revisionHash(input.title, input.body);
  const tagsJson = JSON.stringify(input.tags ?? []);

  const update = db
    .prepare(`UPDATE memory_entries
      SET title = ?1, body = ?2, tags_json = ?3, version = version + 1, updated_at = ?4
      WHERE id = ?5 AND version = ?6 AND status = 'active'`)
    .bind(input.title, input.body, tagsJson, now, input.entryId, input.expectedVersion);
  const revisionInsert = db
    .prepare(`INSERT INTO memory_revisions
      (id, entry_id, version, title, body, body_hash, actor_type, actor_id, project_id, created_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`)
    .bind(newId("mr"), input.entryId, nextVersion, input.title, input.body, bodyHash, input.actor.type, input.actor.id, current.project_id, now);

  const result = await commitAndPublish(c, [update, revisionInsert], {
    projectId: current.project_id,
    cardId: null,
    eventType: "memory.entry_updated",
    actorType: input.actor.type,
    actorId: input.actor.id,
    payload: { entry_id: input.entryId, space_id: current.space_id, version: nextVersion, body_hash: bodyHash },
    messageId: input.messageId ?? null,
    receipt: { entry_id: input.entryId, version: nextVersion, body_hash: bodyHash },
  });
  if (!result) {
    throw new HttpError(409, "VERSION_CONFLICT", "memory entry changed while updating", { current_version: current.version });
  }

  const updated = await loadEntry(db, input.entryId);
  return {
    entry: publicEntry(updated),
    event: {
      seq: result.seq,
      event_id: result.event_id,
      event_pending: result.event_pending,
      ...(result.duplicate ? { duplicate: true } : {}),
    },
  };
}

export async function deleteEntry(
  c: Context<AppEnv>,
  input: { projectId: string; actor: Actor; entryId: string; expectedVersion: number; messageId?: string | null },
): Promise<{ entry_id: string; version: number; event: Record<string, unknown> }> {
  const db = c.env.DB;
  const current = await loadEntry(db, input.entryId);
  if (current.project_id !== input.projectId) throw new HttpError(404, "NOT_FOUND", "memory entry not found");
  if (current.status === "deleted") throw new HttpError(409, "CARD_STATE_INVALID", "memory entry is already deleted");
  if (current.version !== input.expectedVersion) {
    throw new HttpError(409, "VERSION_CONFLICT", "memory entry version does not match If-Match", { current_version: current.version });
  }
  assertEntryWriter(current, input.actor);

  const nextVersion = current.version + 1;
  const now = nowIso();
  const update = db
    .prepare("UPDATE memory_entries SET status = 'deleted', version = version + 1, updated_at = ?1 WHERE id = ?2 AND version = ?3 AND status = 'active'")
    .bind(now, input.entryId, input.expectedVersion);

  const result = await commitAndPublish(c, update, {
    projectId: current.project_id,
    cardId: null,
    eventType: "memory.entry_deleted",
    actorType: input.actor.type,
    actorId: input.actor.id,
    payload: { entry_id: input.entryId, space_id: current.space_id, version: nextVersion },
    messageId: input.messageId ?? null,
    receipt: { entry_id: input.entryId, version: nextVersion },
  });
  if (!result) throw new HttpError(409, "VERSION_CONFLICT", "memory entry changed while deleting");
  return {
    entry_id: input.entryId,
    version: nextVersion,
    event: {
      seq: result.seq,
      event_id: result.event_id,
      event_pending: result.event_pending,
      ...(result.duplicate ? { duplicate: true } : {}),
    },
  };
}

/**
 * 签发引用凭据。人类动作：条目作者本人，或项目 owner/admin。
 * 凭据绑定当前 entry_version 与内容哈希；内容再变也不会影响这张凭据。
 */
export async function issueGrant(
  c: Context<AppEnv>,
  input: {
    projectId: string;
    entryId: string;
    toProjectId: string;
    actor: Actor;
    ttlHours?: number | null;
    messageId?: string | null;
  },
): Promise<{ grant: GrantRow; event: Record<string, unknown> }> {
  const db = c.env.DB;
  const entry = await loadEntry(db, input.entryId);
  if (entry.project_id !== input.projectId) throw new HttpError(404, "NOT_FOUND", "memory entry not found");
  if (entry.status !== "active") throw new HttpError(409, "CARD_STATE_INVALID", "memory entry is deleted");
  if (input.toProjectId === entry.project_id) {
    throw new HttpError(400, "INVALID_ARGUMENT", "grant target must be another project");
  }

  const target = await db
    .prepare("SELECT id FROM projects WHERE id = ?1 AND archived_at IS NULL")
    .bind(input.toProjectId)
    .first<{ id: string }>();
  if (!target) throw new HttpError(404, "NOT_FOUND", "target project not found");

  const revision = await db
    .prepare("SELECT * FROM memory_revisions WHERE entry_id = ?1 AND version = ?2")
    .bind(entry.id, entry.version)
    .first<RevisionRow>();
  if (!revision) throw new HttpError(409, "CARD_STATE_INVALID", "memory entry has no revision for its current version");

  const now = nowIso();
  const expiresAt = input.ttlHours ? new Date(Date.now() + input.ttlHours * 3_600_000).toISOString() : null;
  const grantId = newId("mg");
  const insert = db
    .prepare(`INSERT INTO memory_ref_grants
      (id, entry_id, entry_version, content_sha256, to_project_id, granted_by_type, granted_by_id, granted_at, expires_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`)
    .bind(grantId, entry.id, entry.version, revision.body_hash, input.toProjectId, input.actor.type, input.actor.id, now, expiresAt);

  const result = await commitAndPublish(c, insert, {
    projectId: entry.project_id,
    cardId: null,
    eventType: "memory.ref_granted",
    actorType: input.actor.type,
    actorId: input.actor.id,
    payload: {
      grant_id: grantId,
      entry_id: entry.id,
      entry_version: entry.version,
      content_sha256: revision.body_hash,
      to_project_id: input.toProjectId,
      expires_at: expiresAt,
    },
    messageId: input.messageId ?? null,
    receipt: { grant_id: grantId, entry_id: entry.id, entry_version: entry.version },
  });
  if (!result) throw new HttpError(409, "CONFLICT", "grant was not created");

  const grant = await db.prepare("SELECT * FROM memory_ref_grants WHERE id = ?1").bind(grantId).first<GrantRow>();
  if (!grant) throw new HttpError(500, "INTERNAL", "grant missing after write");
  return {
    grant,
    event: {
      seq: result.seq,
      event_id: result.event_id,
      event_pending: result.event_pending,
      ...(result.duplicate ? { duplicate: true } : {}),
    },
  };
}

export async function revokeGrant(
  c: Context<AppEnv>,
  input: { projectId: string; grantId: string; actor: Actor; reason?: string | null; messageId?: string | null },
): Promise<{ grant_id: string; event: Record<string, unknown> }> {
  const db = c.env.DB;
  const grant = await db.prepare("SELECT * FROM memory_ref_grants WHERE id = ?1").bind(input.grantId).first<GrantRow>();
  if (!grant) throw new HttpError(404, "NOT_FOUND", "memory grant not found");
  const entry = await loadEntry(db, grant.entry_id);
  if (entry.project_id !== input.projectId) throw new HttpError(404, "NOT_FOUND", "memory grant not found");
  if (grant.revoked_at) throw new HttpError(409, "CARD_STATE_INVALID", "memory grant is already revoked");

  const now = nowIso();
  const update = db
    .prepare("UPDATE memory_ref_grants SET revoked_at = ?1, revoked_reason = ?2 WHERE id = ?3 AND revoked_at IS NULL")
    .bind(now, input.reason ?? null, input.grantId);

  const result = await commitAndPublish(c, update, {
    projectId: entry.project_id,
    cardId: null,
    eventType: "memory.grant_revoked",
    actorType: input.actor.type,
    actorId: input.actor.id,
    payload: { grant_id: input.grantId, entry_id: entry.id, entry_version: grant.entry_version },
    messageId: input.messageId ?? null,
    receipt: { grant_id: input.grantId, revoked_at: now },
  });
  if (!result) throw new HttpError(409, "CONFLICT", "grant could not be revoked");
  return {
    grant_id: input.grantId,
    event: {
      seq: result.seq,
      event_id: result.event_id,
      event_pending: result.event_pending,
      ...(result.duplicate ? { duplicate: true } : {}),
    },
  };
}

/** B 侧登记引用。凭据必须指向本项目、未撤销、未过期。 */
export async function importRef(
  c: Context<AppEnv>,
  input: { projectId: string; actor: Actor; grantId: string; messageId?: string | null },
): Promise<{ ref: RefRow; event: Record<string, unknown> }> {
  const db = c.env.DB;
  const grant = await db.prepare("SELECT * FROM memory_ref_grants WHERE id = ?1").bind(input.grantId).first<GrantRow>();
  if (!grant || grant.to_project_id !== input.projectId) throw new HttpError(404, "NOT_FOUND", "memory grant not found");
  if (grant.revoked_at) throw new HttpError(410, "GRANT_REVOKED", "memory grant has been revoked");
  if (grant.expires_at && Date.parse(grant.expires_at) <= Date.now()) {
    throw new HttpError(410, "GRANT_EXPIRED", "memory grant has expired");
  }

  const entry = await db.prepare("SELECT * FROM memory_entries WHERE id = ?1").bind(grant.entry_id).first<EntryRow>();
  if (!entry || entry.status !== "active") throw new HttpError(404, "SOURCE_UNAVAILABLE", "source memory entry is not available");

  const space = await ensureSpace(db, input.projectId);
  const now = nowIso();
  const refId = newId("mref");
  const insert = db
    .prepare(`INSERT INTO memory_refs
      (id, project_id, space_id, grant_id, source_entry_id, source_version, content_sha256, title, imported_by_type, imported_by_id, imported_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`)
    .bind(refId, input.projectId, space.id, grant.id, grant.entry_id, grant.entry_version, grant.content_sha256, entry.title, input.actor.type, input.actor.id, now);

  const result = await commitAndPublish(c, insert, {
    projectId: input.projectId,
    cardId: null,
    eventType: "memory.ref_imported",
    actorType: input.actor.type,
    actorId: input.actor.id,
    payload: {
      ref_id: refId,
      grant_id: grant.id,
      source_entry_id: grant.entry_id,
      source_version: grant.entry_version,
      content_sha256: grant.content_sha256,
    },
    messageId: input.messageId ?? null,
    receipt: { ref_id: refId, grant_id: grant.id },
  }).catch((error: unknown) => {
    if (error instanceof Error && /UNIQUE constraint failed: memory_refs\./i.test(error.message)) {
      throw new HttpError(409, "CONFLICT", "this grant is already imported");
    }
    throw error;
  });
  if (!result) throw new HttpError(409, "CONFLICT", "reference was not created");

  const ref = await db.prepare("SELECT * FROM memory_refs WHERE id = ?1").bind(refId).first<RefRow>();
  if (!ref) throw new HttpError(500, "INTERNAL", "reference missing after write");
  return {
    ref,
    event: {
      seq: result.seq,
      event_id: result.event_id,
      event_pending: result.event_pending,
      ...(result.duplicate ? { duplicate: true } : {}),
    },
  };
}

/**
 * 读取引用。任何一项不满足都明确报错，绝不静默替换成源条目的最新版本。
 */
export async function readRef(
  db: D1Database,
  projectId: string,
  refId: string,
): Promise<{ ref: RefRow; grant: GrantRow; entry: { id: string; version: number; title: string; body: string; content_sha256: string } }> {
  const ref = await db
    .prepare("SELECT * FROM memory_refs WHERE id = ?1 AND project_id = ?2")
    .bind(refId, projectId)
    .first<RefRow>();
  if (!ref) throw new HttpError(404, "NOT_FOUND", "memory reference not found");
  if (ref.revoked_at) throw new HttpError(410, "GRANT_REVOKED", "memory reference has been revoked");

  const grant = await db.prepare("SELECT * FROM memory_ref_grants WHERE id = ?1").bind(ref.grant_id).first<GrantRow>();
  if (!grant) throw new HttpError(404, "SOURCE_UNAVAILABLE", "memory grant no longer exists");
  if (grant.revoked_at) throw new HttpError(410, "GRANT_REVOKED", "memory grant has been revoked");
  if (grant.expires_at && Date.parse(grant.expires_at) <= Date.now()) {
    throw new HttpError(410, "GRANT_EXPIRED", "memory grant has expired");
  }
  if (grant.content_sha256 !== ref.content_sha256) {
    throw new HttpError(409, "CONTENT_HASH_MISMATCH", "reference and grant disagree on the content hash");
  }

  const revision = await db
    .prepare("SELECT * FROM memory_revisions WHERE entry_id = ?1 AND version = ?2")
    .bind(grant.entry_id, grant.entry_version)
    .first<RevisionRow>();
  if (!revision) throw new HttpError(404, "SOURCE_UNAVAILABLE", "source revision is no longer available");

  const hash = await revisionHash(revision.title, revision.body);
  if (hash !== grant.content_sha256) {
    throw new HttpError(409, "CONTENT_HASH_MISMATCH", "source revision does not match the granted hash");
  }

  return {
    ref,
    grant,
    entry: {
      id: revision.entry_id,
      version: revision.version,
      title: revision.title,
      body: revision.body,
      content_sha256: hash,
    },
  };
}

export async function listRefs(db: D1Database, spaceId: string): Promise<RefRow[]> {
  const rows = await db
    .prepare("SELECT * FROM memory_refs WHERE space_id = ?1 ORDER BY imported_at DESC LIMIT 200")
    .bind(spaceId)
    .all<RefRow>();
  return rows.results;
}
