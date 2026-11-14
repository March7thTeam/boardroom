import canonicalize from "canonicalize";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { AuditRow, CardEventRow, CardRow, Env } from "../types";
import { auditHash, ZERO_HASH } from "../domain/audit";
import { sha256Hex } from "./crypto";
import { HttpError } from "./http-error";
import { newId } from "./ids";
import { nowIso } from "./time";
import type { AuthPrincipal } from "./session";

/** One query per bounded principal batch, without stale authorization caching. */
export async function authorizedPrincipalIndexes(db: D1Database, principals: AuthPrincipal[], projectId: string): Promise<Set<number>> {
  const allowed = new Set<number>();
  for (let start = 0; start < principals.length; start += 200) {
    const input = principals.slice(start, start + 200).map((principal, offset) => ({ ...principal, index: start + offset }));
    const rows = await db.prepare(`WITH subjects AS (
      SELECT json_extract(value, '$.index') AS idx, json_extract(value, '$.userId') AS uid,
        json_extract(value, '$.authVersion') AS version, json_extract(value, '$.sessionId') AS sid
      FROM json_each(?1)
    ) SELECT x.idx FROM subjects x JOIN users u ON u.id = x.uid
      JOIN projects p ON p.id = ?2 AND p.archived_at IS NULL
      WHERE u.auth_version = x.version AND u.status = 'active' AND u.must_change_password = 0
        AND (u.role = 'admin' OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = u.id))
        AND (x.sid IS NULL OR EXISTS (SELECT 1 FROM user_sessions s WHERE s.id = x.sid AND s.user_id = u.id
          AND s.auth_version = u.auth_version AND s.revoked_at IS NULL AND s.expires_at > ?3))`)
      .bind(JSON.stringify(input), projectId, nowIso()).all<{ idx: number }>();
    for (const row of rows.results) allowed.add(row.idx);
  }
  return allowed;
}

export interface EventCommand {
  projectId: string;
  cardId: string | null;
  eventType: string;
  actorType: "user" | "agent" | "system";
  actorId: string;
  payload: unknown;
  messageId?: string | null;
  eventId?: string;
  createdAt?: string;
  requestHash?: string | null;
  receipt?: Record<string, unknown>;
}
export interface OutboxRow {
  order_id: number; event_id: string; project_id: string; card_id: string | null;
  message_id: string | null; event_type: string; actor_type: EventCommand["actorType"];
  actor_id: string; payload_json: string; request_hash: string | null;
  receipt_json: string; card_snapshot_json: string | null;
  created_at: string; published_seq: number | null;
}
export interface EventHead { seq: number; hash: string }
export interface CommittedEvent { row: OutboxRow; card: CardRow | null; duplicate: boolean }
export interface MutationResult {
  card: CardRow | null;
  seq: number | null;
  event_id: string;
  event_pending: boolean;
  duplicate?: boolean;
  receipt: Record<string, unknown>;
}

const CARD_COLUMNS: Array<keyof CardRow> = [
  "id", "project_id", "parent_card_id", "title", "body", "status", "outcome", "version", "round", "priority",
  "requester_agent_id", "assignee_agent_id", "assignee_user_id", "criteria_json", "verifier_id",
  "verdict_reasons_json", "lease_owner", "lease_expires_at", "paused_at", "deadline_at", "evidence_hash",
  "created_by_type", "created_by_id", "created_at", "updated_at",
];
const CARD_SNAPSHOT = `SELECT json_object(${CARD_COLUMNS.map((key) => `'${key}', c.${key}`).join(",")}) FROM cards c WHERE c.id = ?3 AND c.project_id = ?2`;
const requestHashes = new WeakMap<object, Promise<string>>();

/** Only a digest of request semantics is retained; never persist auth headers. */
export function eventRequestHash(c: Context<AppEnv>): Promise<string> {
  let hash = requestHashes.get(c);
  if (!hash) {
    hash = (async () => {
      const body: unknown = await c.req.json().catch(() => null);
      const actor = c.get("agent")?.id ?? c.get("user")?.id ?? "system";
      return sha256Hex(canonicalize({ method: c.req.method, path: c.req.path, actor, body })!);
    })();
    requestHashes.set(c, hash);
  }
  return hash;
}

function committed(row: OutboxRow, duplicate: boolean): CommittedEvent {
  return { row, duplicate, card: row.card_snapshot_json ? JSON.parse(row.card_snapshot_json) as CardRow : null };
}

function sameCommand(row: OutboxRow, command: EventCommand, payload: string, receipt: string, createdAt: string): boolean {
  return row.project_id === command.projectId && row.card_id === command.cardId &&
    row.message_id === (command.messageId ?? null) && row.event_type === command.eventType &&
    row.actor_type === command.actorType && row.actor_id === command.actorId &&
    row.payload_json === payload && row.receipt_json === receipt &&
    row.request_hash === (command.requestHash ?? null) && row.created_at === createdAt;
}

/**
 * The final mutation is the aggregate CAS. Its changes() immediately controls
 * the receipt insertion. A failed receipt insert rolls back every related write.
 * Empty mutations are reserved for message-only events (no state mutation).
 */
