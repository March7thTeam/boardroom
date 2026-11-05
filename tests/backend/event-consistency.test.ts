import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../src/context";
import type { AuditRow, CardEventRow, Env } from "../../src/types";
import { verifyProjectAudit, ZERO_HASH } from "../../src/domain/audit";
import { authorizedPrincipalIndexes, commitAndPublish, commitCardEvent, publishCommitted, publishOutboxEvent, reconcileEvents, type EventCommand, type OutboxRow } from "../../src/lib/event-store";
import { listAgentCards } from "../../src/lib/agent-cards";
import { builtin, SqliteD1 } from "../helpers/sqlite-d1";

const fs = builtin<{ readFileSync(path: URL, encoding: string): string; readdirSync(path: URL): string[] }>("node:fs");
const base = (import.meta as ImportMeta & { url: string }).url;
const migrations = new URL("../../migrations/", base);
const files = fs.readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort();
const databases: SqliteD1[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.sqlite.close(); });
function database() {
  const db = new SqliteD1(); databases.push(db);
  for (const file of files) db.sqlite.exec(fs.readFileSync(new URL(file, migrations), "utf8"));
  return db;
}
function seed(db: SqliteD1) {
  db.sqlite.exec(`INSERT INTO users(id,email,role) VALUES('u','u@example.test','admin');
    INSERT INTO projects(id,slug,name,created_by) VALUES('p','project','Original','u');
    INSERT INTO project_members(project_id,user_id,role,added_by) VALUES('p','u','owner','u');
    INSERT INTO cards(id,project_id,title,created_by_type,created_by_id) VALUES('c','p','Card','user','u');`);
}
const command = (extra: Partial<EventCommand> = {}): EventCommand => ({ projectId: "p", cardId: "c", eventType: "card.updated", actorType: "user", actorId: "u", payload: { change: "one" }, ...extra });
const update = (db: SqliteD1, expected = 1) => db.prepare("UPDATE cards SET version = version + 1 WHERE id = ?1 AND version = ?2").bind("c", expected) as unknown as D1PreparedStatement;
function loseNextBatchReply(db: SqliteD1) {
  const original = db.batch.bind(db);
  db.batch = async (statements) => {
    db.batch = original;
    await original(statements);
    throw new Error("reply lost after COMMIT");
  };
}

async function savedEvent(db: SqliteD1, expected = 1) {
  const saved = await commitCardEvent(db.asD1(), update(db, expected), command({ eventId: `e_${expected}`, messageId: `message-${expected}` }));
  expect(saved).not.toBeNull(); return saved!;
}

