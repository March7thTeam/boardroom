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
-- SQLite cannot alter a CHECK in place, so rebuild both round-carrying
-- tables, preserving rows; the related-write paths run in one batch, so the
-- window between the two rebuilds inside a single migration transaction is
-- invisible to the Worker.
CREATE TABLE cards_v3 (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_card_id     TEXT REFERENCES cards(id),
  title              TEXT NOT NULL,
  body               TEXT,
  status             TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','engaged','running','review','closed')),
  outcome            TEXT CHECK (outcome IN ('done','rejected','cancelled','expired')),
  version            INTEGER NOT NULL DEFAULT 1,
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

INSERT INTO cards_v3 SELECT * FROM cards;
DROP TABLE cards;
ALTER TABLE cards_v3 RENAME TO cards;

CREATE INDEX idx_cards_col ON cards(project_id, status, priority DESC, updated_at DESC);
CREATE INDEX idx_cards_assignee ON cards(project_id, assignee_agent_id, status);
CREATE INDEX idx_cards_lease ON cards(project_id, lease_expires_at) WHERE lease_owner IS NOT NULL;
CREATE INDEX idx_agent_cards_incremental ON cards(project_id, updated_at, id);

CREATE TABLE negotiation_sessions_v3 (
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

INSERT INTO negotiation_sessions_v3 SELECT * FROM negotiation_sessions;
DROP TABLE negotiation_sessions;
ALTER TABLE negotiation_sessions_v3 RENAME TO negotiation_sessions;

CREATE INDEX idx_sessions_card ON negotiation_sessions(card_id, round DESC);
