import type { ContractRow } from "../types";

/**
 * Whether accepting a proposal should also bar that person from verifying the card.
 *
 * The human requester is the only party allowed to accept a proposal, so treating
 * acceptance as a verifier conflict dead-ends every card in a single-member project:
 * requester = acceptor = permanent VERIFIER_CONFLICT. Only the party that proposed
 * the terms is barred here; the agent side cannot call the human verify endpoint anyway.
 */
export function verifierConflict(
  contract: Pick<
    ContractRow,
    "proposer_agent_id" | "proposer_user_id" | "acceptor_agent_id" | "acceptor_user_id"
  > | null,
  userId: string,
): "PROPOSER_IS_VERIFIER" | null {
  if (!contract) return null;
  if (contract.proposer_user_id !== null && contract.proposer_user_id === userId) {
    return "PROPOSER_IS_VERIFIER";
  }
  return null;
}
