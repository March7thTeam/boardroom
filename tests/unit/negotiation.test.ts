import { describe, expect, it } from "vitest";
import {
  buildContractReceipt,
  termsHash,
  verifyAcceptanceProof,
} from "../../src/domain/negotiation";
import { hmacSha256Base64Url } from "../../src/lib/crypto";

describe("negotiation terms", () => {
  it("hashes JCS terms deterministically", async () => {
    const a = await termsHash({ price: 100, currency: "USD", qty: 2 });
    const b = await termsHash({ qty: 2, price: 100, currency: "USD" });
    expect(a).toBe(b);
    expect(a.startsWith("sha256:")).toBe(true);
  });

  it("verifies an agent acceptance proof", async () => {
    const secret = "agent-secret";
    const hash = await termsHash({ scope: ["normalize"] });
    const value = await hmacSha256Base64Url(secret, hash);
    expect(
      await verifyAcceptanceProof(
        secret,
        hash,
        { by: "alpha:agent", alg: "HMAC-SHA256", value },
        "alpha:agent",
      ),
    ).toBe(true);
    expect(
      await verifyAcceptanceProof(
        secret,
        hash,
        { by: "alpha:agent", alg: "HMAC-SHA256", value },
        "alpha:other",
      ),
    ).toBe(false);
    expect(
      await verifyAcceptanceProof(
        secret,
        hash,
        { by: "alpha:agent", alg: "HMAC-SHA256", value: "wrong" },
        "alpha:agent",
      ),
    ).toBe(false);
  });

  it("records a server receipt for human acceptance", () => {
    const receipt = buildContractReceipt({
      actorType: "user",
      actorId: "usr_1",
      termsHash: "sha256:abc",
      requestId: "req_1",
    });
    expect(receipt).toMatchObject({
      by_type: "user",
      by_id: "usr_1",
      terms_hash: "sha256:abc",
      request_id: "req_1",
    });
    expect(typeof receipt.accepted_at).toBe("string");
  });
});