describe("durable mutation receipts", () => {
  it("rolls back all related writes when the adjacent outbox insertion fails", async () => {
    const db = database(); seed(db);
    db.sqlite.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON event_outbox BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
    const related = db.prepare("UPDATE projects SET name = 'Changed' WHERE id = ?1 AND EXISTS(SELECT 1 FROM cards WHERE id='c' AND version=1)").bind("p");
    await expect(commitCardEvent(db.asD1(), [related as unknown as D1PreparedStatement, update(db)], command())).rejects.toThrow();
    expect(db.sqlite.prepare("SELECT version FROM cards WHERE id='c'").get()?.version).toBe(1);
    expect(db.sqlite.prepare("SELECT name FROM projects WHERE id='p'").get()?.name).toBe("Original");
    expect(db.sqlite.prepare("SELECT COUNT(*) n FROM event_outbox").get()?.n).toBe(0);
  });

  it("does not enqueue an event when the final aggregate CAS loses", async () => {
    const db = database(); seed(db);
    expect(await commitCardEvent(db.asD1(), update(db, 9), command())).toBeNull();
    expect(db.sqlite.prepare("SELECT COUNT(*) n FROM event_outbox").get()?.n).toBe(0);
  });

  it("recovers an ambiguous committed reply using the immutable card snapshot", async () => {
    const db = database(); seed(db); loseNextBatchReply(db);
    const result = await commitCardEvent(db.asD1(), update(db), command({ eventId: "e_lost", receipt: { status: "open", version: 2 } }));
    expect(result?.card?.version).toBe(2);
    db.sqlite.exec("UPDATE cards SET version=3 WHERE id='c'");
    expect(result?.card?.version).toBe(2);
    expect(JSON.parse(result!.row.receipt_json)).toEqual({ status: "open", version: 2 });
  });

  it("rejects an event-id collision with a different command without applying its mutation", async () => {
    const db = database(); seed(db);
    await commitCardEvent(db.asD1(), update(db), command({ eventId: "e_same" }));
    await expect(commitCardEvent(db.asD1(), update(db, 2), command({ eventId: "e_same", payload: { change: "different" } }))).rejects.toThrow();
    expect(db.sqlite.prepare("SELECT version FROM cards WHERE id='c'").get()?.version).toBe(2);
  });

  it("deduplicates pending messages but rejects reuse for different request semantics", async () => {
    const db = database(); seed(db);
    const first = await commitCardEvent(db.asD1(), update(db), command({ messageId: "m_pending", requestHash: "same-request" }));
    const duplicate = await commitCardEvent(db.asD1(), update(db, 2), command({ messageId: "m_pending", requestHash: "same-request" }));
    expect(duplicate?.duplicate).toBe(true); expect(duplicate?.row.event_id).toBe(first?.row.event_id);
    expect(db.sqlite.prepare("SELECT version FROM cards WHERE id='c'").get()?.version).toBe(2);
    await expect(commitCardEvent(db.asD1(), update(db, 2), command({ messageId: "m_pending", requestHash: "different-request" }))).rejects.toMatchObject({ status: 409 });
    expect(db.sqlite.prepare("SELECT COUNT(*) n FROM event_outbox").get()?.n).toBe(1);
  });

  it("returns null card for project events including lost-reply recovery", async () => {
    const db = database(); seed(db); loseNextBatchReply(db);
    const result = await commitCardEvent(db.asD1(), db.prepare("UPDATE projects SET name='Changed' WHERE id=?1").bind("p") as unknown as D1PreparedStatement,
      command({ cardId: null, eventType: "project.updated" }));
    expect(result?.card).toBeNull(); expect(result?.row.card_snapshot_json).toBeNull();
  });

  it("returns a durable accepted result when publication is unavailable", async () => {
    const db = database(); seed(db); const app = new Hono<AppEnv>();
    app.post("/write", async (c) => {
      const result = await commitAndPublish(c, update(db), command({ receipt: { status: "open" } }));
      return c.json(result, result?.event_pending ? 202 : 200);
    });
    const env = { DB: db.asD1(), BOARD_DO: { getByName: () => ({ publish: async () => { throw new Error("offline"); } }) } } as unknown as Env;
    const response = await app.fetch(new Request("http://local/write", { method: "POST", body: "{}" }), env);
    expect(response.status).toBe(202);
    const result = await response.json() as { card: { version: number }; seq: null; event_pending: boolean };
    expect(result.card.version).toBe(2); expect(result.seq).toBeNull(); expect(result.event_pending).toBe(true);
    expect(db.sqlite.prepare("SELECT COUNT(*) n FROM event_outbox WHERE published_seq IS NULL").get()?.n).toBe(1);
  });

  it("recovers a lost DO RPC reply from the durable publication marker", async () => {
    const db = database(); seed(db); const saved = await savedEvent(db);
    const env = { DB: db.asD1(), BOARD_DO: { getByName: () => ({ publish: async () => {
      await publishOutboxEvent(db.asD1(), saved.row, await reconcileEvents(db.asD1(), "p"));
      throw new Error("DO reply lost after publication");
    } }) } } as unknown as Env;
    expect(await publishCommitted(env, saved)).toMatchObject({ event_pending: false, seq: 1 });
  });
});

describe("atomic publication and audit verification", () => {
  it("publishes event, audit, receipt marker and checkpoint atomically and recovers a lost reply", async () => {
    const db = database(); seed(db); const saved = await savedEvent(db); const head = await reconcileEvents(db.asD1(), "p");
    db.sqlite.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'injected audit failure'); END");
    await expect(publishOutboxEvent(db.asD1(), saved.row, head)).rejects.toThrow();
    expect(db.sqlite.prepare("SELECT COUNT(*) n FROM card_events").get()?.n).toBe(0);
    expect(db.sqlite.prepare("SELECT published_seq FROM event_outbox").get()?.published_seq).toBeNull();
    db.sqlite.exec("DROP TRIGGER reject_audit"); loseNextBatchReply(db);
    expect((await publishOutboxEvent(db.asD1(), saved.row, head)).seq).toBe(1);
    expect(await verifyProjectAudit(db.asD1(), "p")).toMatchObject({ ok: true, complete: true, pending: 0, checked: 1 });
  });

  it("rejects corrupted persisted rows during ambiguous publication recovery", async () => {
    const db = database(); seed(db); const saved = await savedEvent(db); const head = await reconcileEvents(db.asD1(), "p");
    await publishOutboxEvent(db.asD1(), saved.row, head);
    db.sqlite.exec("UPDATE audit_log SET actor_id='different' WHERE seq=1");
    await expect(publishOutboxEvent(db.asD1(), saved.row, head)).rejects.toThrow();
  });

  it("reports pending separately and verifies all pages through the frozen tail", async () => {
    const db = database(); seed(db); let head = await reconcileEvents(db.asD1(), "p");
    for (let version = 1; version <= 6; version++) {
      const saved = await savedEvent(db, version);
      if (version === 6) {
        expect(await verifyProjectAudit(db.asD1(), "p", 2)).toMatchObject({ ok: true, complete: false, pending: 1, as_of_seq: 5 });
      }
      head = await publishOutboxEvent(db.asD1(), saved.row, head);
    }
    expect(await verifyProjectAudit(db.asD1(), "p", 2)).toMatchObject({ ok: true, complete: true, checked: 6 });
    db.sqlite.exec("UPDATE audit_log SET payload_json='{}' WHERE seq=5");
    expect((await verifyProjectAudit(db.asD1(), "p", 2)).ok).toBe(false);
  });

  it.each(["missing", "changed", "malformed"])("rejects a %s middle event even when the audit chain and maximum sequences are intact", async (damage) => {
    const db = database(); seed(db); let head = await reconcileEvents(db.asD1(), "p");
    for (let version = 1; version <= 3; version++) head = await publishOutboxEvent(db.asD1(), (await savedEvent(db, version)).row, head);
    if (damage === "missing") db.sqlite.exec("DELETE FROM card_events WHERE seq=2");
    else db.sqlite.prepare("UPDATE card_events SET payload_json=? WHERE seq=2").run(damage === "changed" ? '{"change":"different"}' : "invalid-json");
    const verified = await verifyProjectAudit(db.asD1(), "p", 1);
    expect(verified.ok).toBe(false); expect(verified.complete).toBe(false);
    expect(verified.errors).toContainEqual(expect.objectContaining({ seq: 2, code: damage === "missing" ? "SEQ_GAP" : "HASH_MISMATCH" }));
  });

  it("accepts semantically identical event JSON formatting", async () => {
    const db = database(); seed(db); const saved = await savedEvent(db);
    await publishOutboxEvent(db.asD1(), saved.row, await reconcileEvents(db.asD1(), "p"));
    db.sqlite.exec(`UPDATE card_events SET payload_json='{ "change" : "one" }' WHERE seq=1`);
    expect(await verifyProjectAudit(db.asD1(), "p", 1)).toMatchObject({ ok: true, complete: true });
  });
});

