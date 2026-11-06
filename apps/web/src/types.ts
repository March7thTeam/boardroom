export type ProjectRole = "owner" | "admin" | "member";

export type ProjectSummary = {
  id: string;
  slug: string;
  name: string;
  role: ProjectRole;
  verification_mode?: "human" | "rule";
  /** `admin`: reached as an instance admin without project membership (#5). */
  access?: "member" | "admin";
  archived_at?: string | null;
};

export type Project = ProjectSummary & {
  verification_mode: "human" | "rule";
  exec_targets_json: string;
  created_at: string;
};

export type ArchivedProject = {
  id: string;
  slug: string;
  name: string;
  archived_at: string;
  archived_by_email: string | null;
  archive_reason: string | null;
  role: ProjectRole;
  original_slug: string | null;
};

export type ProjectMember = {
  id: string;
  email: string;
  display_name: string | null;
  global_role: "admin" | "member";
  global_status: "active" | "disabled";
  role: ProjectRole;
  added_at: string;
};

export type ProjectJoinRequestStatus = "pending" | "approved" | "rejected";

export type ProjectJoinRequest = {
  project_id: string;
  user_id: string;
  status: ProjectJoinRequestStatus;
  note: string | null;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
};

export type ProjectJoinRequestWithUser = Omit<
  ProjectJoinRequest,
  "decided_by" | "decided_at"
> & {
  status: "pending";
  email: string;
  display_name: string | null;
  user_status: "active" | "disabled";
};

export type MyProjectJoinRequest = {
  project_id: string;
  project_name: string;
  project_slug: string;
  status: "pending" | "rejected";
  note: string | null;
  requested_at: string;
  decided_at: string | null;
};

export type CardStatus = "open" | "engaged" | "running" | "review" | "closed";

export type CardOutcome = "done" | "rejected" | "cancelled" | "expired" | null;

export type CardActorType = "agent" | "user" | "system";

export type Card = {
  id: string;
  project_id: string;
  title: string;
  body: string | null;
  status: CardStatus;
  outcome: CardOutcome;
  version: number;
  round: number;
  priority: number;
  criteria_json: string | null;
  assignee_agent_id: string | null;
  assignee_user_id?: string | null;
  requester_agent_id: string | null;
  created_by_type?: CardActorType;
  created_by_id?: string;
  deadline_at: string | null;
  paused_at?: string | null;
  verifier_id?: string | null;
  verdict_reasons_json?: string | null;
  evidence_hash?: string | null;
  created_at: string;
  updated_at: string;
  /** Resolved actor summaries added by the card API. */
  assignee_type?: "agent" | "user" | null;
  assignee_id?: string | null;
  assignee_name?: string | null;
  requester_type?: CardActorType;
  requester_id?: string | null;
  requester_name?: string | null;
  creator_type?: CardActorType;
  creator_id?: string;
  creator_name?: string | null;
};

export type NegotiationSession = {
  id: string;
  card_id: string;
  initiator_agent_id: string | null;
  initiator_user_id: string | null;
  responder_agent_id: string;
  round: number;
  state: "open" | "committed" | "failed" | "cancelled" | "expired";
  created_at: string;
  closed_at: string | null;
};

export type Proposal = {
  id: string;
  session_id: string;
  from_agent_id: string;
  seq_in_session: number;
  terms_json: string;
  terms_hash: string;
  status: "offered" | "countered" | "accepted" | "rejected" | "expired";
  supersedes_id: string | null;
  created_at: string;
};

export type Contract = {
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
};

export type ExecutionAttempt = {
  id: string;
  card_id: string;
  agent_id: string;
  attempt_no: number;
  status: "issued" | "running" | "succeeded" | "failed" | "abandoned";
  provider: string | null;
  run_url: string | null;
  head_sha: string | null;
  verify_result: string | null;
  verified_at: string | null;
  started_at: string;
  ended_at: string | null;
};

