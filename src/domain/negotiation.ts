import canonicalize from "canonicalize";
import { constantTimeEqual, hmacSha256Base64Url, sha256Hex } from "../lib/crypto";

export const MAX_NEGOTIATION_ROUNDS = 5;

export interface AcceptanceProof {
  /** Agent id that produced the proof. */
  by?: string;
  alg: string;
  value: string;
}

/**
 * RFC 8785 JCS + SHA-256, matching `boardroom-connect-skill`'s `termsHash()`.
 */
export async function termsHash(terms: unknown): Promise<string> {
  const canonical = canonicalize(terms);
  if (canonical === undefined) {
    throw new Error("terms must be JSON-serializable");
  }
  return `sha256:${await sha256Hex(canonical)}`;
}

export async function assertTermsHash(terms: unknown, provided: string): Promise<string> {
  const computed = await termsHash(terms);
  if (computed !== provided) {
    throw new Error(`terms_hash mismatch: expected ${computed}, got ${provided}`);
  }
  return computed;
}

/**
 * Verify `base64url(HMAC-SHA256(agentSecret, termsHash))`. The agent secret is
 * available from the authenticated Bearer token for the duration of the request.
 */
export async function verifyAcceptanceProof(
  agentSecret: string,
  termsHashValue: string,
  proof: AcceptanceProof | undefined,
  agentId: string,
): Promise<boolean> {
  if (!proof || proof.alg !== "HMAC-SHA256" || typeof proof.value !== "string") {
    return false;
  }
  if (proof.by && proof.by !== agentId) return false;
  const expected = await hmacSha256Base64Url(agentSecret, termsHashValue);
  return constantTimeEqual(expected, proof.value);
}

export interface ContractReceipt {
  by_type: "agent" | "user";
  by_id: string;
  terms_hash: string;
  accepted_at: string;
  request_id: string;
  proof?: AcceptanceProof;
}

export function buildContractReceipt(input: {
  actorType: "agent" | "user";
  actorId: string;
  termsHash: string;
  requestId: string;
  proof?: AcceptanceProof;
}): ContractReceipt {
  return {
    by_type: input.actorType,
    by_id: input.actorId,
    terms_hash: input.termsHash,
    accepted_at: new Date().toISOString(),
    request_id: input.requestId,
    ...(input.proof ? { proof: input.proof } : {}),
  };
}
