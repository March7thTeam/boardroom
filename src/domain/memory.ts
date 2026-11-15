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
  body_hash: string;
  tags_json: string;
  status: "active" | "deleted";
  version: number;
  shareable: number;
  source_card_id: string | null;
  created_by_type: "agent" | "user" | "system";
  created_by_id: string;
  created_at: string;
  updated_at: string;
}

export interface LinkRow {
  id: string;
  entry_id: string | null;
  from_project_id: string | null;
  to_project_id: string;
  state: "pending_source" | "pending_target" | "active" | "rejected" | "revoked";
  requested_by_type: "agent" | "user" | "system";
  requested_by_id: string;
  requested_at: string;
  source_approved_by: string | null;
  source_approved_at: string | null;
  target_approved_by: string | null;
  target_approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejected_reason: string | null;
  revoked_by: string | null;
  revoked_at: string | null;
  frozen_title: string | null;
  frozen_body: string | null;
  frozen_body_hash: string | null;
  frozen_at: string | null;
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
    shareable: row.shareable === 1,
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
      (id, space_id, project_id, title, body, body_hash, tags_json, source_card_id, created_by_type, created_by_id, created_at, updated_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)`)
    .bind(id, space.id, input.projectId, input.title, input.body, bodyHash, tagsJson, input.sourceCardId ?? null, input.actor.type, input.actor.id, now);

  const result = await commitAndPublish(c, entryInsert, {
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

export async function deleteEntry(
  c: Context<AppEnv>,
  input: {
    projectId: string;
    actor: Actor;
    entryId: string;
    expectedVersion: number;
    messageId?: string | null;
    /** 误写内容需要立刻切断时使用：同一批里把该条目的未结束链接全部撤销。 */
    revokeLinks?: boolean;
  },
): Promise<{ entry_id: string; version: number; revoked_links: number; event: Record<string, unknown> }> {
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
  const statements: D1PreparedStatement[] = [update];
  if (input.revokeLinks) {
    statements.push(db
      .prepare(`UPDATE memory_entry_links SET state = 'revoked', revoked_by = ?1, revoked_at = ?2
        WHERE entry_id = ?3 AND state IN ('pending_source','pending_target','active')`)
      .bind(input.actor.id, now, input.entryId));
  }

  const result = await commitAndPublish(c, statements, {
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
  const revoked = await db
    .prepare("SELECT COUNT(*) AS c FROM memory_entry_links WHERE entry_id = ?1 AND state = 'revoked'")
    .bind(input.entryId)
    .first<{ c: number }>();
  return {
    entry_id: input.entryId,
    version: nextVersion,
    revoked_links: revoked?.c ?? 0,
    event: {
      seq: result.seq,
      event_id: result.event_id,
      event_pending: result.event_pending,
      ...(result.duplicate ? { duplicate: true } : {}),
    },
  };
}

/**
 * 作者级闸门：允许该条目被申请跨项目链接。人类动作（作者本人，或 owner/admin 代开）；
 * agent 只能申请，不能自行打开。关闭时同时撤销所有未结束的链接，立即生效。
 */
export async function setShareable(
  c: Context<AppEnv>,
  input: { projectId: string; entryId: string; shareable: boolean; actor: Actor; messageId?: string | null },
): Promise<{ entry: ReturnType<typeof publicEntry>; revoked_links: number; event: Record<string, unknown> }> {
  const db = c.env.DB;
  const entry = await loadEntry(db, input.entryId);
  if (entry.project_id !== input.projectId) throw new HttpError(404, "NOT_FOUND", "memory entry not found");
  // 对外可见是人类的决定：agent 无论是否作者都不能自行打开或关闭。
  if (input.actor.type !== "user") {
    throw new HttpError(403, "FORBIDDEN", "only humans can change the sharing flag");
  }

  const next = input.shareable ? 1 : 0;
  const now = nowIso();
  const statements = [
    db.prepare("UPDATE memory_entries SET shareable = ?1, updated_at = ?2 WHERE id = ?3 AND shareable <> ?1")
      .bind(next, now, entry.id),
  ];
  if (next === 0) {
    statements.push(db
      .prepare(`UPDATE memory_entry_links
        SET state = 'revoked', revoked_by = ?1, revoked_at = ?2
        WHERE entry_id = ?3 AND state IN ('pending_source','pending_target','active')`)
      .bind(input.actor.id, now, entry.id));
  }

  const result = await commitAndPublish(c, statements, {
    projectId: entry.project_id,
    cardId: null,
    eventType: "memory.entry_share_toggled",
    actorType: input.actor.type,
    actorId: input.actor.id,
    payload: { entry_id: entry.id, space_id: entry.space_id, shareable: next === 1 },
    messageId: input.messageId ?? null,
    receipt: { entry_id: entry.id, shareable: next === 1 },
  });
  if (!result) throw new HttpError(409, "CONFLICT", "sharing flag was not updated");

  const revoked = await db
    .prepare("SELECT COUNT(*) AS c FROM memory_entry_links WHERE entry_id = ?1 AND state = 'revoked'")
    .bind(entry.id)
    .first<{ c: number }>();
  const updated = await loadEntry(db, entry.id);
  return {
    entry: publicEntry(updated),
    revoked_links: revoked?.c ?? 0,
    event: {
      seq: result.seq,
      event_id: result.event_id,
      event_pending: result.event_pending,
      ...(result.duplicate ? { duplicate: true } : {}),
    },
  };
}

/**
 * 发起链接申请。agent 与人类都只能「申请」：真正生效需要源项目与目标项目的人类
 * 各确认一次。申请写入目标项目的事件链（申请人是目标项目的成员）。
 */
export async function requestLink(
  c: Context<AppEnv>,
  input: { toProjectId: string; entryId: string; actor: Actor; messageId?: string | null },
): Promise<{ link: LinkRow; event: Record<string, unknown> }> {
  const db = c.env.DB;
  const entry = await loadEntry(db, input.entryId);
  if (entry.status !== "active") throw new HttpError(409, "CARD_STATE_INVALID", "memory entry is deleted");
  if (entry.project_id === input.toProjectId) {
    throw new HttpError(400, "INVALID_ARGUMENT", "link target must be another project");
  }
  if (entry.shareable !== 1) {
    throw new HttpError(403, "NOT_SHAREABLE", "the entry author has not allowed cross-project linking");
  }

  const target = await db
    .prepare("SELECT id FROM projects WHERE id = ?1 AND archived_at IS NULL")
    .bind(input.toProjectId)
    .first<{ id: string }>();
  if (!target) throw new HttpError(404, "NOT_FOUND", "target project not found");

  const now = nowIso();
  const linkId = newId("ml");
  const insert = db
    .prepare(`INSERT INTO memory_entry_links
      (id, entry_id, from_project_id, to_project_id, state, requested_by_type, requested_by_id, requested_at)
      VALUES (?1,?2,?3,?4,'pending_source',?5,?6,?7)`)
    .bind(linkId, entry.id, entry.project_id, input.toProjectId, input.actor.type, input.actor.id, now);

  const result = await commitAndPublish(c, insert, {
    projectId: input.toProjectId,
    cardId: null,
    eventType: "memory.link_requested",
    actorType: input.actor.type,
    actorId: input.actor.id,
    payload: { link_id: linkId, entry_id: entry.id, from_project_id: entry.project_id, to_project_id: input.toProjectId },
    messageId: input.messageId ?? null,
    receipt: { link_id: linkId, entry_id: entry.id, state: "pending_source" },
  }).catch((error: unknown) => {
    if (error instanceof Error && /UNIQUE constraint failed: memory_entry_links\./i.test(error.message)) {
      throw new HttpError(409, "CONFLICT", "an open link for this entry and project already exists");
    }
    throw error;
  });
  if (!result) throw new HttpError(409, "CONFLICT", "link request was not recorded");

  const link = await db.prepare("SELECT * FROM memory_entry_links WHERE id = ?1").bind(linkId).first<LinkRow>();
  if (!link) throw new HttpError(500, "INTERNAL", "link missing after write");
  return {
    link,
    event: {
      seq: result.seq,
      event_id: result.event_id,
      event_pending: result.event_pending,
      ...(result.duplicate ? { duplicate: true } : {}),
    },
  };
}

function linkStateConflict(link: LinkRow, expected: string): never {
  throw new HttpError(409, "LINK_STATE_INVALID", `link is in state ${link.state}, expected ${expected}`);
}

/**
 * 人类确认。side 由批准人所在项目决定：源项目确认后才进入目标项目确认，
 * 两边都确认才 active。
 */
export async function approveLink(
  c: Context<AppEnv>,
  input: {
    projectId: string;
    linkId: string;
    side: "source" | "target";
    actor: Actor;
    messageId?: string | null;
  },
): Promise<{ link: LinkRow; event: Record<string, unknown> }> {
  const db = c.env.DB;
  const link = await db.prepare("SELECT * FROM memory_entry_links WHERE id = ?1").bind(input.linkId).first<LinkRow>();
  if (!link) throw new HttpError(404, "NOT_FOUND", "memory link not found");

  const expectedProject = input.side === "source" ? link.from_project_id : link.to_project_id;
  if (expectedProject !== input.projectId) throw new HttpError(404, "NOT_FOUND", "memory link not found");
  if (!link.entry_id) throw new HttpError(409, "SOURCE_UNAVAILABLE", "source memory entry is no longer available");
  const entry = await loadEntry(db, link.entry_id);

  const now = nowIso();
  let nextState: LinkRow["state"];
  let statement: D1PreparedStatement;
  if (input.side === "source") {
    if (link.state !== "pending_source") linkStateConflict(link, "pending_source");
    nextState = "pending_target";
    statement = db
      .prepare(`UPDATE memory_entry_links SET state = ?1, source_approved_by = ?2, source_approved_at = ?3
        WHERE id = ?4 AND state = 'pending_source'`)
      .bind(nextState, input.actor.id, now, link.id);
  } else {
    if (link.state !== "pending_target") linkStateConflict(link, "pending_target");
    if (entry.status !== "active") {
      throw new HttpError(409, "SOURCE_UNAVAILABLE", "source memory entry is not available");
    }
    nextState = "active";
    // 链接生效即冻结内容：之后源条目即使被删除，目标项目仍可读（只多一个标记）。
    statement = db
      .prepare(`UPDATE memory_entry_links
        SET state = ?1, target_approved_by = ?2, target_approved_at = ?3,
            frozen_title = ?5, frozen_body = ?6, frozen_body_hash = ?7, frozen_at = ?3
        WHERE id = ?4 AND state = 'pending_target'`)
      .bind(nextState, input.actor.id, now, link.id, entry.title, entry.body, entry.body_hash);
  }

  const result = await commitAndPublish(c, statement, {
    projectId: input.projectId,
    cardId: null,
    eventType: input.side === "source" ? "memory.link_source_approved" : "memory.link_activated",
    actorType: input.actor.type,
    actorId: input.actor.id,
    payload: { link_id: link.id, entry_id: link.entry_id, state: nextState, side: input.side },
    messageId: input.messageId ?? null,
    receipt: { link_id: link.id, state: nextState },
  });
  if (!result) throw new HttpError(409, "LINK_STATE_INVALID", "link changed while approving");

  const updated = await db.prepare("SELECT * FROM memory_entry_links WHERE id = ?1").bind(link.id).first<LinkRow>();
  if (!updated) throw new HttpError(500, "INTERNAL", "link missing after approval");
  return {
    link: updated,
    event: {
      seq: result.seq,
      event_id: result.event_id,
      event_pending: result.event_pending,
      ...(result.duplicate ? { duplicate: true } : {}),
    },
  };
}

export async function rejectLink(
  c: Context<AppEnv>,
  input: { projectId: string; linkId: string; actor: Actor; reason?: string | null; messageId?: string | null },
): Promise<{ link: LinkRow; event: Record<string, unknown> }> {
  const db = c.env.DB;
  const link = await db.prepare("SELECT * FROM memory_entry_links WHERE id = ?1").bind(input.linkId).first<LinkRow>();
  if (!link) throw new HttpError(404, "NOT_FOUND", "memory link not found");
  if (link.from_project_id !== input.projectId && link.to_project_id !== input.projectId) {
    throw new HttpError(404, "NOT_FOUND", "memory link not found");
  }
  if (link.state !== "pending_source" && link.state !== "pending_target") {
    linkStateConflict(link, "pending_source|pending_target");
  }

  const now = nowIso();
  const statement = db
    .prepare(`UPDATE memory_entry_links SET state = 'rejected', rejected_by = ?1, rejected_at = ?2, rejected_reason = ?3
      WHERE id = ?4 AND state IN ('pending_source','pending_target')`)
    .bind(input.actor.id, now, input.reason ?? null, link.id);

  const result = await commitAndPublish(c, statement, {
    projectId: input.projectId,
    cardId: null,
    eventType: "memory.link_rejected",
    actorType: input.actor.type,
    actorId: input.actor.id,
    payload: { link_id: link.id, entry_id: link.entry_id },
    messageId: input.messageId ?? null,
    receipt: { link_id: link.id, state: "rejected" },
  });
  if (!result) throw new HttpError(409, "LINK_STATE_INVALID", "link changed while rejecting");

  const updated = await db.prepare("SELECT * FROM memory_entry_links WHERE id = ?1").bind(link.id).first<LinkRow>();
  if (!updated) throw new HttpError(500, "INTERNAL", "link missing after rejection");
  return {
    link: updated,
    event: {
      seq: result.seq,
      event_id: result.event_id,
      event_pending: result.event_pending,
      ...(result.duplicate ? { duplicate: true } : {}),
    },
  };
}

export async function revokeLink(
  c: Context<AppEnv>,
  input: { projectId: string; linkId: string; actor: Actor; reason?: string | null; messageId?: string | null },
): Promise<{ link: LinkRow; event: Record<string, unknown> }> {
  const db = c.env.DB;
  const link = await db.prepare("SELECT * FROM memory_entry_links WHERE id = ?1").bind(input.linkId).first<LinkRow>();
  if (!link || link.from_project_id !== input.projectId) throw new HttpError(404, "NOT_FOUND", "memory link not found");
  if (link.state !== "active" && link.state !== "pending_target") {
    throw new HttpError(409, "LINK_STATE_INVALID", `link is in state ${link.state}`);
  }

  const now = nowIso();
  const statement = db
    .prepare("UPDATE memory_entry_links SET state = 'revoked', revoked_by = ?1, revoked_at = ?2 WHERE id = ?3 AND state IN ('active','pending_target')")
    .bind(input.actor.id, now, link.id);

  const result = await commitAndPublish(c, statement, {
    projectId: input.projectId,
    cardId: null,
    eventType: "memory.link_revoked",
    actorType: input.actor.type,
    actorId: input.actor.id,
    payload: { link_id: link.id, entry_id: link.entry_id, reason: input.reason ?? null },
    messageId: input.messageId ?? null,
    receipt: { link_id: link.id, state: "revoked" },
  });
  if (!result) throw new HttpError(409, "LINK_STATE_INVALID", "link changed while revoking");

  const updated = await db.prepare("SELECT * FROM memory_entry_links WHERE id = ?1").bind(link.id).first<LinkRow>();
  if (!updated) throw new HttpError(500, "INTERNAL", "link missing after revoke");
  return {
    link: updated,
    event: {
      seq: result.seq,
      event_id: result.event_id,
      event_pending: result.event_pending,
      ...(result.duplicate ? { duplicate: true } : {}),
    },
  };
}

/** 项目视角的链接列表（源方向 + 目标方向），供人类审批面板使用。 */
export async function listLinks(db: D1Database, projectId: string): Promise<LinkRow[]> {
  const rows = await db
    .prepare(`SELECT * FROM memory_entry_links
      WHERE from_project_id = ?1 OR to_project_id = ?1
      ORDER BY requested_at DESC LIMIT 200`)
    .bind(projectId)
    .all<LinkRow>();
  return rows.results;
}

/**
 * 指针不是表，而是查询结果：只有**同时**在源项目与目标项目 active 的 agent 才能
 * 看到这条链接。成员关系一断，指针自然消失，不存在过期指针。
 */
export async function listPointers(
  db: D1Database,
  _agentId: string,
  targetProjectId: string,
): Promise<Array<{ link: LinkRow; entry: { id: string; title: string; source_deleted: boolean } }>> {
  // 快照归目标项目：只看目标项目，不再要求读者在源项目里。
  const links = await db
    .prepare(`SELECT * FROM memory_entry_links
      WHERE to_project_id = ?1 AND state = 'active'
      ORDER BY target_approved_at DESC LIMIT 200`)
    .bind(targetProjectId)
    .all<LinkRow>();

  const ids = links.results
    .map((link) => link.entry_id)
    .filter((id): id is string => typeof id === "string");
  const alive = new Map<string, boolean>();
  if (ids.length) {
    const rows = await db
      .prepare(`SELECT id, status FROM memory_entries WHERE id IN (${ids.map((_, index) => `?${index + 1}`).join(",")})`)
      .bind(...ids)
      .all<{ id: string; status: string }>();
    for (const row of rows.results) alive.set(row.id, row.status === "active");
  }

  return links.results.map((link) => ({
    link,
    entry: {
      id: link.entry_id ?? "",
      title: link.frozen_title ?? "",
      source_deleted: Boolean(link.entry_id) ? !alive.get(link.entry_id!) : true,
    },
  }));
}

/**
 * 通过链接读取内容。服务的是链接生效时冻结的快照，且**只校验目标项目**：
 * 源条目/源项目即使被物理删除，目标项目照旧可读，只把 source_missing 置真。
 */
export async function readPointer(
  db: D1Database,
  _agentId: string,
  targetProjectId: string,
  linkId: string,
): Promise<{
  link: LinkRow;
  entry: {
    id: string;
    title: string;
    body: string;
    body_hash: string;
    source_deleted: boolean;
    source_missing: boolean;
  };
}> {
  const link = await db.prepare("SELECT * FROM memory_entry_links WHERE id = ?1").bind(linkId).first<LinkRow>();
  if (!link || link.to_project_id !== targetProjectId) throw new HttpError(404, "NOT_FOUND", "memory link not found");
  if (link.state !== "active") {
    throw new HttpError(410, link.state === "revoked" ? "LINK_REVOKED" : "LINK_INACTIVE", `memory link is ${link.state}`);
  }

  const source = link.entry_id
    ? await db.prepare("SELECT status FROM memory_entries WHERE id = ?1").bind(link.entry_id).first<{ status: string }>()
    : null;

  return {
    link,
    entry: {
      id: link.entry_id ?? "",
      title: link.frozen_title ?? "",
      body: link.frozen_body ?? "",
      body_hash: link.frozen_body_hash ?? "",
      source_deleted: !source || source.status !== "active",
      source_missing: !source,
    },
  };
}
