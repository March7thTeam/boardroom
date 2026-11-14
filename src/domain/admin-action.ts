import { HttpError } from "../lib/http-error";
import type { CardRow } from "../types";

export type AdminActionLevel = "project_owner" | "project_admin" | "instance_admin";
export type AdminActionKind = "engage" | "verify" | "cancel" | "release" | "reset";
export type AdminActionSkippedGate =
  | "proposal"
  | "agent_acceptance"
  | "evidence_required"
  | "verifier_conflict"
  | "active_work"
  | "attempt_lease"
  | "round_limit";

export interface AdminActionActor {
  globalAdmin: boolean;
  projectRole: "owner" | "admin" | "member" | null;
}

/**
 * The effective level is the narrowest applicable scope. An explicit project
 * owner/admin acts as the project-level role inside that project; instance
 * admins keep instance-wide reach and also cover projects they do not belong to.
 */
export function resolveAdminActionLevel(actor: AdminActionActor): AdminActionLevel | null {
  if (actor.projectRole === "owner") return "project_owner";
  if (actor.projectRole === "admin") return "project_admin";
  if (actor.globalAdmin) return "instance_admin";
  return null;
}

export function assertAdminActionLevel(
  level: AdminActionLevel | null,
): asserts level is AdminActionLevel {
  if (!level) {
    throw new HttpError(
      403,
      "ADMIN_PRIVILEGED_FORBIDDEN",
      "admin action requires a project owner, project admin, or instance admin",
    );
  }
}

/**
 * Admin actions are a bounded governance escape hatch, not a generic "set any
 * status" endpoint. Each action has an explicit from/to contract:
 *
 * - engage  open -> engaged        skip proposal + agent acceptance
 * - verify  review -> closed       skip evidence + verifier conflict
 * - cancel  any non-closed -> closed(cancelled)  abuse / emergency stop
 * - release running -> engaged     abandon ticket + clear lease
 * - reset   engaged|running|review -> open       platform-bug recovery
 */
export function assertAdminActionState(action: AdminActionKind, card: CardRow): void {
  const allowed: Record<AdminActionKind, readonly string[]> = {
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
      `admin action ${action} does not allow a card in ${card.status}`,
      { action, from: card.status, allowed: allowed[action] },
    );
  }
}

export interface DirectEngageTermsInput {
  card: CardRow;
  assigneeAgentId: string;
  level: AdminActionLevel;
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
    admin_action: {
      level: input.level,
      action: "engage",
      by: input.actorUserId,
      reason: input.reason,
      at: input.now,
      synthetic: true,
    },
  };
}

export function collectSkippedGates(input: {
  verdict: "pass" | "reject";
  evidenceCount: number;
  verifierConflict: string | null;
}): AdminActionSkippedGate[] {
  const skipped: AdminActionSkippedGate[] = [];
  if (input.verdict === "pass" && input.evidenceCount === 0) skipped.push("evidence_required");
  if (input.verifierConflict) skipped.push("verifier_conflict");
  return skipped;
}
