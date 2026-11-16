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
  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "resource not found" } }, 404));
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

  it("rejects credential-shaped bodies and keeps entries immutable", async () => {
    const { call } = await fixture();
    const secret = await call("/agent/memory/entries", { title: "leak", body: "token kbt1.prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:a-bot.abcdefgh" });
    expect(secret.status).toBe(422);
    expect(secret.body.error?.code).toBe("SECRET_DETECTED");

    const created = await call("/agent/memory/entries", { title: "v1", body: "one" });
    const entryId = created.body.entry!.id;
    expect(created.body.entry).toMatchObject({ version: 1, shareable: false });

    // 记忆不可修改：没有 PATCH 路由，改内容只能删了重建。
    const patched = await call(`/agent/memory/entries/${entryId}`, { title: "v2", body: "two" }, { method: "PATCH" });
    expect(patched.status).toBe(404);

    const staleDelete = await call(`/agent/memory/entries/${entryId}`, {}, { method: "DELETE", headers: { "If-Match": "7" } });
    expect(staleDelete.status).toBe(409);
    expect(staleDelete.body.error?.code).toBe("VERSION_CONFLICT");

    const deleted = await call(`/agent/memory/entries/${entryId}`, {}, { method: "DELETE", headers: { "If-Match": "1" } });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body.entry_id).toBe(entryId);

    const again = await call(`/agent/memory/entries/${entryId}`, {}, { method: "DELETE", headers: { "If-Match": "2" } });
    expect(again.status).toBe(409);
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

  it("serves the snapshot to target-project members only", async () => {
    const { call, createSharedEntry, db } = await fixture();
    const entryId = await createSharedEntry(true);
    const requested = await call("/agent/memory/links", { entry_id: entryId }, { agent: "b" });
    const linkId = requested.body.link!.id;
    await call(`/api/v1/projects/${PRJ_A}/memory/links/${linkId}/approve`, {});
    await call(`/api/v1/projects/${PRJ_B}/memory/links/${linkId}/approve`, {});

    // b-bot 只在目标项目：快照属于目标项目，它可以看见并读取。
    const list = await call("/agent/memory/pointers", {}, { method: "GET", agent: "b" });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.pointers).toHaveLength(1);
    expect(list.body.pointers![0]).toMatchObject({ link_id: linkId, entry_id: entryId, title: "Release checklist" });

    const read = await call(`/agent/memory/pointers/${linkId}`, {}, { method: "GET", agent: "b" });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.entry).toMatchObject({ id: entryId, body: "step 1", source_deleted: false, source_missing: false });

    // 源项目 agent（非目标项目成员）读不到这条链接。
    const sourceOnly = await call(`/agent/memory/pointers/${linkId}`, {}, { method: "GET", agent: "a" });
    expect(sourceOnly.status).toBe(404);

    // 目标项目成员关系被停用后，鉴权层直接拒绝。
    db.sqlite.exec(`UPDATE agent_projects SET status='disabled'
      WHERE agent_id='${PRJ_B}:b-bot' AND project_id='${PRJ_B}'`);
    const disabled = await call(`/agent/memory/pointers/${linkId}`, {}, { method: "GET", agent: "b" });
    expect(disabled.status).toBe(403);
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

  it("keeps the frozen snapshot readable after the source entry is deleted", async () => {
    const { call, createSharedEntry, db } = await fixture();
    const entryId = await createSharedEntry(true);
    const requested = await call("/agent/memory/links", { entry_id: entryId }, { agent: "b" });
    const linkId = requested.body.link!.id;
    await call(`/api/v1/projects/${PRJ_A}/memory/links/${linkId}/approve`, {});
    await call(`/api/v1/projects/${PRJ_B}/memory/links/${linkId}/approve`, {});

    // 默认删除：保留快照，目标项目仍然可读，只多一个标记。
    const deleted = await call(`/agent/memory/entries/${entryId}`, {}, { method: "DELETE", headers: { "If-Match": "1" } });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect((deleted.body as unknown as { revoked_links: number }).revoked_links).toBe(0);

    const after = await call(`/agent/memory/pointers/${linkId}`, {}, { method: "GET", agent: "b" });
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    const entry = (after.body as unknown as { entry: { body: string; source_deleted: boolean; source_missing: boolean } }).entry;
    expect(entry.body).toBe("step 1");
    expect(entry.source_deleted).toBe(true);
    expect(entry.source_missing).toBe(false);

    // 源行被物理删除：快照与链接都在（FK 是 SET NULL），只是 source_missing。
    db.sqlite.exec(`DELETE FROM memory_entries WHERE id='${entryId}'`);
    const physical = await call(`/agent/memory/pointers/${linkId}`, {}, { method: "GET", agent: "b" });
    expect(physical.status, JSON.stringify(physical.body)).toBe(200);
    const ghost = (physical.body as unknown as { entry: { body: string; source_deleted: boolean; source_missing: boolean } }).entry;
    expect(ghost.body).toBe("step 1");
    expect(ghost.source_deleted).toBe(true);
    expect(ghost.source_missing).toBe(true);
  });

  it("supports an atomic delete-with-revoke for containment", async () => {
    const { call, createSharedEntry } = await fixture();
    const entryId = await createSharedEntry(true);
    const requested = await call("/agent/memory/links", { entry_id: entryId }, { agent: "b" });
    const linkId = requested.body.link!.id;
    await call(`/api/v1/projects/${PRJ_A}/memory/links/${linkId}/approve`, {});
    await call(`/api/v1/projects/${PRJ_B}/memory/links/${linkId}/approve`, {});

    const deleted = await call(`/agent/memory/entries/${entryId}?revoke_links=1`, {}, { method: "DELETE", headers: { "If-Match": "1" } });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect((deleted.body as unknown as { revoked_links: number }).revoked_links).toBe(1);

    const read = await call(`/agent/memory/pointers/${linkId}`, {}, { method: "GET", agent: "b" });
    expect(read.status).toBe(410);
    expect(read.body.error?.code).toBe("LINK_REVOKED");
  });

  it("keeps shareable a human-only switch", async () => {
    const { call, createSharedEntry } = await fixture();
    const entryId = await createSharedEntry(false);
    // agent 侧根本没有开关路由（只能用人类接口，而它要求人类会话）。
    const asAgent = await call(`/agent/memory/entries/${entryId}/shareable`, { shareable: true }, { agent: "a" });
    expect(asAgent.status).toBe(404);

    // 普通成员（非作者、非 owner/admin）也不能替别人打开。
    const guest = await call(`/api/v1/projects/${PRJ_A}/memory/entries/${entryId}/shareable`, { shareable: true }, { email: "guest@example.test" });
    expect(guest.status).toBe(403);
  });

  it("lets a project owner/admin delete and contain another author's entry", async () => {
    const { call } = await fixture();
    const created = await call("/agent/memory/entries", { title: "leaky", body: "agent wrote this" });
    const entryId = created.body.entry!.id;

    // 普通成员既不是作者也不是 owner/admin：不能删。
    const guest = await call(`/api/v1/projects/${PRJ_A}/memory/entries/${entryId}`, {}, { method: "DELETE", email: "guest@example.test", headers: { "If-Match": "1" } });
    expect(guest.status).toBe(403);

    // owner 可以删（止血场景）。
    const owner = await call(`/api/v1/projects/${PRJ_A}/memory/entries/${entryId}`, {}, { method: "DELETE", headers: { "If-Match": "1" } });
    expect(owner.status, JSON.stringify(owner.body)).toBe(200);
  });

  it("counts only the links revoked in this batch", async () => {
    const { call, createSharedEntry } = await fixture();
    const entryId = await createSharedEntry(true);

    // 第一轮：申请 → 双方确认 → 手工撤销（历史 revoked = 1）。
    const first = await call("/agent/memory/links", { entry_id: entryId }, { agent: "b" });
    const firstId = first.body.link!.id;
    await call(`/api/v1/projects/${PRJ_A}/memory/links/${firstId}/approve`, {});
    await call(`/api/v1/projects/${PRJ_B}/memory/links/${firstId}/approve`, {});
    await call(`/api/v1/projects/${PRJ_A}/memory/links/${firstId}/revoke`, {});

    // 第二轮：重新申请并生效，然后带 revoke_links 删除。
    const second = await call("/agent/memory/links", { entry_id: entryId }, { agent: "b" });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const secondId = second.body.link!.id;
    await call(`/api/v1/projects/${PRJ_A}/memory/links/${secondId}/approve`, {});
    await call(`/api/v1/projects/${PRJ_B}/memory/links/${secondId}/approve`, {});

    const deleted = await call(`/agent/memory/entries/${entryId}?revoke_links=1`, {}, { method: "DELETE", headers: { "If-Match": "1" } });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    // 本批只撤销了 1 条；历史上那条不计入。
    expect((deleted.body as unknown as { revoked_links: number }).revoked_links).toBe(1);
  });

  it("keeps the link readable and revocable after the source project is deleted", async () => {
    const { call, createSharedEntry, db } = await fixture();
    const entryId = await createSharedEntry(true);
    const requested = await call("/agent/memory/links", { entry_id: entryId }, { agent: "b" });
    const linkId = requested.body.link!.id;
    await call(`/api/v1/projects/${PRJ_A}/memory/links/${linkId}/approve`, {});
    await call(`/api/v1/projects/${PRJ_B}/memory/links/${linkId}/approve`, {});

    db.sqlite.exec(`DELETE FROM projects WHERE id='${PRJ_A}'`);

    const read = await call(`/agent/memory/pointers/${linkId}`, {}, { method: "GET", agent: "b" });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const entry = (read.body as unknown as { entry: { body: string; source_deleted: boolean; source_missing: boolean } }).entry;
    expect(entry.body).toBe("step 1");
    expect(entry.source_missing).toBe(true);

    // 源项目没了，由目标项目的 owner/admin 移除这条链接。
    const removed = await call(`/api/v1/projects/${PRJ_B}/memory/links/${linkId}/revoke`, {});
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.link?.state).toBe("revoked");

    const after = await call(`/agent/memory/pointers/${linkId}`, {}, { method: "GET", agent: "b" });
    expect(after.status).toBe(410);
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
      (id,space_id,project_id,title,body,body_hash,created_by_type,created_by_id)
      VALUES('me_x','ms_x','${PRJ_B}','t','b','h','agent','${PRJ_A}:a-bot')`)).toThrow(/space project/);

    db.sqlite.exec(`INSERT INTO memory_entries
      (id,space_id,project_id,title,body,body_hash,created_by_type,created_by_id)
      VALUES('me_y','ms_x','${PRJ_A}','t','b','h','agent','${PRJ_A}:a-bot')`);
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

describe("project memory spaces (P1) — review regressions", () => {
  async function activateLink(
    call: Awaited<ReturnType<typeof fixture>>["call"],
    entryId: string,
  ): Promise<string> {
    const requested = await call(`/api/v1/projects/${PRJ_B}/memory/links`, { entry_id: entryId });
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    const linkId = requested.body.link!.id;
    expect((await call(`/api/v1/projects/${PRJ_A}/memory/links/${linkId}/approve`, {})).status).toBe(200);
    expect((await call(`/api/v1/projects/${PRJ_B}/memory/links/${linkId}/approve`, {})).status).toBe(200);
    return linkId;
  }

  it("requires an active membership, not just a token, for agent memory", async () => {
    const { call, db, createSharedEntry } = await fixture();
    const entryId = await createSharedEntry();
    await activateLink(call, entryId);
    // Credential recovery issues tokens with status 'pending'; card routes refuse
    // them, and memory must not be the one surface that lets them through.
    db.sqlite.exec(`UPDATE agent_projects SET status = 'pending' WHERE agent_id = '${PRJ_B}:b-bot'`);

    const pointers = await call(`/agent/memory/pointers?project_id=${PRJ_B}`, {}, { method: "GET", agent: "b" });
    expect(pointers.status, JSON.stringify(pointers.body)).toBe(403);
    const entries = await call(`/agent/memory/entries?project_id=${PRJ_B}`, {}, { method: "GET", agent: "b" });
    expect(entries.status, JSON.stringify(entries.body)).toBe(403);
  });

  it("counts inbound pointers even when the target project has no space yet", async () => {
    const { call, db, createSharedEntry } = await fixture();
    const entryId = await createSharedEntry();
    await activateLink(call, entryId);

    const overview = await call(`/agent/memory?project_id=${PRJ_B}`, {}, { method: "GET", agent: "b" });
    expect(overview.status, JSON.stringify(overview.body)).toBe(200);
    // B never wrote an entry, so it has no space; the snapshot is still its own.
    expect((overview.body as { space: unknown }).space).toBeNull();
    expect((overview.body as { pointer_count: number }).pointer_count).toBe(1);
    const pointers = await call(`/agent/memory/pointers?project_id=${PRJ_B}`, {}, { method: "GET", agent: "b" });
    expect((pointers.body as { pointers: unknown[] }).pointers).toHaveLength(1);

    const human = await call(`/api/v1/projects/${PRJ_B}/memory`, {}, { method: "GET" });
    expect((human.body as { links: unknown[] }).links).toHaveLength(1);
    const rows = db.sqlite.prepare("SELECT COUNT(*) AS c FROM memory_spaces WHERE project_id = ?").get(PRJ_B) as { c: number };
    expect(rows.c).toBe(0);
  });

  it("records the delete event when revoke_links matches no open link", async () => {
    const { call, db } = await fixture();
    const created = await call(`/agent/memory/entries`, { title: "solo", body: "no links" }, { agent: "a" });
    expect(created.status).toBe(201);
    const entryId = created.body.entry!.id;

    const deleted = await call(`/api/v1/projects/${PRJ_A}/memory/entries/${entryId}?revoke_links=1`, {}, {
      method: "DELETE",
      headers: { "If-Match": "1" },
    });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body.revoked_links).toBe(0);
    const events = db.sqlite
      .prepare("SELECT COUNT(*) AS c FROM event_outbox WHERE event_type = 'memory.entry_deleted'")
      .get() as { c: number };
    expect(events.c, "a committed delete must always emit its audit event").toBe(1);
  });

  it("rejects a replay that flips the revoke_links intent", async () => {
    const { call, db, createSharedEntry } = await fixture();
    const entryId = await createSharedEntry();
    const linkId = await activateLink(call, entryId);

    const first = await call(`/api/v1/projects/${PRJ_A}/memory/entries/${entryId}?message_id=m_contain`, {}, {
      method: "DELETE",
      headers: { "If-Match": "1" },
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const retry = await call(`/api/v1/projects/${PRJ_A}/memory/entries/${entryId}?message_id=m_contain&revoke_links=1`, {}, {
      method: "DELETE",
      headers: { "If-Match": "1" },
    });
    expect(retry.status, JSON.stringify(retry.body)).toBe(409);
    const link = db.sqlite.prepare("SELECT state FROM memory_entry_links WHERE id = ?").get(linkId) as { state: string };
    expect(link.state, "a rejected replay must not report containment as done").toBe("active");
  });

  it("treats an unchanged shareable value as a successful no-op", async () => {
    const { call, db } = await fixture();
    const created = await call(`/agent/memory/entries`, { title: "flag", body: "payload" }, { agent: "a" });
    const entryId = created.body.entry!.id;

    const on = await call(`/api/v1/projects/${PRJ_A}/memory/entries/${entryId}/shareable`, { shareable: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    const onAgain = await call(`/api/v1/projects/${PRJ_A}/memory/entries/${entryId}/shareable`, { shareable: true });
    expect(onAgain.status, JSON.stringify(onAgain.body)).toBe(200);
    const off = await call(`/api/v1/projects/${PRJ_A}/memory/entries/${entryId}/shareable`, { shareable: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    // Closing the flag with nothing open used to fail after the write had committed.
    const offAgain = await call(`/api/v1/projects/${PRJ_A}/memory/entries/${entryId}/shareable`, { shareable: false });
    expect(offAgain.status, JSON.stringify(offAgain.body)).toBe(200);
    const row = db.sqlite.prepare("SELECT shareable FROM memory_entries WHERE id = ?").get(entryId) as { shareable: number };
    expect(row.shareable).toBe(0);
  });
});
