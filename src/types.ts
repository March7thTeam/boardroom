export interface Env {
  DB: D1Database;
  BOARD_DO: DurableObjectNamespace<import("./do/board").BoardDO>;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  AUTH_MODE?: "session" | "access";
  ADMIN_EMAILS?: string;
  DEV_IDENTITY_EMAIL?: string;
  TOKEN_PEPPER: string;
  GITHUB_TOKEN?: string;
  APP_BASE_URL?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM?: string;
  SMTP_SECURE?: "on" | "starttls" | "off";
  SMTP_REPLY_TO?: string;
}

export interface UserRow {
  auth_version: number;
  id: string;
  email: string;
  display_name: string | null;
  role: "admin" | "member";
  status: "active" | "disabled";
  password_hash: string | null;
  password_updated_at: string | null;
  must_change_password: number;
  last_seen_at: string | null;
  created_at: string;
}

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  verification_mode: "human" | "rule";
  exec_targets_json: string;
  created_by: string;
  created_at: string;
  archived_at: string | null;
  archived_by: string | null;
  archive_reason: string | null;
}

export interface AgentProjectRow {
  agent_id: string;
  project_id: string;
  status: "pending" | "active" | "disabled";
  /** 项目内标识；home 行由迁移回填，guest 行在加入项目时分配。 */
  local_slug: string | null;
  display_name: string | null;
  /** 该 (agent, project) 的凭据代次；轮换只影响本项目。 */
  token_version: number;
  assigned_by: string | null;
  assigned_at: string;
  updated_at: string;
}

export interface AgentRow {
  id: string;
  project_id: string;
  slug: string;
  status: "pending" | "active" | "disabled";
  harness: string;
  harness_version: string;
  harness_raw: string | null;
  self_reported_name: string | null;
  display_name: string | null;
  avatar_key: string | null;
  capabilities_json: string | null;
  max_concurrency: number;
  token_version: number;
  last_seen_at: string | null;
  edited_by: string | null;
  edited_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CardRow {
  id: string;
  project_id: string;
  parent_card_id: string | null;
  title: string;
  body: string | null;
  status: "open" | "engaged" | "running" | "review" | "closed";
  outcome: "done" | "rejected" | "cancelled" | "expired" | null;
  version: number;
  round: number;
  priority: number;
  requester_agent_id: string | null;
  assignee_agent_id: string | null;
  assignee_user_id: string | null;
  criteria_json: string | null;
  verifier_id: string | null;
  verdict_reasons_json: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  paused_at: string | null;
  deadline_at: string | null;
  evidence_hash: string | null;
  created_by_type: "agent" | "user" | "system";
  created_by_id: string;
  created_at: string;
  updated_at: string;
}

export interface CardEventRow {
  event_id: string;
  project_id: string;
  seq: number;
  card_id: string | null;
  message_id: string | null;
  event_type: string;
  actor_type: "agent" | "user" | "system";
  actor_id: string;
  payload_json: string;
  created_at: string;
}

export interface NegotiationSessionRow {
  id: string;
  card_id: string;
  initiator_agent_id: string | null;
  initiator_user_id: string | null;
  responder_agent_id: string;
  round: number;
  state: "open" | "committed" | "failed" | "cancelled" | "expired";
  created_at: string;
  closed_at: string | null;
}

export interface ProposalRow {
  id: string;
  session_id: string;
  from_agent_id: string;
  seq_in_session: number;
  terms_json: string;
  terms_hash: string;
  status: "offered" | "countered" | "accepted" | "rejected" | "expired";
  supersedes_id: string | null;
  created_at: string;
}

export interface ContractRow {
  id: string;
  card_id: string;
  session_id: string;
  proposer_agent_id: string | null;
  proposer_user_id: string | null;
  acceptor_agent_id: string | null;
  acceptor_user_id: string | null;
  terms_json: string;
  terms_hash: string;
  acceptance_proof_json: string;
  state: "active" | "fulfilled" | "breached" | "superseded";
  version: number;
  created_at: string;
  closed_at: string | null;
}

export interface AttemptRow {
  id: string;
  card_id: string;
  contract_id: string;
  agent_id: string;
  attempt_no: number;
  status: "issued" | "running" | "succeeded" | "failed" | "abandoned";
  ticket_nonce: string;
  provider: "github_actions" | "gitlab_ci" | "jenkins" | "manual" | null;
  provider_ref: string | null;
  run_url: string | null;
  head_sha: string | null;
  verify_result: "ok" | "not_found" | "sha_mismatch" | "failed" | "unverifiable" | null;
  verified_at: string | null;
  error_code: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface EvidenceRow {
  id: string;
  card_id: string;
  attempt_id: string | null;
  kind: "artifact" | "log" | "report" | "link" | "attestation";
  r2_key: string | null;
  sha256: string;
  size_bytes: number;
  media_type: string | null;
  summary: string | null;
  produced_by: string;
  created_at: string;
}

export interface InterventionRow {
  id: string;
  card_id: string;
  actor_id: string;
  type: "redirect" | "reject" | "takeover" | "pause" | "resume";
  reason: string;
  payload_json: string | null;
  affected_subtree_json: string | null;
  created_at: string;
}

export interface AuditRow {
  id: number;
  project_id: string;
  seq: number;
  event_type: string;
  actor_type: "agent" | "user" | "system";
  actor_id: string;
  card_id: string | null;
  payload_json: string;
  prev_hash: string;
  hash: string;
  batch_id: string;
  created_at: string;
}
