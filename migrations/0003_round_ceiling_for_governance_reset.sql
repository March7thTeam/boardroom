-- 0003: raise the round ceiling so governance `reset` can actually skip it.
--
-- The 5-round cap for NORMAL negotiation stays enforced in the route layer
-- (`card.round >= 5` -> 409 ROUND_LIMIT). The DB CHECK was written as
-- `round BETWEEN 1 AND 5`, which also (unintentionally) blocks the admin
-- `reset` action from opening round 6+ — the governance escape hatch
-- documented in docs/admin-action.md ("超过普通上限 5 时记录
-- round_limit_skipped: true，后续仍可通过 engage 继续治理推进") 500s on
-- `CHECK constraint failed: round BETWEEN 1 AND 5` instead.
--
-- SQLite cannot alter a CHECK in place, so both round-carrying tables have to
-- be rebuilt. A bare `CREATE new` + `INSERT` + `DROP TABLE` is NOT safe here:
--   * `cards` and `negotiation_sessions` are FK parents (CASCADE from card_deps,
--     negotiation_sessions, contracts, attempts, evidence, interventions, plus
--     proposals under sessions). DROP TABLE runs an implicit DELETE that fires
--     every ON DELETE CASCADE, so a live DB would silently lose that history
--     while the migration still reports success;
--   * `card_events.card_id` is NO ACTION, so a single existing event row makes
--     that implicit delete fail and aborts the whole migration.
-- Neither documented shortcut is available inside a migration:
--   * `PRAGMA foreign_keys=OFF` is a no-op inside a transaction, and D1 applies
--     a migration as one transactional batch;
--   * a RENAME swap does not help either — since SQLite 3.25 renaming a table
--     rewrites REFERENCES clauses in *other* tables (unaffected by
--     `PRAGMA legacy_alter_table`), so the old copy remains the cascade parent.
--
-- So: park every row that points at cards / negotiation_sessions, empty the
-- graph children-first, rebuild the two tables, then restore rows parents-first.
-- `cards.parent_card_id` and `proposals.supersedes_id` are self-references, so
-- they are filled in a second pass and restore order inside a table never
-- matters. Everything here is plain DML, safe under FK enforcement and inside
-- the migration transaction.
--
-- Regression cover: tests/backend/migrations.test.ts seeds the 0002 shape with
-- child rows, applies the migrations, and asserts that no row was lost.

CREATE TABLE _m3_cards         AS SELECT * FROM cards;
CREATE TABLE _m3_sessions      AS SELECT * FROM negotiation_sessions;
CREATE TABLE _m3_proposals     AS SELECT * FROM proposals;
CREATE TABLE _m3_contracts     AS SELECT * FROM contracts;
CREATE TABLE _m3_attempts      AS SELECT * FROM attempts;
CREATE TABLE _m3_evidence      AS SELECT * FROM evidence;
CREATE TABLE _m3_interventions AS SELECT * FROM interventions;
CREATE TABLE _m3_card_deps     AS SELECT * FROM card_deps;
CREATE TABLE _m3_card_events   AS SELECT * FROM card_events;

-- children first, so no cascade (and no NO ACTION guard) fires on the drops
DELETE FROM evidence;
DELETE FROM attempts;
DELETE FROM contracts;
DELETE FROM proposals;
DELETE FROM card_events;
DELETE FROM card_deps;
DELETE FROM interventions;
DELETE FROM negotiation_sessions;

DROP TABLE cards;
DROP TABLE negotiation_sessions;

CREATE TABLE cards (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_card_id     TEXT REFERENCES cards(id),
  title              TEXT NOT NULL,
  body               TEXT,
  status             TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','engaged','running','review','closed')),
  outcome            TEXT CHECK (outcome IN ('done','rejected','cancelled','expired')),
  version            INTEGER NOT NULL DEFAULT 1,
  -- 普通协商的 5 轮上限由路由层强制（ROUND_LIMIT）；治理 reset 可开 round 6+，DB 上限放宽到 100
  round              INTEGER NOT NULL DEFAULT 1 CHECK (round BETWEEN 1 AND 100),
  priority           INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
  requester_agent_id TEXT REFERENCES agents(id),
  assignee_agent_id  TEXT REFERENCES agents(id),
  assignee_user_id   TEXT REFERENCES users(id),
  criteria_json      TEXT,
  verifier_id        TEXT,
  verdict_reasons_json TEXT,
  lease_owner        TEXT,
  lease_expires_at   TEXT,
  paused_at          TEXT,
  deadline_at        TEXT,
  evidence_hash      TEXT,
  created_by_type    TEXT NOT NULL CHECK (created_by_type IN ('agent','user','system')),
  created_by_id      TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (parent_card_id IS NULL OR parent_card_id <> id),
  CHECK (assignee_agent_id IS NULL OR assignee_user_id IS NULL),
  -- closed 必须有 outcome，非 closed 必须没有
  CHECK ((status = 'closed') = (outcome IS NOT NULL))
);

CREATE INDEX idx_cards_col ON cards(project_id, status, priority DESC, updated_at DESC);
CREATE INDEX idx_cards_assignee ON cards(project_id, assignee_agent_id, status);
CREATE INDEX idx_cards_lease ON cards(project_id, lease_expires_at) WHERE lease_owner IS NOT NULL;
CREATE INDEX idx_agent_cards_incremental ON cards(project_id, updated_at, id);

CREATE TABLE negotiation_sessions (
  id                 TEXT PRIMARY KEY,
  card_id            TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  initiator_agent_id TEXT REFERENCES agents(id),
  initiator_user_id  TEXT REFERENCES users(id),
  responder_agent_id TEXT NOT NULL REFERENCES agents(id),
  round              INTEGER NOT NULL DEFAULT 1 CHECK (round BETWEEN 1 AND 100),
  state              TEXT NOT NULL DEFAULT 'open'
                     CHECK (state IN ('open','committed','failed','cancelled','expired')),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at          TEXT,
  UNIQUE (card_id, round),
  CHECK (
    (initiator_agent_id IS NOT NULL AND initiator_user_id IS NULL) OR
    (initiator_agent_id IS NULL AND initiator_user_id IS NOT NULL)
  )
);

CREATE INDEX idx_sessions_card ON negotiation_sessions(card_id, round DESC);

-- restore, parents first
INSERT INTO cards
  (id, project_id, title, body, status, outcome, version, round, priority,
   requester_agent_id, assignee_agent_id, assignee_user_id, criteria_json, verifier_id,
   verdict_reasons_json, lease_owner, lease_expires_at, paused_at, deadline_at, evidence_hash,
   created_by_type, created_by_id, created_at, updated_at)
SELECT id, project_id, title, body, status, outcome, version, round, priority,
       requester_agent_id, assignee_agent_id, assignee_user_id, criteria_json, verifier_id,
       verdict_reasons_json, lease_owner, lease_expires_at, paused_at, deadline_at, evidence_hash,
       created_by_type, created_by_id, created_at, updated_at
FROM _m3_cards;

UPDATE cards
   SET parent_card_id = (SELECT b.parent_card_id FROM _m3_cards b WHERE b.id = cards.id)
 WHERE EXISTS (SELECT 1 FROM _m3_cards b WHERE b.id = cards.id AND b.parent_card_id IS NOT NULL);

INSERT INTO negotiation_sessions
  (id, card_id, initiator_agent_id, initiator_user_id, responder_agent_id, round, state,
   created_at, closed_at)
SELECT id, card_id, initiator_agent_id, initiator_user_id, responder_agent_id, round, state,
       created_at, closed_at
FROM _m3_sessions;

INSERT INTO proposals
  (id, session_id, from_agent_id, seq_in_session, terms_json, terms_hash, status, created_at)
SELECT id, session_id, from_agent_id, seq_in_session, terms_json, terms_hash, status, created_at
FROM _m3_proposals;

UPDATE proposals
   SET supersedes_id = (SELECT b.supersedes_id FROM _m3_proposals b WHERE b.id = proposals.id)
 WHERE EXISTS (SELECT 1 FROM _m3_proposals b WHERE b.id = proposals.id AND b.supersedes_id IS NOT NULL);

INSERT INTO contracts SELECT * FROM _m3_contracts;
INSERT INTO attempts SELECT * FROM _m3_attempts;
INSERT INTO evidence SELECT * FROM _m3_evidence;
INSERT INTO interventions SELECT * FROM _m3_interventions;
INSERT INTO card_deps SELECT * FROM _m3_card_deps;
INSERT INTO card_events SELECT * FROM _m3_card_events;

DROP TABLE _m3_cards;
DROP TABLE _m3_sessions;
DROP TABLE _m3_proposals;
DROP TABLE _m3_contracts;
DROP TABLE _m3_attempts;
DROP TABLE _m3_evidence;
DROP TABLE _m3_interventions;
DROP TABLE _m3_card_deps;
DROP TABLE _m3_card_events;
