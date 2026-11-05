import { HttpError } from "../lib/http-error";
import type { CardRow } from "../types";

export type ShortCircuitLevel = "project_owner" | "instance_admin";
export type ShortCircuitAction = "engage" | "verify";
export type ShortCircuitBypass =
  | "proposal"
  | "agent_acceptance"
  | "evidence_required"
  | "verifier_conflict";

export interface ShortCircuitActor {
  globalAdmin: boolean;
  projectRole: "owner" | "member" | null;
}

/**
 * The effective level is the highest applicable one. An instance admin who is
 * also an explicit project member still acts as an instance admin; a project
 * owner acts only inside their own project (scope is enforced by the caller's
 * project lookup).
 */
export function resolveShortCircuitLevel(actor: ShortCircuitActor): ShortCircuitLevel | null {
  if (actor.globalAdmin) return "instance_admin";
  if (actor.projectRole === "owner") return "project_owner";
  return null;
}

export function assertShortCircuitLevel(
  level: ShortCircuitLevel | null,
): asserts level is ShortCircuitLevel {
  if (!level) {
    throw new HttpError(
      403,
      "SHORT_CIRCUIT_FORBIDDEN",
      "short-circuit requires a project owner or an instance admin",
    );
  }
}

/**
 * Short-circuit is deliberately narrow: it only skips the two gates that
 * dead-end the normal protocol. It is not a generic "set any status" escape.
 */
export function assertShortCircuitState(action: ShortCircuitAction, card: CardRow): void {
  if (card.paused_at) {
    throw new HttpError(409, "CARD_PAUSED", "card is paused");
  }
  const expected = action === "engage" ? "open" : "review";
  if (card.status !== expected) {
    throw new HttpError(
      409,
      "SHORT_CIRCUIT_STATE",
      `short-circuit ${action} requires a card in ${expected}`,
      { action, from: card.status, expected },
    );
  }
}

export interface DirectEngageTermsInput {
  card: CardRow;
  assigneeAgentId: string;
  level: ShortCircuitLevel;
  actorUserId: string;
  reason: string;
  now: string;
}

/**
 * Terms for a synthetic direct engagement. Keeping them in one builder makes
 * the audit payload and the contract hash verifiable from the same source.
 */
export function buildDirectEngageTerms(input: DirectEngageTermsInput): Record<string, unknown> {
  let criteria: unknown = [];
  if (input.card.criteria_json) {
    try {
      criteria = JSON.parse(input.card.criteria_json);
    } catch {
      criteria = [];
    }
  }
  return {
    kind: "direct_engage",
    card_id: input.card.id,
    title: input.card.title,
    assignee_agent_id: input.assigneeAgentId,
    criteria,
    short_circuit: {
      level: input.level,
      action: "engage",
      by: input.actorUserId,
      reason: input.reason,
      at: input.now,
      synthetic: true,
    },
  };
}

export function verifyBypasses(input: {
  verdict: "pass" | "reject";
  evidenceCount: number;
  verifierConflict: string | null;
}): ShortCircuitBypass[] {
  const bypassed: ShortCircuitBypass[] = [];
  if (input.verdict === "pass" && input.evidenceCount === 0) bypassed.push("evidence_required");
  if (input.verifierConflict) bypassed.push("verifier_conflict");
  return bypassed;
}
