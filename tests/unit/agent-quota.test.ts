import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";
import { quotaPredicate } from "../../src/domain/agent-quota";

// Same shape as the membership insert in POST /agent/register and
// POST /agent/projects, executed against the real schema.
const ENROLL = `INSERT INTO agent_projects (agent_id, project_id, status, local_slug, assigned_by, assigned_at, updated_at)
  SELECT ?1, ?2, 'pending', ?3, NULL, ?4, ?4
   WHERE ${quotaPredicate(1, 2, 5)}
  ON CONFLICT(agent_id, project_id) DO UPDATE SET
    local_slug = COALESCE(agent_projects.local_slug, excluded.local_slug)`;

// Loaded through require: the bundled Vite does not know the `node:sqlite`
// builtin and would try to resolve it as a package.
type DatabaseSync = import("node:sqlite").DatabaseSync;
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const NOW = "2026-11-05T00:00:00.000Z";

function enroll(db: DatabaseSync, agentId: string, max: number): number {
  return Number(db.prepare(ENROLL).run(agentId, "prj_p", agentId.split(":")[1], NOW, max).changes);
}

function memberships(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM agent_projects WHERE project_id = 'prj_p'").get() as {
    n: number;
  };
  return row.n;
}

describe("enrollment quota predicate (issue #3)", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8"));
    db.exec("PRAGMA foreign_keys = OFF");
  });

  it("rejects the agent beyond max_agents", () => {
    expect(enroll(db, "prj_p:a1", 1)).toBe(1);
    expect(enroll(db, "prj_p:a2", 1)).toBe(0);
    expect(memberships(db)).toBe(1);
  });

  it("lets an already-enrolled agent re-register when the project is full", () => {
    expect(enroll(db, "prj_p:a1", 1)).toBe(1);
    expect(enroll(db, "prj_p:a1", 1)).toBe(1);
    expect(memberships(db)).toBe(1);
  });

  it("frees the slot when a membership is disabled", () => {
    expect(enroll(db, "prj_p:a1", 1)).toBe(1);
    db.prepare("UPDATE agent_projects SET status = 'disabled' WHERE agent_id = 'prj_p:a1'").run();
    expect(enroll(db, "prj_p:a2", 1)).toBe(1);
    expect(memberships(db)).toBe(2);
  });

  it("keeps the default limit permissive", () => {
    for (let index = 0; index < 50; index += 1) {
      expect(enroll(db, `prj_p:a${index}`, 50)).toBe(1);
    }
    expect(enroll(db, "prj_p:overflow", 50)).toBe(0);
  });
});
