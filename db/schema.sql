-- Boardroom beta schema · 25 张表（单一初始迁移）
--
-- 0.1.0-beta 起不再维护 alpha 增量升级路径：
--   * 0001–0010 已合并为本文件；数据库只支持全新建库，
--     不提供从 alpha 实例原地升级的迁移。
--   * Agent 身份彻底项目化：agents 只保留全局 harness/展示档案；
--     项目访问与身份（local_slug / display_name / token_version）由
--     agent_projects 决定。legacy 的 agents.project_id / agents.status /
--     agents.token_version 与 agent_assignments 已移除。
--   * 凭据总是 `<project_id>:<local_slug>` 的 scoped kbt1 token；
--     不存在跨项目/未 scoped 的旧格式凭据。
-- 5 状态：open → engaged → running → review → closed（outcome 区分终态）
-- 执行走外部 CI：attempts 承担"执行票据 + 运行证据"职责

PRAGMA foreign_keys = ON;

-- ---------- 身份 ----------
CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  display_name        TEXT,
  role                TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  password_hash       TEXT,                 -- pbkdf2$iterations$salt$hash；NULL 表示只能由 Access/管理员开通
  password_updated_at TEXT,
  auth_version        INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  last_seen_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE user_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  auth_version INTEGER NOT NULL DEFAULT 1,
  user_agent   TEXT,
  ip_hash      TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX idx_sessions_user ON user_sessions(user_id, revoked_at);
CREATE INDEX idx_sessions_expiry ON user_sessions(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE user_auth_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  email      TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('bootstrap','login_success','login_failed','logout','password_changed','password_reset','session_revoked')),
  ip_hash    TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_auth_events_email ON user_auth_events(email, created_at DESC);

CREATE TABLE instance_settings (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE email_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body_text  TEXT,
  provider   TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('sent','failed','skipped')),
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at    TEXT
);
CREATE INDEX idx_email_log_created ON email_log(created_at DESC);
CREATE INDEX idx_email_log_user ON email_log(user_id, created_at DESC);

CREATE TABLE projects (
  id                TEXT PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  verification_mode TEXT NOT NULL DEFAULT 'human' CHECK (verification_mode IN ('human','rule')),
  exec_targets_json TEXT NOT NULL DEFAULT '[]',   -- [{"provider":"github_actions","owner":"acme","repo":"etl","workflows":["normalize.yml"]}]
  created_by        TEXT NOT NULL REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at       TEXT,
  archived_by       TEXT REFERENCES users(id),
  archive_reason    TEXT
);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner','member')),
  added_by   TEXT NOT NULL REFERENCES users(id),
  added_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX idx_members_user ON project_members(user_id);
-- 每个项目只有一个 owner；变更走转让。
CREATE UNIQUE INDEX uq_project_single_owner ON project_members(project_id) WHERE role = 'owner';

