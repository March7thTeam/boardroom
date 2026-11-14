-- 0004_memory_spaces.sql —— 项目记忆空间（P1：1 项目 : 1 空间 + 引用凭据）
--
-- 设计取舍（见 GitHub March7thTeam/boardroom#11 的决策评论）：
--   * 记忆不再跨项目共享数据库视图。每项目一份本地记忆，跨项目只能通过
--     A 侧签发的引用凭据（memory_ref_grants）授权，B 侧显式登记（memory_refs）。
--   * 引用绑定 (entry_id, entry_version, content_sha256)，源条目更新不会自动
--     更新下游引用；凭据撤销只停止后续读取，不能收回下游已取得的副本。
--   * space 与 project 是 1:1；项目删除时空间与其条目级联删除。
--   * 记忆事件是项目级事件（event_outbox.card_id = NULL），因此需要一条
--     针对 NULL 卡片的部分唯一索引，否则 message_id 幂等对记忆事件不生效。

PRAGMA foreign_keys = ON;

CREATE TABLE memory_spaces (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at TEXT
);

CREATE TABLE memory_entries (
  id              TEXT PRIMARY KEY,
  space_id        TEXT NOT NULL REFERENCES memory_spaces(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  tags_json       TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
  version         INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  source_card_id  TEXT REFERENCES cards(id) ON DELETE SET NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('agent','user','system')),
  created_by_id   TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- 增量同步与 /agent/cards 一致：updated_at 键集 + id 兜底，稳定排序。
CREATE INDEX idx_memory_entries_sync ON memory_entries(space_id, updated_at, id);
CREATE INDEX idx_memory_entries_status ON memory_entries(space_id, status, updated_at);

CREATE TABLE memory_revisions (
  id         TEXT PRIMARY KEY,
  entry_id   TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  body_hash  TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('agent','user','system')),
  actor_id   TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (entry_id, version)
);

CREATE TABLE memory_ref_grants (
  id              TEXT PRIMARY KEY,
  entry_id        TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
  entry_version   INTEGER NOT NULL,
  content_sha256  TEXT NOT NULL,
  to_project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  granted_by_type TEXT NOT NULL CHECK (granted_by_type IN ('agent','user','system')),
  granted_by_id   TEXT NOT NULL,
  granted_at      TEXT NOT NULL,
  expires_at      TEXT,
  revoked_at      TEXT,
  revoked_reason  TEXT
);
-- 同一 (条目, 版本, 目标项目) 同时只能有一条有效凭据；撤销后可重新签发。
CREATE UNIQUE INDEX uq_memory_grant_live
  ON memory_ref_grants(entry_id, entry_version, to_project_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_memory_grant_target ON memory_ref_grants(to_project_id, revoked_at);

CREATE TABLE memory_refs (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  space_id         TEXT NOT NULL REFERENCES memory_spaces(id) ON DELETE CASCADE,
  grant_id         TEXT NOT NULL UNIQUE REFERENCES memory_ref_grants(id) ON DELETE CASCADE,
  source_entry_id  TEXT NOT NULL,
  source_version   INTEGER NOT NULL,
  content_sha256   TEXT NOT NULL,
  title            TEXT NOT NULL,
  imported_by_type TEXT NOT NULL CHECK (imported_by_type IN ('agent','user','system')),
  imported_by_id   TEXT NOT NULL,
  imported_at      TEXT NOT NULL,
  revoked_at       TEXT
);
CREATE INDEX idx_memory_refs_space ON memory_refs(space_id, imported_at);

-- 记忆事件走项目级 outbox 行（card_id IS NULL）。SQLite 的 NULL 互不相等，
-- 现有 uq_outbox_message(card_id, message_id) 对这类行没有约束力。
CREATE UNIQUE INDEX uq_outbox_project_message
  ON event_outbox(project_id, message_id)
  WHERE card_id IS NULL AND message_id IS NOT NULL;

-- space ↔ project 一致性由数据库保证，而不是只靠调用方自觉。
CREATE TRIGGER trg_memory_entries_space_guard_insert
BEFORE INSERT ON memory_entries
FOR EACH ROW WHEN (SELECT project_id FROM memory_spaces WHERE id = NEW.space_id) <> NEW.project_id
BEGIN
  SELECT RAISE(ABORT, 'memory_entries.project_id must match its space project');
END;

CREATE TRIGGER trg_memory_entries_space_guard_update
BEFORE UPDATE OF space_id, project_id ON memory_entries
FOR EACH ROW WHEN (SELECT project_id FROM memory_spaces WHERE id = NEW.space_id) <> NEW.project_id
BEGIN
  SELECT RAISE(ABORT, 'memory_entries.project_id must match its space project');
END;
