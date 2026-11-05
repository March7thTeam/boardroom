import { describe, expect, it } from "vitest";
import { evaluateCriteria } from "../../src/domain/verdict";

const criteria = JSON.stringify([
  { key: "row_count", op: "eq", value: 30000 },
  { key: "status", op: "matches", value: "ok|pass" },
  { key: "warn_only", op: "gte", value: 10, severity: "warn" },
]);

describe("rule verdict evaluation", () => {
  it("passes when all blocking criteria match self_check", () => {
    const result = evaluateCriteria(criteria, [
      { key: "row_count", value: 30000 },
      { key: "status", value: "ok" },
      { key: "warn_only", value: 1 },
    ]);
    expect(result.pass).toBe(true);
    expect(result.self_reported).toBe(true);
    expect(result.reasons.filter((reason) => !reason.pass)).toHaveLength(1);
  });

  it("fails on a blocking mismatch", () => {
    const result = evaluateCriteria(criteria, [
      { key: "row_count", value: 30120 },
      { key: "status", value: "fail" },
    ]);
    expect(result.pass).toBe(false);
  });

  it("treats missing values as failures unless warn", () => {
    const result = evaluateCriteria(
      JSON.stringify([{ key: "present", op: "exists" }]),
      [],
    );
    expect(result.pass).toBe(false);
  });
});
