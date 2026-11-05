import { describe, expect, it } from "vitest";
import {
  assertShortCircuitState,
  buildDirectEngageTerms,
  resolveShortCircuitLevel,
  verifyBypasses,
} from "../../src/domain/short-circuit";
import type { CardRow } from "../../src/types";

function card(overrides: Partial<CardRow> = {}): CardRow {
  return {
    id: "c_1",
    project_id: "p_1",
    parent_card_id: null,
    title: "demo",
    body: null,
    status: "open",
    outcome: null,
    version: 1,
    round: 1,
    priority: 0,
    requester_agent_id: null,
    assignee_agent_id: null,
    assignee_user_id: null,
    criteria_json: '[{"key":"tests","op":"eq","value":true}]',
    verifier_id: null,
    verdict_reasons_json: null,
    lease_owner: null,
    lease_expires_at: null,
    paused_at: null,
    deadline_at: null,
    evidence_hash: null,
    created_by_type: "user",
    created_by_id: "u_owner",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("short-circuit level resolution", () => {
  it("lets instance admin win over an explicit project membership", () => {
    expect(resolveShortCircuitLevel({ globalAdmin: true, projectRole: "member" })).toBe("instance_admin");
    expect(resolveShortCircuitLevel({ globalAdmin: true, projectRole: null })).toBe("instance_admin");
  });

  it("allows a project owner only through the owner role", () => {
    expect(resolveShortCircuitLevel({ globalAdmin: false, projectRole: "owner" })).toBe("project_owner");
    expect(resolveShortCircuitLevel({ globalAdmin: false, projectRole: "member" })).toBeNull();
    expect(resolveShortCircuitLevel({ globalAdmin: false, projectRole: null })).toBeNull();
  });
});

describe("short-circuit state gate", () => {
  it("requires open for engage and review for verify", () => {
    expect(() => assertShortCircuitState("engage", card())).not.toThrow();
    expect(() => assertShortCircuitState("engage", card({ status: "review" }))).toThrow(
      expect.objectContaining({ code: "ADMIN_ACTION_STATE" }),
    );
    expect(() => assertShortCircuitState("verify", card({ status: "review" }))).not.toThrow();
    expect(() => assertShortCircuitState("verify", card())).toThrow(
      expect.objectContaining({ code: "ADMIN_ACTION_STATE" }),
    );
  });

  it("rejects any action on a paused card", () => {
    expect(() => assertShortCircuitState("engage", card({ paused_at: "2026-01-01T00:00:00.000Z" }))).toThrow(
      expect.objectContaining({ code: "CARD_PAUSED" }),
    );
  });
});

describe("direct engagement terms", () => {
  it("carries the bypass marker, assignee and parsed criteria", () => {
    const terms = buildDirectEngageTerms({
      card: card(),
      assigneeAgentId: "p_1:bot",
      level: "project_owner",
      actorUserId: "u_owner",
      reason: "no online peer",
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(terms).toMatchObject({
      kind: "direct_engage",
      card_id: "c_1",
      assignee_agent_id: "p_1:bot",
      criteria: [{ key: "tests", op: "eq", value: true }],
      short_circuit: {
        level: "project_owner",
        action: "engage",
        by: "u_owner",
        reason: "no online peer",
        synthetic: true,
      },
    });
  });
});

describe("verify bypass accounting", () => {
  it("records evidence_required only for a pass without evidence", () => {
    expect(verifyBypasses({ verdict: "pass", evidenceCount: 0, verifierConflict: null })).toEqual([
      "evidence_required",
    ]);
    expect(verifyBypasses({ verdict: "pass", evidenceCount: 1, verifierConflict: null })).toEqual([]);
    expect(verifyBypasses({ verdict: "reject", evidenceCount: 0, verifierConflict: null })).toEqual([]);
  });

  it("records verifier_conflict independently of evidence", () => {
    expect(
      verifyBypasses({ verdict: "pass", evidenceCount: 1, verifierConflict: "PROPOSER_IS_VERIFIER" }),
    ).toEqual(["verifier_conflict"]);
  });
});
