import { addMinutesIso, nowIso } from "../lib/time";
import { guardedCardWrite } from "./execution";
import { commitCardEvent, publishCommitted } from "../lib/event-store";
import type { CardRow, Env } from "../types";

async function emitSystemEvent(
  env: Env, projectId: string, cardId: string, eventType: string,
  payload: unknown, messageId: string, mutations: D1PreparedStatement[],
): Promise<boolean> {
  const saved = await commitCardEvent(env.DB, mutations, {
    projectId, cardId, eventType, actorType: "system", actorId: "system", payload, messageId,
  });
  if (!saved) return false;
  await publishCommitted(env, saved);
  return true;
}

/** Snapshot guards protect both the card and its related rows in one batch. */
export async function sweepProject(
  env: Env,
  projectId: string,
): Promise<{ sessions: number; attempts: number; leases: number }> {
  const now = nowIso();
  const sessionDeadline = addMinutesIso(-15);
  const ticketDeadline = addMinutesIso(-10);
  let sessions = 0;
  let attempts = 0;
  let leases = 0;

  const staleSessions = await env.DB.prepare(
    `SELECT c.*, s.id AS session_id
       FROM negotiation_sessions s JOIN cards c ON c.id = s.card_id
      WHERE c.project_id = ?1 AND c.paused_at IS NULL AND c.status = 'open'
        AND s.state = 'open' AND s.round = c.round AND s.created_at < ?2`,
  ).bind(projectId, sessionDeadline).all<CardRow & { session_id: string }>();

  for (const card of staleSessions.results) {
    const mutations = [
      guardedCardWrite(env.DB, card,
        `UPDATE proposals SET status = 'expired' WHERE session_id = ?1
          AND status IN ('offered','countered') AND /* current_card */`, [card.session_id]),
      guardedCardWrite(env.DB, card,
        `UPDATE negotiation_sessions SET state = 'expired', closed_at = ?1
          WHERE id = ?2 AND state = 'open' AND /* current_card */`, [now, card.session_id]),
      guardedCardWrite(env.DB, card,
        `UPDATE cards SET round = MIN(round + 1, 5), version = version + 1, updated_at = ?1
          WHERE id = ?2 AND /* current_card */`, [now, card.id]),
    ];
    if (!(await emitSystemEvent(env, projectId, card.id, "negotiation.timeout",
      { session_id: card.session_id, round: card.round }, `timeout:${card.session_id}`, mutations))) continue;
    sessions++;
  }

  const staleTickets = await env.DB.prepare(
    `SELECT c.*, a.id AS attempt_id
       FROM attempts a JOIN cards c ON c.id = a.card_id
      WHERE c.project_id = ?1 AND c.paused_at IS NULL AND c.status = 'running'
        AND a.status = 'issued' AND a.started_at < ?2`,
  ).bind(projectId, ticketDeadline).all<CardRow & { attempt_id: string }>();

  for (const card of staleTickets.results) {
    const mutations = [
      guardedCardWrite(env.DB, card,
        `UPDATE attempts SET status = 'abandoned', ended_at = ?1
          WHERE id = ?2 AND status = 'issued' AND /* current_card */`, [now, card.attempt_id]),
      guardedCardWrite(env.DB, card,
        `UPDATE cards SET status = 'engaged', version = version + 1,
          lease_owner = NULL, lease_expires_at = NULL, updated_at = ?1
          WHERE id = ?2 AND /* current_card */`, [now, card.id]),
    ];
    if (!(await emitSystemEvent(env, projectId, card.id, "ticket.expired",
      { attempt_id: card.attempt_id }, `ticket-expired:${card.attempt_id}`, mutations))) continue;
    attempts++;
  }

  const expiredLeases = await env.DB.prepare(
    `SELECT * FROM cards
      WHERE project_id = ?1 AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
        AND lease_expires_at < ?2 AND paused_at IS NULL`,
  ).bind(projectId, now).all<CardRow>();

  for (const card of expiredLeases.results) {
    // Lease renewals deliberately do not bump card.version, so compare the
    // exact lease snapshot as well as the aggregate version before any write.
    const mutations = [
      guardedCardWrite(env.DB, card,
        `UPDATE attempts SET status = 'abandoned', ended_at = ?1
          WHERE card_id = ?2 AND status IN ('issued','running') AND /* current_card */
            AND EXISTS (SELECT 1 FROM cards WHERE id = ?2 AND lease_owner = ?3 AND lease_expires_at = ?4)`,
        [now, card.id, card.lease_owner, card.lease_expires_at]),
      guardedCardWrite(env.DB, card,
        `UPDATE cards SET lease_owner = NULL, lease_expires_at = NULL,
          status = CASE WHEN status = 'running' THEN 'engaged' ELSE status END,
          version = version + 1, updated_at = ?1
          WHERE id = ?2 AND lease_owner = ?3 AND lease_expires_at = ?4 AND /* current_card */`,
        [now, card.id, card.lease_owner, card.lease_expires_at]),
    ];
    if (!(await emitSystemEvent(env, projectId, card.id, "lease.expired",
      { lease_owner: card.lease_owner, lease_expires_at: card.lease_expires_at },
      `lease-expired:${card.id}:${card.lease_expires_at ?? ""}`, mutations))) continue;
    leases++;
  }

  return { sessions, attempts, leases };
}
