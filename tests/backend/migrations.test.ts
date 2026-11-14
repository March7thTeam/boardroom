import { describe, expect, it } from "vitest";
import { builtin } from "../helpers/sqlite-d1";

const { readFileSync, readdirSync } = builtin<{
  readFileSync(path: URL, encoding: string): string;
  readdirSync(path: URL): string[];
}>("node:fs");

interface Statement {
  run(...values: unknown[]): { changes: number | bigint };
  get(...values: unknown[]): Record<string, unknown> | undefined;
  all(...values: unknown[]): Record<string, unknown>[];
}
interface Sqlite {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
const { DatabaseSync } = builtin<{ DatabaseSync: new (path: string) => Sqlite }>("node:sqlite");

const MIGRATIONS = new URL("../../migrations/", (import.meta as ImportMeta & { url: string }).url);
const SCHEMA_SNAPSHOT = new URL("../../db/schema.sql", (import.meta as ImportMeta & { url: string }).url);

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql")).sort();
}

/** A real SQLite connection with foreign keys enforced, like D1. */
function liveDb(upTo?: string): Sqlite {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of migrationFiles()) {
    if (upTo && file >= upTo) break;
    db.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }
  return db;
}

function tableNames(db: Sqlite): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%'")
    .all()
    .map((row) => String(row.name));
}

function rowCounts(db: Sqlite): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of tableNames(db)) {
    counts[table] = Number(db.prepare(`SELECT count(*) AS c FROM "${table}"`).get()!.c);
  }
  return counts;
}

/**
 * The 0002 shape of a live database: two rounds of negotiation history on one
 * card, plus every child row that references `cards` / `negotiation_sessions`.
 */
const SEED = `
INSERT INTO users(id,email,role) VALUES ('u1','owner@example.test','admin');
INSERT INTO projects(id,slug,name,created_by) VALUES ('p1','demo','Demo','u1');
INSERT INTO agents(id,slug) VALUES ('ag1','bot'),('ag2','peer');
INSERT INTO cards(id,project_id,parent_card_id,title,status,outcome,version,round,created_by_type,created_by_id)
  VALUES ('c0','p1',NULL,'parent card','closed','done',3,2,'user','u1'),
         ('c1','p1','c0','round 5 card','open',NULL,4,5,'user','u1'),
         ('c2','p1','c1','engaged child','engaged',NULL,2,3,'agent','ag1');
INSERT INTO card_deps(card_id,depends_on_card_id) VALUES ('c2','c1');
INSERT INTO negotiation_sessions(id,card_id,initiator_user_id,responder_agent_id,round,state,closed_at)
  VALUES ('s1','c1','u1','ag2',5,'cancelled','2026-01-02T00:00:00.000Z'),
         ('s2','c2','u1','ag2',3,'open',NULL);
INSERT INTO proposals(id,session_id,from_agent_id,seq_in_session,terms_json,terms_hash,status,supersedes_id)
  VALUES ('pr1','s1','ag2',1,'{"scope":"a"}','h1','countered',NULL),
         ('pr2','s1','ag2',2,'{"scope":"b"}','h2','accepted','pr1');
INSERT INTO contracts(id,card_id,session_id,proposer_user_id,acceptor_agent_id,terms_json,terms_hash,
                      acceptance_proof_json,state)
  VALUES ('ct1','c1','s1','u1','ag2','{"scope":"b"}','h2','{}','superseded');
INSERT INTO attempts(id,card_id,contract_id,agent_id,attempt_no,ticket_nonce,status)
  VALUES ('at1','c1','ct1','ag2',1,'n1','abandoned');
INSERT INTO evidence(id,card_id,attempt_id,kind,sha256,size_bytes,produced_by)
  VALUES ('ev1','c1','at1','log','h',10,'ag2');
INSERT INTO interventions(id,card_id,actor_id,type,reason)
  VALUES ('iv1','c1','u1','pause','stuck in review for too long');
INSERT INTO card_events(event_id,project_id,seq,card_id,event_type,actor_type,actor_id,payload_json)
  VALUES ('e1','p1',1,'c1','card.created','user','u1','{}'),
         ('e2','p1',2,'c2','card.created','agent','ag1','{}');
`;

