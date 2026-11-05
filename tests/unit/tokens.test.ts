import { describe, expect, it } from "vitest";
import {
  formatAgentToken,
  formatEnrollmentToken,
  parseAgentToken,
  parseEnrollmentToken,
} from "../../src/lib/tokens";
import { constantTimeEqual, randomSecret, sha256Hex, tokenHash } from "../../src/lib/crypto";

describe("tokens", () => {
  it("round-trips an agent token", () => {
    const secret = randomSecret();
    const agentId = "prj_01J9Z6ABCDEFGHJKMNPQRSTVWX:data-helper";
    const token = formatAgentToken(agentId, secret);
    expect(token.startsWith("kbt1.")).toBe(true);
    expect(parseAgentToken(token)).toEqual({ agentId, secret });
  });

  it("round-trips an enrollment token", () => {
    const token = formatEnrollmentToken("prj_01J9Z6", "secret");
    expect(parseEnrollmentToken(token)).toEqual({ projectId: "prj_01J9Z6", secret: "secret" });
  });

  it("rejects malformed tokens", () => {
    expect(parseAgentToken("kbt1.")).toBeNull();
    expect(parseAgentToken("kbt1.abc")).toBeNull();
    expect(parseAgentToken("bearer abc")).toBeNull();
    expect(parseEnrollmentToken("kbe1.prj_1")).toBeNull();
  });

  it("hashes deterministically with a pepper", async () => {
    expect(await tokenHash("secret", "pepper")).toBe(await tokenHash("secret", "pepper"));
    expect(await tokenHash("secret", "pepper")).not.toBe(await tokenHash("secret", "other"));
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("compares in constant time semantics", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});
