import canonicalize from "canonicalize";
import { sha256Hex } from "../lib/crypto";
import type { AuditRow, CardEventRow } from "../types";

export const ZERO_HASH = `sha256:${"0".repeat(64)}`;

export interface AuditWatermark {
  projectId: string;
  seq: number;
  eventType: string;
  actorType: "agent" | "user" | "system";
  actorId: string;
  cardId: string | null;
  payload: unknown;
  createdAt: string;
}

export async function auditHash(prevHash: string, entry: AuditWatermark): Promise<string> {
  const canonical = canonicalize({
    project_id: entry.projectId,
    seq: entry.seq,
    event_type: entry.eventType,
    actor: { type: entry.actorType, id: entry.actorId },
    card_id: entry.cardId,
    payload: entry.payload,
    created_at: entry.createdAt,
  });
  if (!canonical) throw new Error("failed to canonicalize audit entry");
  return `sha256:${await sha256Hex(`${prevHash}\n${canonical}\n${entry.seq}`)}`;
}

export interface AuditVerifyResult {
  ok: boolean;
  checked: number;
  head: { seq: number; hash: string } | null;
  errors: Array<{ seq: number; code: "CHAIN_BREAK" | "HASH_MISMATCH" | "SEQ_GAP"; message: string }>;
}

export interface ProjectAuditVerifyResult extends AuditVerifyResult {
  /** Unpublished accepted events at the same transaction boundary as as_of_seq. */
  pending: number;
  /** All accepted events at that boundary have been published and verified. */
  complete: boolean;
  as_of_seq: number;
  as_of_outbox_order: number;
}

export async function verifyAuditChain(rows: AuditRow[], preceding?: { seq: number; hash: string }): Promise<AuditVerifyResult> {
  const errors: AuditVerifyResult["errors"] = [];
  let prevHash = preceding?.hash ?? ZERO_HASH;
  let expectedSeq = (preceding?.seq ?? 0) + 1;

  for (const row of rows) {
    if (row.seq !== expectedSeq) {
      errors.push({
        seq: row.seq,
        code: "SEQ_GAP",
        message: `expected seq ${expectedSeq}, got ${row.seq}`,
      });
      expectedSeq = row.seq;
    }

    if (row.prev_hash !== prevHash) {
      errors.push({
        seq: row.seq,
        code: "CHAIN_BREAK",
        message: `prev_hash does not match seq ${row.seq - 1}`,
      });
    }

    let payload: unknown = null;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      errors.push({ seq: row.seq, code: "HASH_MISMATCH", message: "audit payload is not valid JSON" });
      payload = null;
    }

    const recomputed = await auditHash(row.prev_hash, {
      projectId: row.project_id,
      seq: row.seq,
      eventType: row.event_type,
      actorType: row.actor_type,
      actorId: row.actor_id,
      cardId: row.card_id,
      payload,
      createdAt: row.created_at,
    });

    if (recomputed !== row.hash) {
      errors.push({
        seq: row.seq,
        code: "HASH_MISMATCH",
        message: `stored hash does not match recomputed hash at seq ${row.seq}`,
      });
    }

    prevHash = row.hash;
    expectedSeq = row.seq + 1;
  }

  const last = rows.at(-1);
  return {
    ok: errors.length === 0,
    checked: rows.length,
    head: last ? { seq: last.seq, hash: last.hash } : null,
    errors,
  };
}

