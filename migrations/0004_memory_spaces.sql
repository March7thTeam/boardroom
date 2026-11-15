-- 0004_memory_spaces.sql —— 项目记忆空间（P1：1 项目 : 1 空间 + 双方确认的跨项目链接）
--
-- 设计取舍（GitHub March7thTeam/boardroom#11 的决策线）：
--   * 记忆默认留在项目内。每条记忆有一个作者可控的 `shareable` 开关（默认 0），
--     它只表示「允许被申请链接」，不等于已经对外可见。
--   * 跨项目不是共享视图，也不是持票读取：链接必须由**源项目与目标项目的人类
--     各确认一次**（pending_source → pending_target → active），对齐
--     「Agent 不因项目内写权限自动获得对外可见」。Agent 只能发起申请。
--   * 快照归**目标项目**：链接生效后，读取只校验目标项目的 active 成员关系，
--     不再校验源项目。源条目/源项目被物理删除后，链接与快照仍在（SET NULL），
--     读取返回 source_missing。
--   * 记忆内容一经创建不可修改（只有创建与删除），因此条目没有「版本历史」，
--     也不存在「链接跟版」的问题。
--   * 链接在**双人确认生效的那一刻**把标题/正文冻结进链接行（frozen_*）。
--     之后源条目删除，目标项目仍可读，只是标记 source_deleted=true；
--     内容可读性不再依赖源行是否存在。
--   * space 与 project 是 1:1；项目删除时空间、条目与链接级联删除。
--   * 记忆事件是项目级事件（event_outbox.card_id = NULL），因此需要一条针对
--     NULL 卡片的部分唯一索引，否则 message_id 幂等对记忆事件不生效。

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
  body_hash       TEXT NOT NULL,
  tags_json       TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
  version         INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- 作者级闸门：允许被申请跨项目链接。默认关闭 = 记忆默认留在项目内。
  shareable       INTEGER NOT NULL DEFAULT 0 CHECK (shareable IN (0,1)),
  source_card_id  TEXT REFERENCES cards(id) ON DELETE SET NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('agent','user','system')),
  created_by_id   TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- 增量同步与 /agent/cards 一致：updated_at 键集 + id 兜底，稳定排序。
CREATE INDEX idx_memory_entries_sync ON memory_entries(space_id, updated_at, id);
CREATE INDEX idx_memory_entries_status ON memory_entries(space_id, status, updated_at);

-- 跨项目链接：源项目与目标项目的人类各确认一次才 active。申请方可以是 agent。
CREATE TABLE memory_entry_links (
  id                 TEXT PRIMARY KEY,
  -- SET NULL 而非 CASCADE：源条目/源项目被物理删除后，冻结快照必须留在目标项目。
  entry_id           TEXT REFERENCES memory_entries(id) ON DELETE SET NULL,
  from_project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
  to_project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  state              TEXT NOT NULL DEFAULT 'pending_source'
                       CHECK (state IN ('pending_source','pending_target','active','rejected','revoked')),
  requested_by_type  TEXT NOT NULL CHECK (requested_by_type IN ('agent','user','system')),
  requested_by_id    TEXT NOT NULL,
  requested_at       TEXT NOT NULL,
  source_approved_by TEXT,
  source_approved_at TEXT,
  target_approved_by TEXT,
  target_approved_at TEXT,
  rejected_by        TEXT,
  rejected_at        TEXT,
  rejected_reason    TEXT,
  revoked_by         TEXT,
  revoked_at         TEXT,
  -- 双方确认生效时冻结的内容；之后与源条目是否还在无关。
  frozen_title       TEXT,
  frozen_body        TEXT,
  frozen_body_hash   TEXT,
  frozen_at          TEXT,
  CHECK (from_project_id <> to_project_id),
  CHECK (state <> 'active' OR (frozen_body IS NOT NULL AND frozen_body_hash IS NOT NULL))
);
-- 同一对 (条目, 目标项目) 同时只能有一条未结束的链接。
CREATE UNIQUE INDEX uq_memory_link_open
  ON memory_entry_links(entry_id, to_project_id)
  WHERE state IN ('pending_source','pending_target','active');
CREATE INDEX idx_memory_link_target ON memory_entry_links(to_project_id, state);
CREATE INDEX idx_memory_link_source ON memory_entry_links(from_project_id, state);

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

-- 链接的来源项目必须与条目所属项目一致，避免伪造来源。
CREATE TRIGGER trg_memory_link_source_guard_insert
BEFORE INSERT ON memory_entry_links
FOR EACH ROW WHEN NEW.from_project_id IS NOT NULL
  AND (SELECT project_id FROM memory_entries WHERE id = NEW.entry_id) <> NEW.from_project_id
BEGIN
  SELECT RAISE(ABORT, 'memory_entry_links.from_project_id must match the entry project');
END;

CREATE TRIGGER trg_memory_link_source_guard_update
BEFORE UPDATE OF entry_id, from_project_id ON memory_entry_links
FOR EACH ROW WHEN NEW.from_project_id IS NOT NULL AND NEW.entry_id IS NOT NULL
  AND (SELECT project_id FROM memory_entries WHERE id = NEW.entry_id) <> NEW.from_project_id
BEGIN
  SELECT RAISE(ABORT, 'memory_entry_links.from_project_id must match the entry project');
END;