const CHILD_TABLES = [
  "cards",
  "card_deps",
  "card_events",
  "negotiation_sessions",
  "proposals",
  "contracts",
  "attempts",
  "evidence",
  "interventions",
];

function dump(db: Sqlite, table: string): string {
  return JSON.stringify(db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all());
}

describe("migrations", () => {
  it("0003 rebuilds the round ceiling without losing child rows", () => {
    const db = liveDb("0003");
    db.exec(SEED);
    const before = rowCounts(db);
    const beforeDump = Object.fromEntries(CHILD_TABLES.map((table) => [table, dump(db, table)]));
    expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);

    db.exec(readFileSync(new URL("0003_round_ceiling_for_governance_reset.sql", MIGRATIONS), "utf8"));

    const after = rowCounts(db);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(after).toEqual(before);
    for (const table of CHILD_TABLES) {
      expect(dump(db, table), `${table} rows changed across the rebuild`).toBe(beforeDump[table]);
    }
    expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
    expect(tableNames(db).filter((name) => name.startsWith("_m3_"))).toEqual([]);
    db.close();
  });

  it("0003 keeps normal negotiation capped at 5 in the route layer only", () => {
    const db = liveDb();
    db.exec(`
      INSERT INTO users(id,email,role) VALUES ('u1','owner@example.test','admin');
      INSERT INTO projects(id,slug,name,created_by) VALUES ('p1','demo','Demo','u1');
      INSERT INTO agents(id,slug) VALUES ('ag1','bot');
      INSERT INTO cards(id,project_id,title,round,created_by_type,created_by_id)
        VALUES ('c1','p1','governance card',5,'user','u1');
    `);

    // governance `reset` may open round 6+; the DB only bounds the value
    db.prepare("UPDATE cards SET round = 6 WHERE id = 'c1'").run();
    expect(db.prepare("SELECT round FROM cards WHERE id = 'c1'").get()).toMatchObject({ round: 6 });
    db.prepare(
      "INSERT INTO negotiation_sessions(id,card_id,initiator_user_id,responder_agent_id,round) VALUES ('s6','c1','u1','ag1',6)",
    ).run();
    expect(() => db.prepare("UPDATE cards SET round = 101 WHERE id = 'c1'").run()).toThrow(/CHECK constraint failed/);
    expect(() =>
      db.prepare(
        "INSERT INTO negotiation_sessions(id,card_id,initiator_user_id,responder_agent_id,round) VALUES ('s101','c1','u1','ag1',101)",
      ).run(),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("rebuilt tables still cascade like the 0002 shape", () => {
    const db = liveDb();
    db.exec(SEED);
    // card_events.card_id is NO ACTION, so the event row has to go first
    db.exec("DELETE FROM card_events WHERE card_id = 'c2'");
    db.exec("DELETE FROM cards WHERE id = 'c2'");
    expect(db.prepare("SELECT count(*) AS c FROM card_deps").get()).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT count(*) AS c FROM negotiation_sessions WHERE card_id = 'c2'").get()).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT count(*) AS c FROM cards WHERE id = 'c2'").get()).toMatchObject({ c: 0 });
    // and the NO ACTION guard on card_events is intact
    expect(() => db.exec("DELETE FROM cards WHERE id = 'c1'")).toThrow(/FOREIGN KEY constraint failed/);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
    db.close();
  });

  it("db/schema.sql matches the migrated schema", () => {
    const migrated = liveDb();
    const snapshot = new DatabaseSync(":memory:");
    snapshot.exec("PRAGMA foreign_keys=ON");
    snapshot.exec(readFileSync(SCHEMA_SNAPSHOT, "utf8"));

    const normalize = (sql: unknown): string =>
      String(sql)
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .replace(/\s+/g, " ")
        .trim();

    for (const table of ["cards", "negotiation_sessions"]) {
      const fromMigrations = migrated
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
        .get(table);
      const fromSnapshot = snapshot.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(table);
      expect(normalize(fromSnapshot?.sql), `${table} drifted from db/schema.sql`).toBe(normalize(fromMigrations?.sql));
    }

    const indexNames = (db: Sqlite) =>
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((row) => String(row.name));
    expect(indexNames(snapshot)).toEqual(indexNames(migrated));
    migrated.close();
    snapshot.close();
  });
});
