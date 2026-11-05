import { describe, expect, it } from "vitest";
import { builtin } from "../helpers/sqlite-d1";
const { spawnSync } = builtin<{ spawnSync(command: string, args: string[], options: { encoding: "utf8" }): { status: number | null; stdout: string; stderr: string } }>("node:child_process");
const { execPath } = builtin<{ execPath: string }>("node:process");
const script = new URL("../../scripts/verify-audit.mjs", (import.meta as ImportMeta & { url: string }).url).href;
const valid = { ok: true, complete: true, pending: 0, checked: 2, as_of_seq: 2, head: { seq: 2, hash: "sha256:checkpoint" }, errors: [] };
describe("audit verification command", () => {
  it.each([
    ["complete chain", valid, 0],
    ["accepted but unpublished events", { ...valid, complete: false, pending: 1 }, 2],
    ["corrupt chain", { ...valid, ok: false, complete: false, errors: [{ seq: 1, code: "HASH_MISMATCH", message: "changed" }] }, 1],
    ["malformed success", { ok: true }, 1],
  ])("returns the correct exit status for %s", (_name, body, code) => {
    const source = `globalThis.fetch = async () => Response.json(${JSON.stringify(body)}); process.argv = [process.execPath, "verify-audit", "prj_fixture"]; await import(${JSON.stringify(script)});`;
    const result = spawnSync(execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });
    expect(result.status, result.stderr + result.stdout).toBe(code);
  });
});
