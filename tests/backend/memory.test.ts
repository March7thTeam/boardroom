import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../src/context";
import type { Env } from "../../src/types";
import { agentMemoryRoutes } from "../../src/routes/agent-memory";
import { memoryRoutes } from "../../src/routes/memory";
import { listPointers } from "../../src/domain/memory";
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
  entry?: { id: string; version: number; body?: string; title?: string; status: string; shareable?: boolean };
  link?: { id: string; state: string; from_project_id: string; to_project_id: string };
  pointers?: Array<{ link_id: string; entry_id: string; title: string }>;
  entries?: Array<{ id: string; version: number }>;
  revoked_links?: number;
  duplicate?: boolean;
  seq?: number | null;
  entry_id?: string;
  error?: { code: string; message: string };
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
    INSERT INTO users(id,email,role) VALUES('u_guest','guest@example.test','member');
    INSERT INTO projects(id,slug,name,created_by) VALUES('${PRJ_A}','alpha','Alpha','u_owner');
    INSERT INTO projects(id,slug,name,created_by) VALUES('${PRJ_B}','beta','Beta','u_owner');
    INSERT INTO project_members(project_id,user_id,role,added_by) VALUES('${PRJ_A}','u_owner','owner','u_owner');
    INSERT INTO project_members(project_id,user_id,role,added_by) VALUES('${PRJ_B}','u_owner','owner','u_owner');
    INSERT INTO project_members(project_id,user_id,role,added_by) VALUES('${PRJ_A}','u_guest','member','u_owner');
    -- a-bot: A only; b-bot: B only; dual: active in both (the pointer carrier)
    INSERT INTO agents(id,slug) VALUES('${PRJ_A}:a-bot','a-bot');
    INSERT INTO agent_projects(agent_id,project_id,status,local_slug) VALUES('${PRJ_A}:a-bot','${PRJ_A}','active','a-bot');
    INSERT INTO agents(id,slug) VALUES('${PRJ_B}:b-bot','b-bot');
    INSERT INTO agent_projects(agent_id,project_id,status,local_slug) VALUES('${PRJ_B}:b-bot','${PRJ_B}','active','b-bot');
    INSERT INTO agents(id,slug) VALUES('${PRJ_A}:dual','dual');
    INSERT INTO agent_projects(agent_id,project_id,status,local_slug) VALUES('${PRJ_A}:dual','${PRJ_A}','active','dual');
    INSERT INTO agent_projects(agent_id,project_id,status,local_slug) VALUES('${PRJ_A}:dual','${PRJ_B}','active','dual');
  `);
  // 凭据始终按项目签发：dual 的令牌属于 B，但它同时是 A 的 active 成员。
  const secrets: Array<[string, string, string, string]> = [
    ["t_a", `${PRJ_A}:a-bot`, PRJ_A, "secret-a"],
    ["t_b", `${PRJ_B}:b-bot`, PRJ_B, "secret-b"],
    ["t_dual", `${PRJ_A}:dual`, PRJ_B, "secret-dual"],
  ];
  for (const [id, agentId, project, secret] of secrets) {
    const hash = await tokenHash(secret, "pepper");
    db.sqlite.prepare(
      "INSERT INTO agent_tokens(id,agent_id,project_id,prefix,hash,version,expires_at) VALUES(?,?,?,'test',?,1,'2099-01-01T00:00:00.000Z')",
    ).run(id, agentId, project, hash);
  }

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
    a: formatAgentToken(`${PRJ_A}:a-bot`, "secret-a"),
    b: formatAgentToken(`${PRJ_B}:b-bot`, "secret-b"),
    dual: formatAgentToken(`${PRJ_B}:dual`, "secret-dual"),
  };

  async function call(
    path: string,
    body: unknown = {},
    options: { method?: string; agent?: keyof typeof tokens; email?: string; headers?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...options.headers };
    if (path.startsWith("/agent")) headers.Authorization = `Bearer ${tokens[options.agent ?? "a"]}`;
    else headers["X-Dev-Email"] = options.email ?? "owner@example.test";
    const response = await app.fetch(
      new Request(`http://local${path}`, {
        method: options.method ?? "POST",
        headers,
        body: options.method === "GET" ? undefined : JSON.stringify(body),
      }),
      env,
      { waitUntil() {}, passOnException() {} } as unknown as ExecutionContext,
    );
    return { status: response.status, body: await response.json() as Body };
  }

  async function createSharedEntry(shareable = true) {
    const created = await call(`/agent/memory/entries`, { title: "Release checklist", body: "step 1" }, { agent: "a" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const entryId = created.body.entry!.id;
    if (shareable) {
      const shared = await call(`/api/v1/projects/${PRJ_A}/memory/entries/${entryId}/shareable`, { shareable: true });
      expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    }
    return entryId;
  }

  return { db, call, tokens, published, createSharedEntry };
}

describe("project memory spaces (P1)", () => {
  it("creates an entry, auto-creates the 1:1 space and records a project-level event", async () => {
    const { call, db, published } = await fixture();
    const created = await call("/agent/memory/entries", { title: "Team convention", body: "Always run typecheck." });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.entry).toMatchObject({ title: "Team convention", version: 1, status: "active", shareable: false });
    expect(published).toContain("memory.entry_created");

    const spaces = db.sqlite.prepare("SELECT * FROM memory_spaces").all() as Array<Record<string, unknown>>;
    expect(spaces).toHaveLength(1);
    expect(spaces[0].project_id).toBe(PRJ_A);

    const outbox = db.sqlite.prepare("SELECT * FROM event_outbox").all() as Array<Record<string, unknown>>;
    expect(outbox).toHaveLength(1);
    expect(outbox[0].card_id).toBeNull();
    // 审计只留哈希，不留正文。
    expect(String(outbox[0].payload_json)).not.toContain("Always run typecheck.");
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
    const secret = await call("/agent/memory/entries", { title: "leak", body: "token kbt1.prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:a-bot.abcdefgh" });
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
  });

  it("requires both projects to approve, in source-then-target order", async () => {
    const { call, published } = await fixture();
    const created = await call("/agent/memory/entries", { title: "Convention", body: "use ULID" });
    const entryId = created.body.entry!.id;

    // 未开 shareable：申请即被拒。
    const blocked = await call("/agent/memory/links", { entry_id: entryId }, { agent: "b" });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error?.code).toBe("NOT_SHAREABLE");

    const shared = await call(`/api/v1/projects/${PRJ_A}/memory/entries/${entryId}/shareable`, { shareable: true });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    expect(shared.body.entry?.shareable).toBe(true);

    const requested = await call("/agent/memory/links", { entry_id: entryId }, { agent: "b" });
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    expect(requested.body.link).toMatchObject({ state: "pending_source", from_project_id: PRJ_A, to_project_id: PRJ_B });
    const linkId = requested.body.link!.id;
    expect(published).toContain("memory.link_requested");

    // 目标项目不能抢在源项目前面确认。
    const wrongOrder = await call(`/api/v1/projects/${PRJ_B}/memory/links/${linkId}/approve`, {});
    expect(wrongOrder.status).toBe(409);
    expect(wrongOrder.body.error?.code).toBe("LINK_STATE_INVALID");

    // 普通成员的确认不算数。
    const guest = await call(`/api/v1/projects/${PRJ_A}/memory/links/${linkId}/approve`, {}, { email: "guest@example.test" });
    expect(guest.status).toBe(403);

    const sourceOk = await call(`/api/v1/projects/${PRJ_A}/memory/links/${linkId}/approve`, {});
    expect(sourceOk.status, JSON.stringify(sourceOk.body)).toBe(200);
    expect(sourceOk.body.link?.state).toBe("pending_target");

    const targetOk = await call(`/api/v1/projects/${PRJ_B}/memory/links/${linkId}/approve`, {});
    expect(targetOk.status, JSON.stringify(targetOk.body)).toBe(200);
    expect(targetOk.body.link?.state).toBe("active");
    expect(published).toContain("memory.link_activated");
  });

  it("only agents active in BOTH projects see and can read the pointer", async () => {
    const { call, createSharedEntry, db } = await fixture();
    const entryId = await createSharedEntry(true);
    const requested = await call("/agent/memory/links", { entry_id: entryId }, { agent: "b" });
    const linkId = requested.body.link!.id;
    await call(`/api/v1/projects/${PRJ_A}/memory/links/${linkId}/approve`, {});
    await call(`/api/v1/projects/${PRJ_B}/memory/links/${linkId}/approve`, {});
    // dual：两个项目都 active，能看到并能读。
    const dualList = await call("/agent/memory/pointers", {}, { method: "GET", agent: "dual" });
    // dual 同时是两个项目的 active 成员
    expect(dualList.status, JSON.stringify(dualList.body)).toBe(200);
    expect(dualList.body.pointers).toHaveLength(1);
    expect(dualList.body.pointers![0]).toMatchObject({ link_id: linkId, entry_id: entryId, title: "Release checklist" });

    const dualRead = await call(`/agent/memory/pointers/${linkId}`, {}, { method: "GET", agent: "dual" });
    expect(dualRead.status, JSON.stringify(dualRead.body)).toBe(200);
    expect(dualRead.body.entry).toMatchObject({ id: entryId, body: "step 1" });

    // b-bot 只在 B：链接可见但读取被拒（不在源项目）。
    const onlyBList = await call("/agent/memory/pointers", {}, { method: "GET", agent: "b" });
    expect(onlyBList.status).toBe(200);
    expect(onlyBList.body.pointers).toEqual([]);

    // 断开 dual 在源项目的成员关系：指针立即消失。
    db.sqlite.exec(`UPDATE agent_projects SET status='disabled'
      WHERE agent_id='${PRJ_A}:dual' AND project_id='${PRJ_A}'`);
    const afterDisable = await call("/agent/memory/pointers", {}, { method: "GET", agent: "dual" });
    expect(afterDisable.status).toBe(200);
    expect(afterDisable.body.pointers).toEqual([]);
  });

  it("revoking the link or turning shareable off cuts access immediately", async () => {
    const { call, createSharedEntry } = await fixture();
    const entryId = await createSharedEntry(true);
    const requested = await call("/agent/memory/links", { entry_id: entryId }, { agent: "b" });
    const linkId = requested.body.link!.id;
    await call(`/api/v1/projects/${PRJ_A}/memory/links/${linkId}/approve`, {});
    await call(`/api/v1/projects/${PRJ_B}/memory/links/${linkId}/approve`, {});

    const before = await call(`/agent/memory/pointers/${linkId}`, {}, { method: "GET", agent: "dual" });
    expect(before.status).toBe(200);

    const revoked = await call(`/api/v1/projects/${PRJ_A}/memory/links/${linkId}/revoke`, { reason: "rotated" });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body.link?.state).toBe("revoked");

    const after = await call(`/agent/memory/pointers/${linkId}`, {}, { method: "GET", agent: "dual" });
    expect(after.status).toBe(410);
    expect(after.body.error?.code).toBe("LINK_REVOKED");

    // 关闭 shareable 会连带撤销未结束的链接。
    const entryId2 = await createSharedEntry(true);
    const second = await call("/agent/memory/links", { entry_id: entryId2 }, { agent: "b" });
    expect(second.status).toBe(201);
    const off = await call(`/api/v1/projects/${PRJ_A}/memory/entries/${entryId2}/shareable`, { shareable: false });
    expect(off.status).toBe(200);
    expect(off.body.revoked_links).toBe(1);
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

  it("enforces the space↔project and link-source invariants in the database", async () => {
    const { db } = await fixture();
    db.sqlite.exec(`INSERT INTO memory_spaces(id,project_id,slug,name) VALUES('ms_x','${PRJ_A}','alpha','Alpha')`);
    expect(() => db.sqlite.exec(`INSERT INTO memory_entries
      (id,space_id,project_id,title,body,created_by_type,created_by_id)
      VALUES('me_x','ms_x','${PRJ_B}','t','b','agent','${PRJ_A}:a-bot')`)).toThrow(/space project/);

    db.sqlite.exec(`INSERT INTO memory_entries
      (id,space_id,project_id,title,body,created_by_type,created_by_id)
      VALUES('me_y','ms_x','${PRJ_A}','t','b','agent','${PRJ_A}:a-bot')`);
    expect(() => db.sqlite.exec(`INSERT INTO memory_entry_links
      (id,entry_id,from_project_id,to_project_id,requested_by_type,requested_by_id,requested_at)
      VALUES('ml_x','me_y','${PRJ_B}','${PRJ_A}','agent','${PRJ_A}:a-bot','2026-01-01T00:00:00.000Z')`)).toThrow(/entry project/);
  });

  it("registers the NULL-card outbox idempotency index", async () => {
    const { db } = await fixture();
    const index = db.sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_outbox_project_message'")
      .get() as { sql?: string } | undefined;
    expect(index?.sql ?? "").toMatch(/card_id IS NULL/);
  });
});
