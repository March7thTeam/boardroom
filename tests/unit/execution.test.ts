import { describe, expect, it } from "vitest";
import {
  evidenceHash,
  parseExecTargets,
  selectExecTarget,
} from "../../src/domain/execution";

describe("execution targets", () => {
  it("parses valid GitHub Actions targets and ignores invalid entries", () => {
    const targets = parseExecTargets(
      JSON.stringify([
        { provider: "github_actions", owner: "acme", repo: "etl", workflows: ["normalize.yml"] },
        { provider: "gitlab_ci", owner: "x", repo: "y", workflows: ["z"] },
        { provider: "github_actions", owner: "acme", repo: "etl", workflows: [] },
      ]),
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ owner: "acme", repo: "etl" });
  });

  it("selects a target and requested workflow", () => {
    const targets = parseExecTargets(
      JSON.stringify([
        { provider: "github_actions", owner: "acme", repo: "etl", workflows: ["a.yml", "b.yml"] },
      ]),
    );
    expect(selectExecTarget(targets, "acme", "etl", "b.yml")?.workflow).toBe("b.yml");
    expect(selectExecTarget(targets, "acme", "etl", "missing.yml")).toBeNull();
    expect(selectExecTarget([], "acme", "etl", undefined)).toBeNull();
  });

  it("hashes evidence deterministically regardless of order", async () => {
    const a = await evidenceHash([
      { kind: "artifact", sha256: "bb", size_bytes: 2 },
      { kind: "artifact", sha256: "aa", size_bytes: 1 },
    ]);
    const b = await evidenceHash([
      { kind: "artifact", sha256: "aa", size_bytes: 1 },
      { kind: "artifact", sha256: "bb", size_bytes: 2 },
    ]);
    expect(a).toBe(b);
    expect(a.startsWith("sha256:")).toBe(true);
  });
});