export async function commitCardEvent(
  db: D1Database,
  mutations: D1PreparedStatement | D1PreparedStatement[],
  command: EventCommand,
): Promise<CommittedEvent | null> {
  const statements = Array.isArray(mutations) ? mutations : [mutations];
  const eventId = command.eventId ?? newId("e");
  const payload = JSON.stringify(command.payload);
  const receipt = JSON.stringify(command.receipt ?? {});
  const createdAt = command.createdAt ?? nowIso();
  const insertion = db.prepare(`INSERT INTO event_outbox
    (event_id, project_id, card_id, message_id, event_type, actor_type, actor_id, payload_json,
      created_at, request_hash, receipt_json, card_snapshot_json)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, (${CARD_SNAPSHOT})
    WHERE ${statements.length ? "changes() = 1" : "1"}`)
    .bind(eventId, command.projectId, command.cardId, command.messageId ?? null, command.eventType,
      command.actorType, command.actorId, payload, createdAt, command.requestHash ?? null, receipt);
  try {
    const results = await db.batch([
      ...statements, insertion,
      db.prepare("SELECT * FROM event_outbox WHERE event_id = ?1").bind(eventId),
    ]);
    if (results[statements.length]!.meta.changes !== 1) return null;
    const row = results[statements.length + 1]!.results[0] as unknown as OutboxRow;
    return committed(row, false);
  } catch (error) {
    // D1 may have committed before the response was lost. Exact immutable
    // command matching avoids treating another event as this mutation's receipt.
    let row: OutboxRow | null;
    try { row = await db.prepare("SELECT * FROM event_outbox WHERE event_id = ?1").bind(eventId).first<OutboxRow>(); }
    catch { throw error; }
    if (row && sameCommand(row, command, payload, receipt, createdAt)) return committed(row, false);
    if (command.messageId && command.requestHash) {
      // Project-level events (memory) carry card_id = NULL, and SQLite's `= NULL`
      // never matches, so the replay lookup needs an IS NULL branch.
      const previous = command.cardId === null
        ? await db.prepare("SELECT * FROM event_outbox WHERE project_id = ?1 AND card_id IS NULL AND message_id = ?2")
          .bind(command.projectId, command.messageId).first<OutboxRow>()
        : await db.prepare("SELECT * FROM event_outbox WHERE card_id = ?1 AND message_id = ?2")
          .bind(command.cardId, command.messageId).first<OutboxRow>();
      if (previous) {
        if (previous.request_hash !== command.requestHash || previous.actor_id !== command.actorId || previous.actor_type !== command.actorType) {
          throw new HttpError(409, "CONFLICT", "message_id already belongs to a different request");
        }
        return committed(previous, true);
      }
    }
    throw error;
  }
}

export async function publishCommitted(env: Env, saved: CommittedEvent): Promise<MutationResult> {
  let seq = saved.row.published_seq;
  if (seq === null) {
    try { seq = (await env.BOARD_DO.getByName(saved.row.project_id).publish(saved.row.event_id)).seq; }
    catch {
      // The RPC reply may be lost after successful publication. Prefer the
      // durable marker; when even that read fails, report accepted/pending.
      const persisted = await env.DB.prepare("SELECT published_seq FROM event_outbox WHERE event_id = ?1 AND project_id = ?2")
        .bind(saved.row.event_id, saved.row.project_id).first<{ published_seq: number | null }>().catch(() => null);
      seq = persisted?.published_seq ?? null;
      if (seq === null) console.error(JSON.stringify({ event: "event_publication_pending", event_id: saved.row.event_id, project_id: saved.row.project_id }));
    }
  }
  return { card: saved.card, event_id: saved.row.event_id, seq, event_pending: seq === null,
    ...(saved.duplicate ? { duplicate: true } : {}), receipt: JSON.parse(saved.row.receipt_json) as Record<string, unknown> };
}

export async function commitAndPublish(
  c: Context<AppEnv>, mutations: D1PreparedStatement | D1PreparedStatement[], command: EventCommand,
): Promise<MutationResult | null> {
  const saved = await commitCardEvent(c.env.DB, mutations, { ...command, requestHash: command.requestHash ?? await eventRequestHash(c) });
  return saved ? publishCommitted(c.env, saved) : null;
}

/** Shared replay source for accepted-but-pending and already-published messages. */
export async function findExistingEvent(
  c: Context<AppEnv>, cardId: string, messageId: string,
): Promise<Record<string, unknown> | null> {
  const row = await c.env.DB.prepare("SELECT * FROM event_outbox WHERE card_id = ?1 AND message_id = ?2")
    .bind(cardId, messageId).first<OutboxRow>();
  if (!row) return null;
  const actor = c.get("agent")?.id ?? c.get("user")?.id;
  if (row.request_hash && (row.request_hash !== await eventRequestHash(c) || row.actor_id !== actor)) {
    throw new HttpError(409, "CONFLICT", "message_id already belongs to a different request");
  }
  const result = await publishCommitted(c.env, committed(row, true));
  return { ...JSON.parse(row.payload_json), ...result.receipt, ...(result.card ? { card: result.card } : {}),
    event_id: result.event_id, seq: result.seq, event_pending: result.event_pending, duplicate: true };
}