/** Verify a frozen published boundary in bounded pages, including missing tails. */
export async function verifyProjectAudit(db: D1Database, projectId: string, pageSize = 500): Promise<ProjectAuditVerifyResult> {
  const bounds = await db.batch([
    db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM card_events WHERE project_id = ?1").bind(projectId),
    db.prepare("SELECT seq, hash FROM project_event_heads WHERE project_id = ?1").bind(projectId),
    db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM audit_log WHERE project_id = ?1").bind(projectId),
    db.prepare(`SELECT COUNT(CASE WHEN published_seq IS NULL THEN 1 END) AS pending,
      COALESCE(MAX(order_id), 0) AS outbox_order FROM event_outbox WHERE project_id = ?1`).bind(projectId),
  ]);
  const eventMax = Number((bounds[0].results[0] as { seq: number }).seq);
  const checkpoint = bounds[1].results[0] as { seq: number; hash: string } | undefined;
  const auditMax = Number((bounds[2].results[0] as { seq: number }).seq);
  const expectedMax = checkpoint?.seq ?? eventMax;
  const outbox = bounds[3].results[0] as { pending: number; outbox_order: number };
  const result: ProjectAuditVerifyResult = { ok: true, checked: 0, head: null, errors: [],
    pending: Number(outbox.pending), complete: false, as_of_seq: expectedMax, as_of_outbox_order: Number(outbox.outbox_order) };
  if (eventMax !== expectedMax || auditMax !== expectedMax) {
    result.errors.push({ seq: Math.min(auditMax, eventMax, expectedMax) + 1, code: "SEQ_GAP",
      message: `published boundary ${expectedMax}, events end ${eventMax}, audit end ${auditMax}` });
  }
  let after = 0;
  while (after < expectedMax) {
    const page = await db.prepare(`SELECT * FROM audit_log WHERE project_id = ?1 AND seq > ?2 AND seq <= ?3
      ORDER BY seq LIMIT ?4`).bind(projectId, after, expectedMax, pageSize).all<AuditRow>();
    if (!page.results.length) break;
    const verified = await verifyAuditChain(page.results, result.head ?? undefined);
    // A valid audit chain alone cannot prove the SSE event history is intact:
    // its middle rows may be missing or damaged while both MAX(seq) values agree.
    const events = await db.prepare(`SELECT e.* FROM card_events e
      WHERE e.project_id = ?1 AND e.seq IN (
        SELECT seq FROM audit_log WHERE project_id = ?1 AND seq > ?2 AND seq <= ?3
        ORDER BY seq LIMIT ?4
      ) ORDER BY e.seq`).bind(projectId, after, expectedMax, pageSize).all<CardEventRow>();
    const bySeq = new Map(events.results.map((event) => [event.seq, event]));
    for (const row of page.results) {
      const event = bySeq.get(row.seq);
      if (!event) {
        if (result.errors.length < 1000) result.errors.push({ seq: row.seq, code: "SEQ_GAP", message: "published event is missing" });
        continue;
      }
      let matches = false;
      try {
        const hash = await auditHash(row.prev_hash, {
          projectId: event.project_id, seq: event.seq, eventType: event.event_type,
          actorType: event.actor_type, actorId: event.actor_id, cardId: event.card_id,
          payload: JSON.parse(event.payload_json), createdAt: event.created_at,
        });
        matches = hash === row.hash;
      } catch { /* Invalid event JSON is a mismatch, not an unhandled verifier failure. */ }
      if (!matches && result.errors.length < 1000) {
        result.errors.push({ seq: row.seq, code: "HASH_MISMATCH", message: "published event differs from its audit record" });
      }
    }
    result.checked += verified.checked;
    result.head = verified.head;
    result.errors.push(...verified.errors.slice(0, Math.max(0, 1000 - result.errors.length)));
    after = page.results[page.results.length - 1].seq;
  }
  if ((result.head?.seq ?? 0) !== expectedMax && !result.errors.some((error) => error.code === "SEQ_GAP")) {
    result.errors.push({ seq: (result.head?.seq ?? 0) + 1, code: "SEQ_GAP", message: "audit does not cover the published tail" });
  }
  if (checkpoint && (result.head?.hash ?? ZERO_HASH) !== checkpoint.hash) {
    result.errors.push({ seq: expectedMax, code: "CHAIN_BREAK", message: "audit head differs from durable checkpoint" });
  }
  result.ok = result.errors.length === 0;
  result.complete = result.ok && result.pending === 0;
  return result;
}
