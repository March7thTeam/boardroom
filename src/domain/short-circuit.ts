import { HttpError } from "../lib/http-error";
import type { CardRow } from "../types";

export type ShortCircuitLevel = "project_owner" | "instance_admin";
export type ShortCircuitAction = "engage" | "verify" | "cancel" | "release" | "reset";
export type ShortCircuitBypass =
  | "proposal"
  | "agent_acceptance"
  | "evidence_required"
  | "verifier_conflict"
  | "active_work"
  | "attempt_lease"
  | "round_limit";

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
      "ADMIN_PRIVILEGED_FORBIDDEN",
      "short-circuit requires a project owner or an instance admin",
    );
  }
}

/**
 * Short-circuit is a bounded governance escape hatch, not a generic "set any
 * status" endpoint. Each action has an explicit from/to contract:
 *
 * - engage  open -> engaged        skip proposal + agent acceptance
 * - verify  review -> closed       skip evidence + verifier conflict
 * - cancel  any non-closed -> closed(cancelled)  abuse / emergency stop
 * - release running -> engaged     abandon ticket + clear lease
 * - reset   engaged|running|review -> open       platform-bug recovery
 */
export function assertShortCircuitState(action: ShortCircuitAction, card: CardRow): void {
  const allowed: Record<ShortCircuitAction, readonly string[]> = {
    engage: ["open"],
    verify: ["review"],
    cancel: ["open", "engaged", "running", "review"],
    release: ["running"],
    reset: ["engaged", "running", "review"],
  };
  // Cancelling a paused card is the whole point of the emergency stop; every
  // other action must resume it first so the normal pause invariant holds.
  if (action !== "cancel" && card.paused_at) {
    throw new HttpError(409, "CARD_PAUSED", "card is paused");
  }
  if (!allowed[action].includes(card.status)) {
    throw new HttpError(
      409,
      "ADMIN_ACTION_STATE",
      `short-circuit ${action} does not allow a card in ${card.status}`,
      { action, from: card.status, allowed: allowed[action] },
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