CREATE TABLE project_join_requests (
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected')),
  note         TEXT,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_by   TEXT REFERENCES users(id),
  decided_at   TEXT,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX idx_join_requests_project ON project_join_requests(project_id, status, requested_at DESC);
CREATE INDEX idx_join_requests_user ON project_join_requests(user_id, status);

CREATE TABLE project_tokens (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  prefix     TEXT NOT NULL,
  hash       TEXT NOT NULL,
  max_agents INTEGER NOT NULL DEFAULT 50 CHECK (max_agents > 0),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_ptokens_project ON project_tokens(project_id, revoked_at);

-- ---------- Agent ----------
-- agents 仅承载全局 harness/展示档案；项目成员资格与项目内身份
-- （local_slug / display_name / token_version）完全由 agent_projects 决定。
CREATE TABLE agents (
  id                 TEXT PRIMARY KEY,     -- `ag_<ulid>`，内部主键；对外身份是 scoped ref
  slug               TEXT NOT NULL,        -- 注册时的基础 slug，用于跨项目分配 local_slug
  harness            TEXT NOT NULL DEFAULT 'unknown',
  harness_version    TEXT NOT NULL DEFAULT 'unknown',
  harness_raw        TEXT,
  self_reported_name TEXT,
  display_name       TEXT,
  avatar_key         TEXT,
  capabilities_json  TEXT,          -- {"skills":["etl","sql"],"max_concurrency":2}
  max_concurrency    INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrency BETWEEN 1 AND 16),
  last_seen_at       TEXT,          -- 认证请求心跳，AGENT_ONLINE_TTL_MINUTES 内视为在线
  edited_by          TEXT REFERENCES users(id),
  edited_at          TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE agent_registrations (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id           TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id         TEXT REFERENCES projects(id),
  harness            TEXT NOT NULL,
  harness_version    TEXT NOT NULL,
  self_reported_name TEXT,
  raw_payload        TEXT,
  registered_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_reg_agent ON agent_registrations(agent_id, registered_at DESC);
CREATE INDEX idx_reg_project ON agent_registrations(project_id, registered_at DESC);

-- Agent ↔ 项目成员资格：项目访问、项目内身份与凭据代次都由此决定。
CREATE TABLE agent_projects (
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','active','disabled')),
  local_slug  TEXT NOT NULL,           -- 项目内公开身份 `<project_id>:<local_slug>`
  display_name TEXT,
  token_version INTEGER NOT NULL DEFAULT 1,
  assigned_by TEXT REFERENCES users(id),
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (agent_id, project_id)
);

CREATE UNIQUE INDEX uq_agent_project_slug
  ON agent_projects(project_id, local_slug);
CREATE INDEX idx_agent_projects_project ON agent_projects(project_id, status);
CREATE INDEX idx_agent_projects_agent ON agent_projects(agent_id, status);

-- Scoped 凭据：每个 token 只绑定一个项目。
CREATE TABLE agent_tokens (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  prefix        TEXT NOT NULL,
  hash          TEXT NOT NULL,
  version       INTEGER NOT NULL,
  issued_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  last_used_day TEXT,
  UNIQUE (agent_id, project_id, version)
);

CREATE INDEX idx_agent_tokens_scope ON agent_tokens(agent_id, project_id, version);

-- ---------- 卡片（5 状态） ----------
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
  round              INTEGER NOT NULL DEFAULT 1 CHECK (round BETWEEN 1 AND 5),
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

CREATE TABLE card_deps (
  card_id            TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  depends_on_card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL DEFAULT 'blocks' CHECK (kind IN ('blocks','informs')),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (card_id, depends_on_card_id),
  CHECK (card_id <> depends_on_card_id)
);
CREATE INDEX idx_deps_rev ON card_deps(depends_on_card_id);

-- ---------- 事件（DO 单写者分配 seq；SSE/审计的持久事件表） ----------
CREATE TABLE card_events (
  event_id     TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  card_id      TEXT REFERENCES cards(id),
  message_id   TEXT,               -- 协商消息 ID；非消息事件为 NULL
  event_type   TEXT NOT NULL,
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('agent','user','system')),
  actor_id     TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, seq)
);
CREATE UNIQUE INDEX uq_event_msg ON card_events(card_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX idx_events_card ON card_events(card_id, seq);

-- ---------- 协商 ----------
CREATE TABLE negotiation_sessions (
  id                 TEXT PRIMARY KEY,
  card_id            TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  initiator_agent_id TEXT REFERENCES agents(id),
  initiator_user_id  TEXT REFERENCES users(id),
  responder_agent_id TEXT NOT NULL REFERENCES agents(id),
  round              INTEGER NOT NULL DEFAULT 1 CHECK (round BETWEEN 1 AND 5),
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

CREATE TABLE proposals (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES negotiation_sessions(id) ON DELETE CASCADE,
  from_agent_id  TEXT NOT NULL REFERENCES agents(id),
  seq_in_session INTEGER NOT NULL,
  terms_json     TEXT NOT NULL,
  terms_hash     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'offered'
                   CHECK (status IN ('offered','countered','accepted','rejected','expired')),
  supersedes_id  TEXT REFERENCES proposals(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (session_id, seq_in_session)
);
CREATE INDEX idx_proposals_session ON proposals(session_id, seq_in_session);

CREATE TABLE contracts (
  id                    TEXT PRIMARY KEY,
  card_id               TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  session_id            TEXT NOT NULL REFERENCES negotiation_sessions(id),
  proposer_agent_id     TEXT REFERENCES agents(id),
  proposer_user_id      TEXT REFERENCES users(id),
  acceptor_agent_id     TEXT REFERENCES agents(id),
  acceptor_user_id      TEXT REFERENCES users(id),
  terms_json            TEXT NOT NULL,
  terms_hash            TEXT NOT NULL,
  acceptance_proof_json TEXT NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'active'
                          CHECK (state IN ('active','fulfilled','breached','superseded')),
  version               INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at             TEXT,
  CHECK (
    (proposer_agent_id IS NOT NULL AND proposer_user_id IS NULL) OR
    (proposer_agent_id IS NULL AND proposer_user_id IS NOT NULL)
  ),
  CHECK (
    (acceptor_agent_id IS NOT NULL AND acceptor_user_id IS NULL) OR
    (acceptor_agent_id IS NULL AND acceptor_user_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX uq_contract_active ON contracts(card_id) WHERE state = 'active';

-- ---------- 执行票据与证据 ----------
CREATE TABLE attempts (
  id            TEXT PRIMARY KEY,
  card_id       TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  contract_id   TEXT NOT NULL REFERENCES contracts(id),
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  attempt_no    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'issued'
                  CHECK (status IN ('issued','running','succeeded','failed','abandoned')),
  ticket_nonce  TEXT NOT NULL,
  provider      TEXT CHECK (provider IN ('github_actions','gitlab_ci','jenkins','manual')),
  provider_ref  TEXT,             -- JSON：{"owner","repo","run_id"} / {"project_id","pipeline_id"}
  run_url       TEXT,
  head_sha      TEXT,
  verify_result TEXT CHECK (verify_result IN ('ok','not_found','sha_mismatch','failed','unverifiable')),
  verified_at   TEXT,
  error_code    TEXT,
  started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at      TEXT,
  UNIQUE (card_id, attempt_no),
  UNIQUE (ticket_nonce)
);
CREATE INDEX idx_attempts_card ON attempts(card_id, attempt_no DESC);
CREATE INDEX idx_attempts_open ON attempts(status, started_at) WHERE status IN ('issued','running');

CREATE TABLE evidence (
  id          TEXT PRIMARY KEY,
  card_id     TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  attempt_id  TEXT REFERENCES attempts(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('artifact','log','report','link','attestation')),
  r2_key      TEXT,
  sha256      TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  media_type  TEXT,
  summary     TEXT,
  produced_by TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (card_id, sha256, kind)
);
CREATE INDEX idx_evidence_card ON evidence(card_id, created_at DESC);

-- ---------- 干预 ----------
CREATE TABLE interventions (
  id                    TEXT PRIMARY KEY,
  card_id               TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  actor_id              TEXT NOT NULL REFERENCES users(id),
  type                  TEXT NOT NULL CHECK (type IN ('redirect','reject','takeover','pause','resume')),
  reason                TEXT NOT NULL CHECK (length(reason) >= 8),
  payload_json          TEXT,
  affected_subtree_json TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_interv_card ON interventions(card_id, created_at DESC);

-- ---------- 审计 ----------
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  event_type   TEXT NOT NULL,
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('agent','user','system')),
  actor_id     TEXT NOT NULL,
  card_id      TEXT,
  payload_json TEXT NOT NULL,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL,
  batch_id     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (project_id, seq)
);
CREATE INDEX idx_audit_project ON audit_log(project_id, seq);
CREATE INDEX idx_audit_card ON audit_log(project_id, card_id, seq);

-- ---------- 一致性：outbox 与持久 checkpoint ----------
-- D1 条件更新与 outbox 同一事务；BoardDO 是 seq 的唯一写者。
CREATE TABLE event_outbox (
  order_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  card_id TEXT,
  message_id TEXT,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('agent','user','system')),
  actor_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  request_hash TEXT,
  receipt_json TEXT NOT NULL DEFAULT '{}',
  card_snapshot_json TEXT,
  created_at TEXT NOT NULL,
  published_seq INTEGER
);
CREATE INDEX idx_outbox_pending ON event_outbox(project_id, order_id) WHERE published_seq IS NULL;
CREATE UNIQUE INDEX uq_outbox_message ON event_outbox(card_id, message_id) WHERE message_id IS NOT NULL;
CREATE TABLE project_event_heads (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  hash TEXT NOT NULL
);
