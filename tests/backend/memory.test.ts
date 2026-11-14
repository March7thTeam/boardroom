import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../src/context";
import type { Env } from "../../src/types";
import { agentMemoryRoutes } from "../../src/routes/agent-memory";
import { memoryRoutes } from "../../src/routes/memory";
import { tokenHash } from "../../src/lib/crypto";
import { formatAgentToken } from "../../src/lib/tokens";
import { HttpError } from "../../src/lib/http-error";
import { publishOutboxEvent, reconcileEvents, type OutboxRow } from "../../src/lib/event-store";
import { builtin, SqliteD1 } from "../helpers/sqlite-d1";

const { readFileSync, readdirSync } = builtin<{
  readFileSync(path: URL, encoding: string): string;
  readdirSync(path: URL): string[];
}>("node:fs");

const PRJ_A = "prj_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PRJ_B = "prj_01ARZ3NDEKTSV4RRFFQ69G5FAW";

const databases: SqliteD1[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) db.sqlite.close();
});

interface Body {
  entry?: { id: string; version: number; body: string; title: string; status: string };
  ref?: { id: string; grant_id: string; source_version: number; content_sha256: string };
  grant?: { id: string; entry_version: number; content_sha256: string; to_project_id: string };
  space?: { id: string } | null;
  entries?: Array<{ id: string; version: number }>;
  has_more?: boolean;
  duplicate?: boolean;
  seq?: number | null;
  error?: { code: string; message: string };
  entry_id?: string;
  version?: number;
}

