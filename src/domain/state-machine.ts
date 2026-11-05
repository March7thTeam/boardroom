import { HttpError } from "../lib/http-error";

export type CardStatus = "open" | "engaged" | "running" | "review" | "closed";
export type CardOutcome = "done" | "rejected" | "cancelled" | "expired";
export type TransitionAction =
  | "commit"
  | "cancel"
  | "start"
  | "deliver"
  | "retry"
  | "verdict"
  | "rework"
  | "reopen";

interface TransitionRule {
  from: CardStatus[];
  to: CardStatus;
  outcomes?: CardOutcome[];
}

const RULES: Record<TransitionAction, TransitionRule> = {
  commit: { from: ["open"], to: "engaged" },
  cancel: { from: ["open", "engaged", "running", "review"], to: "closed", outcomes: ["cancelled"] },
  start: { from: ["engaged"], to: "running" },
  deliver: { from: ["running"], to: "review" },
  retry: { from: ["running"], to: "engaged" },
  rework: { from: ["review"], to: "engaged" },
  verdict: { from: ["review"], to: "closed", outcomes: ["done", "rejected"] },
  reopen: { from: ["closed"], to: "open" },
};

export function assertTransition(
  action: TransitionAction,
  from: CardStatus,
  outcome?: CardOutcome,
): TransitionRule {
  const rule = RULES[action];
  if (!rule.from.includes(from)) {
    throw new HttpError(
      409,
      "ILLEGAL_TRANSITION",
      `action ${action} is not allowed from ${from}`,
      { action, from, allowed_from: rule.from },
    );
  }
  if (outcome && rule.outcomes && !rule.outcomes.includes(outcome)) {
    throw new HttpError(
      409,
      "ILLEGAL_TRANSITION",
      `outcome ${outcome} is not allowed for ${action}`,
      { action, outcome, allowed_outcomes: rule.outcomes },
    );
  }
  return rule;
}

export function nextStatus(action: TransitionAction): CardStatus {
  return RULES[action].to;
}

export function isTerminal(status: CardStatus): boolean {
  return status === "closed";
}
