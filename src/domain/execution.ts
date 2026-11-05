import canonicalize from "canonicalize";
import { sha256Hex } from "../lib/crypto";
import { HttpError } from "../lib/http-error";
import type { CardRow } from "../types";

/**
 * All writes for one aggregate use the same card snapshot in a D1 batch.
 * Related rows are written first and the card CAS is last, so no failed CAS
 * can commit a partial mutation. Every attempt/contract state change must
 * increment the card version in that same batch.
 */
export function guardedCardWrite(
  db: D1Database,
  card: CardRow,
  sql: string,
  values: unknown[] = [],
): D1PreparedStatement {
  const n = values.length;
  const guard = `EXISTS (SELECT 1 FROM cards AS current_card
    WHERE current_card.id = ?${n + 1} AND current_card.version = ?${n + 2}
      AND current_card.status = ?${n + 3} AND current_card.paused_at IS ?${n + 4}
      AND current_card.assignee_agent_id IS ?${n + 5})`;
  return db.prepare(sql.replaceAll("/* current_card */", guard))
    .bind(...values, card.id, card.version, card.status, card.paused_at, card.assignee_agent_id);
}

/** Retire live work only; completed contracts and evidence remain historical. */
export function retireCardWork(
  db: D1Database, card: CardRow, now: string,
  contractState: "superseded" | "breached" = "superseded",
  sessionState: "cancelled" | "failed" = "cancelled",
): D1PreparedStatement[] {
  return [
    guardedCardWrite(db, card, `UPDATE proposals SET status = 'expired'
      WHERE session_id IN (SELECT id FROM negotiation_sessions WHERE card_id = ?1)
        AND status IN ('offered','countered') AND /* current_card */`, [card.id]),
    guardedCardWrite(db, card, `UPDATE negotiation_sessions SET state = ?3, closed_at = ?1
      WHERE card_id = ?2 AND state = 'open' AND /* current_card */`, [now, card.id, sessionState]),
    guardedCardWrite(db, card, `UPDATE contracts SET state = ?3, closed_at = ?1
      WHERE card_id = ?2 AND state = 'active' AND /* current_card */`, [now, card.id, contractState]),
    guardedCardWrite(db, card, `UPDATE attempts SET status = 'abandoned', ended_at = ?1
      WHERE card_id = ?2 AND status IN ('issued','running') AND /* current_card */`, [now, card.id]),
  ];
}

export interface ExecTarget {
  provider: "github_actions";
  owner: string;
  repo: string;
  workflows: string[];
}

export function parseExecTargets(json: string | null | undefined): ExecTarget[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const targets: ExecTarget[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.provider !== "github_actions") continue;
    if (typeof record.owner !== "string" || typeof record.repo !== "string") continue;
    const workflows = Array.isArray(record.workflows)
      ? record.workflows.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    if (workflows.length === 0) continue;
    targets.push({
      provider: "github_actions",
      owner: record.owner,
      repo: record.repo,
      workflows,
    });
  }
  return targets;
}

export function selectExecTarget(
  targets: ExecTarget[],
  owner: string | undefined,
  repo: string | undefined,
  workflow: string | undefined,
): { target: ExecTarget; workflow: string } | null {
  for (const target of targets) {
    if (owner && target.owner !== owner) continue;
    if (repo && target.repo !== repo) continue;
    if (workflow) {
      if (target.workflows.includes(workflow)) return { target, workflow };
      continue;
    }
    return { target, workflow: target.workflows[0]! };
  }
  return null;
}

export interface EvidenceDigestItem {
  kind: string;
  sha256: string;
  size_bytes: number;
}

/** Evidence has set semantics, matching UNIQUE(card_id, sha256, kind). */
export function normalizeEvidence<T extends EvidenceDigestItem>(items: T[]): T[] {
  const unique = new Map<string, T>();
  for (const item of items) {
    const key = JSON.stringify([item.kind, item.sha256]);
    const previous = unique.get(key);
    if (previous && previous.size_bytes !== item.size_bytes) {
      throw new HttpError(422, "INVALID_ARGUMENT", "the same evidence hash cannot declare conflicting sizes");
    }
    if (!previous) unique.set(key, item);
  }
  return [...unique.values()];
}

/** Stable digest of the declared evidence set; content is not downloaded in S2. */
export async function evidenceHash(items: EvidenceDigestItem[]): Promise<string> {
  const canonical = canonicalize(
    normalizeEvidence(items)
      .map((item) => ({
        kind: item.kind,
        sha256: item.sha256,
        size_bytes: item.size_bytes,
      }))
      .sort((a, b) => a.sha256.localeCompare(b.sha256) || a.kind.localeCompare(b.kind)),
  );
  if (canonical === undefined) throw new Error("evidence must be JSON-serializable");
  return `sha256:${await sha256Hex(canonical)}`;
}