async function fixture() {
  const db = new SqliteD1();
  databases.push(db);
  const migrations = new URL("../../migrations/", (import.meta as ImportMeta & { url: string }).url);
  for (const name of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort()) {
    db.sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  db.sqlite.exec(`
    INSERT INTO users(id,email,role) VALUES('u_owner','owner@example.test','member');
    INSERT INTO projects(id,slug,name,created_by) VALUES('${PRJ_A}','alpha','Alpha','u_owner');
    INSERT INTO projects(id,slug,name,created_by) VALUES('${PRJ_B}','beta','Beta','u_owner');
    INSERT INTO project_members(project_id,user_id,role,added_by) VALUES('${PRJ_A}','u_owner','owner','u_owner');
    INSERT INTO project_members(project_id,user_id,role,added_by) VALUES('${PRJ_B}','u_owner','owner','u_owner');
    INSERT INTO agents(id,slug) VALUES('${PRJ_A}:bot','bot');
    INSERT INTO agent_projects(agent_id,project_id,status,local_slug) VALUES('${PRJ_A}:bot','${PRJ_A}','active','bot');
    INSERT INTO agents(id,slug) VALUES('${PRJ_B}:bot','bot');
    INSERT INTO agent_projects(agent_id,project_id,status,local_slug) VALUES('${PRJ_B}:bot','${PRJ_B}','active','bot');
    INSERT INTO agents(id,slug) VALUES('${PRJ_A}:peer','peer');
    INSERT INTO agent_projects(agent_id,project_id,status,local_slug) VALUES('${PRJ_A}:peer','${PRJ_A}','active','peer');
  `);
  const aHash = await tokenHash("secret-a", "pepper");
  db.sqlite.prepare("INSERT INTO agent_tokens(id,agent_id,project_id,prefix,hash,version,expires_at) VALUES('t_a','" + PRJ_A + ":bot','" + PRJ_A + "','test',?,1,'2099-01-01T00:00:00.000Z')").run(aHash);
  const bHash = await tokenHash("secret-b", "pepper");
  db.sqlite.prepare("INSERT INTO agent_tokens(id,agent_id,project_id,prefix,hash,version,expires_at) VALUES('t_b','" + PRJ_B + ":bot','" + PRJ_B + "','test',?,1,'2099-01-01T00:00:00.000Z')").run(bHash);
  const peerHash = await tokenHash("secret-peer", "pepper");
  db.sqlite.prepare("INSERT INTO agent_tokens(id,agent_id,project_id,prefix,hash,version,expires_at) VALUES('t_peer','" + PRJ_A + ":peer','" + PRJ_A + "','test',?,1,'2099-01-01T00:00:00.000Z')").run(peerHash);

  const published: string[] = [];
  const board = {
    publish(eventId: string): Promise<{ seq: number }> {
      return (async () => {
        const row = await db.prepare("SELECT * FROM event_outbox WHERE event_id = ?1").bind(eventId).first<OutboxRow>();
        if (!row) throw new Error("missing outbox receipt");
        if (row.published_seq !== null) return { seq: row.published_seq };
        let head = await reconcileEvents(db.asD1(), row.project_id);
        const pending = await db.prepare(`SELECT * FROM event_outbox
          WHERE project_id=?1 AND published_seq IS NULL AND order_id<=?2 ORDER BY order_id`)
          .bind(row.project_id, row.order_id).all<OutboxRow>();
        for (const earlier of pending.results) {
          head = await publishOutboxEvent(db.asD1(), earlier, head);
          published.push(earlier.event_type);
        }
        return { seq: head.seq };
      })();
    },
    async closeConnections() {},
    async purgeProject() {},
  };
  const env = {
    DB: db.asD1(),
    TOKEN_PEPPER: "pepper",
    GITHUB_TOKEN: "fake-no-network",
    ENVIRONMENT: "development",
    BOARD_DO: { getByName: () => board },
  } as unknown as Env;

  const app = new Hono<AppEnv>();
  app.onError((error, c) => c.json(
    { error: { code: error instanceof HttpError ? error.code : "INTERNAL", message: error.message } },
    (error instanceof HttpError ? error.status : 500) as 500,
  ));
  app.route("/api/v1", memoryRoutes);
  app.route("/agent", agentMemoryRoutes);

  const tokens = {
    a: formatAgentToken(`${PRJ_A}:bot`, "secret-a"),
    b: formatAgentToken(`${PRJ_B}:bot`, "secret-b"),
    peer: formatAgentToken(`${PRJ_A}:peer`, "secret-peer"),
  };

  async function call(
    path: string,
    body: unknown = {},
    options: { method?: string; agent?: keyof typeof tokens; email?: string; headers?: Record<string, string>; raw?: boolean } = {},
  ) {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...options.headers };
    if (path.startsWith("/agent")) headers.Authorization = `Bearer ${tokens[options.agent ?? "a"]}`;
    else headers["X-Dev-Email"] = options.email ?? "owner@example.test";
    const response = await app.fetch(
      new Request(`http://local${path}`, {
        method: options.method ?? "POST",
        headers,
        body: options.method === "GET" || options.method === "DELETE" ? undefined : JSON.stringify(body),
      }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    return { status: response.status, body: await response.json() as Body };
  }

  return { db, call, tokens, published };
}

describe("project memory spaces (P1)", () => {
  it("creates an entry, auto-creates the 1:1 space and records a project-level event", async () => {
    const { call, db, published } = await fixture();
    const created = await call("/agent/memory/entries", { title: "Team convention", body: "Always run typecheck." });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.entry).toMatchObject({ title: "Team convention", version: 1, status: "active" });
    expect(created.body.seq).toBe(1);
    expect(published).toContain("memory.entry_created");

    const spaces = db.sqlite.prepare("SELECT * FROM memory_spaces").all() as Array<Record<string, unknown>>;
    expect(spaces).toHaveLength(1);
    expect(spaces[0].project_id).toBe(PRJ_A);

    const outbox = db.sqlite.prepare("SELECT * FROM event_outbox").all() as Array<Record<string, unknown>>;
    expect(outbox).toHaveLength(1);
    expect(outbox[0].card_id).toBeNull();
    // 审计只存哈希，不存正文。
    expect(String(outbox[0].payload_json)).not.toContain("Always run typecheck.");
    expect(String(outbox[0].payload_json)).toContain("body_hash");
  });

  it("replays the same message_id and rejects a different request under it", async () => {
    const { call } = await fixture();
    const first = await call("/agent/memory/entries", { title: "t", body: "b", message_id: "m-1" });
    expect(first.status).toBe(201);
    const replay = await call("/agent/memory/entries", { title: "t", body: "b", message_id: "m-1" });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.duplicate).toBe(true);
    expect(replay.body.entry_id).toBe(first.body.entry!.id);

    const conflicting = await call("/agent/memory/entries", { title: "t", body: "other", message_id: "m-1" });
    expect(conflicting.status).toBe(409);
    expect(conflicting.body.error?.code).toBe("CONFLICT");
  });

  it("rejects credential-shaped bodies and enforces If-Match on updates", async () => {
    const { call } = await fixture();
    const secret = await call("/agent/memory/entries", { title: "leak", body: "token kbt1.prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:bot.abcdefgh" });
    expect(secret.status).toBe(422);
    expect(secret.body.error?.code).toBe("SECRET_DETECTED");

    const created = await call("/agent/memory/entries", { title: "v1", body: "one" });
    const entryId = created.body.entry!.id;
    const stale = await call(`/agent/memory/entries/${entryId}`, { title: "v2", body: "two" }, { method: "PATCH", headers: { "If-Match": "7" } });
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe("VERSION_CONFLICT");

    const ok = await call(`/agent/memory/entries/${entryId}`, { title: "v2", body: "two" }, { method: "PATCH", headers: { "If-Match": "1" } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.entry).toMatchObject({ version: 2, body: "two" });

    const foreign = await call(`/agent/memory/entries/${entryId}`, { title: "v3", body: "three" }, { method: "PATCH", agent: "peer", headers: { "If-Match": "2" } });
    expect(foreign.status).toBe(403);
  });

  it("grants, imports and reads a pinned version without following later edits", async () => {
    const { call } = await fixture();
    const created = await call("/agent/memory/entries", { title: "Release checklist", body: "step 1" });
    const entryId = created.body.entry!.id;

    const grant = await call(`/api/v1/projects/${PRJ_A}/memory/entries/${entryId}/grants`, { to_project_id: PRJ_B });
    expect(grant.status, JSON.stringify(grant.body)).toBe(201);
    expect(grant.body.grant).toMatchObject({ entry_version: 1, to_project_id: PRJ_B });

    // 源条目在授权后继续修改，不影响已经绑定的引用。
    const updated = await call(`/agent/memory/entries/${entryId}`, { title: "Release checklist", body: "step 1 + step 2" }, { method: "PATCH", headers: { "If-Match": "1" } });
    expect(updated.status).toBe(200);

    const imported = await call("/agent/memory/refs", { grant_id: grant.body.grant!.id }, { agent: "b" });
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);

    const read = await call(`/agent/memory/refs/${imported.body.ref!.id}`, {}, { method: "GET", agent: "b" });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.ref!.source_version).toBe(1);
    expect((read.body as unknown as { entry: { body: string } }).entry.body).toBe("step 1");

    // 同一张凭据不能被再导入一次；A 项目的 agent 也读不到 B 的引用。
    const again = await call("/agent/memory/refs", { grant_id: grant.body.grant!.id }, { agent: "b" });
    expect(again.status).toBe(409);
    const crossRead = await call(`/agent/memory/refs/${imported.body.ref!.id}`, {}, { method: "GET", agent: "a" });
    expect(crossRead.status).toBe(404);
  });

  it("revocation stops further reads and further imports", async () => {
    const { call } = await fixture();
    const created = await call("/agent/memory/entries", { title: "Shared", body: "knowledge" });
    const entryId = created.body.entry!.id;
    const grant = await call(`/api/v1/projects/${PRJ_A}/memory/entries/${entryId}/grants`, { to_project_id: PRJ_B });
    const imported = await call("/agent/memory/refs", { grant_id: grant.body.grant!.id }, { agent: "b" });
    expect(imported.status).toBe(201);

    const revoked = await call(`/api/v1/projects/${PRJ_A}/memory/grants/${grant.body.grant!.id}/revoke`, { reason: "rotated" });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

    const read = await call(`/agent/memory/refs/${imported.body.ref!.id}`, {}, { method: "GET", agent: "b" });
    expect(read.status).toBe(410);
    expect(read.body.error?.code).toBe("GRANT_REVOKED");

    const reimport = await call("/agent/memory/refs", { grant_id: grant.body.grant!.id }, { agent: "b" });
    expect(reimport.status).toBe(410);
  });

  it("keeps the agent scope: entries are only visible inside their own project", async () => {
    const { call } = await fixture();
    const created = await call("/agent/memory/entries", { title: "alpha only", body: "not for beta" });
    expect(created.status).toBe(201);

    const listB = await call("/agent/memory/entries", {}, { method: "GET", agent: "b" });
    expect(listB.status).toBe(200);
    expect(listB.body.entries).toEqual([]);

    const mismatched = await call(`/agent/memory/entries?project_id=${PRJ_B}`, {}, { method: "GET", agent: "a" });
    expect(mismatched.status).toBe(403);
    expect(mismatched.body.error?.code).toBe("CREDENTIAL_SCOPE_MISMATCH");
  });

  it("enforces the space↔project invariant in the database", async () => {
    const { db } = await fixture();
    db.sqlite.exec(`INSERT INTO memory_spaces(id,project_id,slug,name) VALUES('ms_x','${PRJ_A}','alpha','Alpha')`);
    expect(() => db.sqlite.exec(`INSERT INTO memory_entries
      (id,space_id,project_id,title,body,created_by_type,created_by_id)
      VALUES('me_x','ms_x','${PRJ_B}','t','b','agent','${PRJ_A}:bot')`)).toThrow(/space project/);
  });

  it("registers the NULL-card outbox idempotency index", async () => {
    const { db } = await fixture();
    const index = db.sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_outbox_project_message'")
      .get() as { sql?: string } | undefined;
    expect(index?.sql ?? "").toMatch(/card_id IS NULL/);
  });
});