describe("schema snapshot and continuous authorization", () => {
  it("keeps the schema snapshot aligned with the initial migration's columns and named indexes", () => {
    const migrated = database(); const snapshot = new SqliteD1(); databases.push(snapshot);
    snapshot.sqlite.exec(fs.readFileSync(new URL("../../db/schema.sql", base), "utf8"));
    const tables = migrated.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    for (const row of tables) {
      const fields = (db: SqliteD1) => db.sqlite.prepare(`PRAGMA table_info(${String(row.name)})`).all()
        .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      expect(fields(snapshot), String(row.name)).toEqual(fields(migrated));
    }
    const indexes = (db: SqliteD1) => db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    expect(indexes(snapshot)).toEqual(indexes(migrated));
  });

  it("creates a validated empty checkpoint when a project has no audit yet", async () => {
    const db = database(); seed(db);
    expect(await reconcileEvents(db.asD1(), "p")).toEqual({ seq: 0, hash: ZERO_HASH });
    expect(db.sqlite.prepare("SELECT seq,hash FROM project_event_heads").get()).toEqual({ seq: 0, hash: ZERO_HASH });
  });

  it("checks each session, epoch and archived project in batched SSE authorization", async () => {
    const db = database(); seed(db);
    db.sqlite.exec("INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES('s1','u','h1','2099-01-01T00:00:00.000Z'),('s2','u','h2','2099-01-01T00:00:00.000Z')");
    const principals = ["s1", "s2"].map((sessionId) => ({ userId: "u", authVersion: 1, sessionId, mode: "session" as const }));
    expect(await authorizedPrincipalIndexes(db.asD1(), principals, "p")).toEqual(new Set([0, 1]));
    db.sqlite.exec("UPDATE user_sessions SET revoked_at='2026-01-01T00:00:00.000Z' WHERE id='s1'");
    expect(await authorizedPrincipalIndexes(db.asD1(), principals, "p")).toEqual(new Set([1]));
    db.sqlite.exec("UPDATE users SET auth_version=2 WHERE id='u'");
    expect(await authorizedPrincipalIndexes(db.asD1(), principals, "p")).toEqual(new Set());
    db.sqlite.exec("UPDATE users SET auth_version=1 WHERE id='u'; UPDATE projects SET archived_at='2026-01-01T00:00:00.000Z' WHERE id='p'");
    expect(await authorizedPrincipalIndexes(db.asD1(), principals, "p")).toEqual(new Set());
  });

  it("pages equal timestamps without gaps and binds cursors to the authorized project set", async () => {
    const db = database(); seed(db);
    db.sqlite.exec("UPDATE cards SET updated_at='2026-01-01T00:00:00.000Z' WHERE id='c'; INSERT INTO cards(id,project_id,title,created_by_type,created_by_id,updated_at) VALUES('c2','p','Card','user','u','2026-01-01T00:00:00.000Z'),('c3','p','Card','user','u','2026-01-01T00:00:00.000Z')");
    const first = await listAgentCards(db.asD1(), ["p"], { order: "updated", limit: "2" });
    const second = await listAgentCards(db.asD1(), ["p"], { order: "updated", limit: "2", cursor: first.next_cursor! });
    expect([...first.cards, ...second.cards].map((card) => card.id)).toEqual(["c", "c2", "c3"]);
    await expect(listAgentCards(db.asD1(), ["other"], { order: "updated", cursor: first.next_cursor! })).rejects.toMatchObject({ status: 400 });
  });
});