export function eventMetadata(result: MutationResult) {
  return { seq: result.seq, event_id: result.event_id, event_pending: result.event_pending,
    ...(result.duplicate ? { duplicate: true } : {}) };
}

function auditStatement(db: D1Database, row: CardEventRow, prev: string, hash: string) {
  return db.prepare(`INSERT INTO audit_log
    (project_id, seq, event_type, actor_type, actor_id, card_id, payload_json, prev_hash, hash, batch_id, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`)
    .bind(row.project_id, row.seq, row.event_type, row.actor_type, row.actor_id, row.card_id,
      row.payload_json, prev, hash, `event:${row.event_id}`, row.created_at);
}
async function hashEvent(prev: string, row: CardEventRow) {
  return auditHash(prev, { projectId: row.project_id, seq: row.seq, eventType: row.event_type,
    actorType: row.actor_type, actorId: row.actor_id, cardId: row.card_id, payload: JSON.parse(row.payload_json), createdAt: row.created_at });
}

/**
 * The durable checkpoint in `project_event_heads` is written in the same batch
 * as every published event and audit row. Reconciliation only validates the
 * checkpoint against the audit head; a mismatch is never repaired silently.
 */
export async function reconcileEvents(db: D1Database, projectId: string): Promise<EventHead> {
  const rows = await db.batch([
    db.prepare("SELECT seq, hash FROM audit_log WHERE project_id = ?1 ORDER BY seq DESC LIMIT 1").bind(projectId),
    db.prepare("SELECT seq, hash FROM project_event_heads WHERE project_id = ?1").bind(projectId),
  ]);
  const last = rows[0]!.results[0] as unknown as AuditRow | undefined;
  const auditHead: EventHead = { seq: last?.seq ?? 0, hash: last?.hash ?? ZERO_HASH };
  const durable = rows[1]!.results[0] as unknown as EventHead | undefined;
  if (!durable) {
    if (auditHead.seq !== 0) throw new Error("durable event/audit checkpoint mismatch");
    await db.prepare("INSERT INTO project_event_heads (project_id, seq, hash) VALUES (?1, 0, ?2)")
      .bind(projectId, ZERO_HASH).run();
    return auditHead;
  }
  if (durable.seq !== auditHead.seq || durable.hash !== auditHead.hash) throw new Error("durable event/audit checkpoint mismatch");
  return durable;
}

/** Only the serialized project BoardDO publishes an outbox row. */
export async function publishOutboxEvent(db: D1Database, row: OutboxRow, head: EventHead): Promise<EventHead> {
  const event: CardEventRow = { ...row, seq: head.seq + 1 };
  const hash = await hashEvent(head.hash, event);
  try {
    await db.batch([
      db.prepare(`INSERT INTO card_events
        (event_id, project_id, seq, card_id, message_id, event_type, actor_type, actor_id, payload_json, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
        .bind(event.event_id, event.project_id, event.seq, event.card_id, event.message_id, event.event_type,
          event.actor_type, event.actor_id, event.payload_json, event.created_at),
      auditStatement(db, event, head.hash, hash),
      db.prepare("UPDATE event_outbox SET published_seq = ?1 WHERE event_id = ?2 AND published_seq IS NULL").bind(event.seq, event.event_id),
      db.prepare("UPDATE project_event_heads SET seq = ?1, hash = ?2 WHERE project_id = ?3").bind(event.seq, hash, event.project_id),
    ]);
  } catch (error) {
    // Verify the full event and chain links, not just the event_id, after an ambiguous reply.
    const found = await db.prepare(`SELECT e.*, a.hash AS audit_hash, a.prev_hash AS audit_prev,
        a.payload_json AS audit_payload, a.event_type AS audit_type, a.actor_type AS audit_actor_type,
        a.actor_id AS audit_actor_id, a.card_id AS audit_card, a.created_at AS audit_created
      FROM event_outbox o JOIN card_events e ON e.event_id = o.event_id AND e.seq = o.published_seq
      JOIN audit_log a ON a.project_id = e.project_id AND a.seq = e.seq
      WHERE o.event_id = ?1 AND o.project_id = ?2`).bind(row.event_id, row.project_id)
      .first<CardEventRow & { audit_hash: string; audit_prev: string; audit_payload: string; audit_type: string;
        audit_actor_type: string; audit_actor_id: string; audit_card: string | null; audit_created: string }>();
    if (!found || found.seq !== event.seq || found.payload_json !== row.payload_json || found.message_id !== row.message_id ||
      found.event_type !== row.event_type || found.actor_type !== row.actor_type || found.actor_id !== row.actor_id ||
      found.card_id !== row.card_id || found.created_at !== row.created_at || found.audit_hash !== hash || found.audit_prev !== head.hash ||
      found.audit_payload !== row.payload_json || found.audit_type !== row.event_type || found.audit_actor_type !== row.actor_type ||
      found.audit_actor_id !== row.actor_id || found.audit_card !== row.card_id || found.audit_created !== row.created_at) throw error;
  }
  return { seq: event.seq, hash };
}
