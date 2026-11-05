import { describe, expect, it } from "vitest";
import { verifierConflict } from "../../src/domain/verification";

const contract = {
  proposer_agent_id: "ag_proposer",
  proposer_user_id: null,
  acceptor_agent_id: null,
  acceptor_user_id: "us_requester",
};

describe("verifier conflict", () => {
  it("lets the human requester verify a proposal they accepted", () => {
    // Regression for #6: requester = sole acceptor used to be a permanent conflict.
    expect(verifierConflict(contract, "us_requester")).toBeNull();
  });

  it("still bars the human who proposed the terms", () => {
    expect(
      verifierConflict({ ...contract, proposer_agent_id: null, proposer_user_id: "us_proposer" }, "us_proposer"),
    ).toBe("PROPOSER_IS_VERIFIER");
  });

  it("allows unrelated project members and cards without a contract", () => {
    expect(verifierConflict(contract, "us_other")).toBeNull();
    expect(verifierConflict(null, "us_other")).toBeNull();
  });
});