export type Evidence = {
  id: string;
  card_id: string;
  attempt_id: string | null;
  kind: string;
  sha256: string;
  size_bytes: number;
  summary: string | null;
  produced_by: string;
  created_at: string;
};

export type CardNegotiation = {
  session: NegotiationSession | null;
  proposals: Proposal[];
  contract: Contract | null;
  attempts: ExecutionAttempt[];
  evidence: Evidence[];
};

export type CardEvent = {
  event_id: string;
  seq: number;
  card_id: string | null;
  event_type: string;
  actor_type: "agent" | "user" | "system";
  actor_id: string;
  payload_json: string;
  created_at: string;
};

export type AcceptanceOp = "eq" | "gte" | "lte" | "matches" | "exists";

export type AcceptanceRule = {
  key: string;
  op: AcceptanceOp;
  value?: unknown;
  severity?: "block" | "warn";
};

export type AgentStatus = "pending" | "active" | "disabled";

export type AgentSummary = {
  id: string;
  slug: string;
  resolved_name: string;
  status: AgentStatus;
  harness: string;
  max_concurrency: number;
  project_count?: number;
};

export type UserProfile = {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
  status?: "active" | "disabled";
  must_change_password?: boolean;
  created_at?: string;
  last_seen_at?: string | null;
};

export type AdminOverviewResponse = {
  users: number;
  active_users: number;
  projects: number;
  cards: number;
  active_sessions: number;
};

export type UserAuthEvent = {
  event_type: string;
  ip_hash: string | null;
  user_agent: string | null;
  created_at: string;
};

export type AdminUserDetailResponse = {
  user: UserProfile;
  active_sessions: number;
  auth_events: UserAuthEvent[];
};

export type EmailSendResult = {
  ok: boolean;
  provider: string;
  status: "sent" | "failed" | "skipped";
  error?: string;
};

export type AdminEmailStatusResponse = {
  configured: boolean;
  provider: string;
  from: string | null;
  host: string | null;
  port: number | null;
  secure: string | null;
};

export type EmailLogEntry = {
  id: string;
  user_id: string | null;
  to_email: string;
  subject: string;
  provider: string;
  status: "sent" | "failed" | "skipped";
  error: string | null;
  created_at: string;
  sent_at: string | null;
};

export type AuthStatus = {
  needs_bootstrap: boolean;
  auth_mode: "session" | "access";
};

export type AuthResponse = {
  user: UserProfile;
  must_change_password: boolean;
};

export type SetupStatus = {
  needs_setup: boolean;
  instance_name: string;
  auth_mode: "session" | "access";
};

export type SetupInput = {
  instance_name: string;
  admin: {
    email: string;
    password: string;
    display_name?: string;
  };
  project?: {
    slug: string;
    name: string;
    verification_mode: "human" | "rule";
  };
};

export type SetupResponse = {
  user: UserProfile;
  instance_name: string;
  project: ProjectSummary | null;
  enrollment_token: string | null;
};

export type BoardColumns = {
  open: Card[];
  engaged: Card[];
  running: Card[];
  review: Card[];
  closed: Card[];
};

export type BoardResponse = {
  seq: number;
  project: ProjectSummary;
  columns: BoardColumns;
};

export type HealthResponse = {
  ok: boolean;
  d1: boolean | string;
  do: boolean | string;
  version: string;
};

export type MeResponse = {
  user: UserProfile;
  projects: ProjectSummary[];
};

export type ApiErrorPayload = {
  error: {
    code: string;
    message: string;
    details?: unknown;
    request_id: string;
  };
};

export type SseHelloFrame = {
  t: "hello";
  seq: number;
  server_time: string;
};

export type SseEventFrame = {
  t: "event";
  seq: number;
  e: {
    card_id: string | null;
    type: string;
    payload: Record<string, unknown>;
  };
};

export type SseResyncFrame = {
  t: "resync";
  from: number;
  reason: string;
};

export type SseFrame = SseHelloFrame | SseEventFrame | SseResyncFrame;

export type ConnectionStatus = "connected" | "reconnecting" | "offline";
