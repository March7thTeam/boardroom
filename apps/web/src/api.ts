import type {
  AcceptanceOp,
  AcceptanceRule,
  AdminEmailStatusResponse,
  AdminOverviewResponse,
  AdminUserDetailResponse,
  AgentSummary,
  ApiErrorPayload,
  ArchivedProject,
  AuthResponse,
  AuthStatus,
  BoardResponse,
  Card,
  CardEvent,
  CardNegotiation,
  CardStatus,
  EmailLogEntry,
  EmailSendResult,
  HealthResponse,
  MeResponse,
  MyProjectJoinRequest,
  Project,
  ProjectJoinRequest,
  ProjectJoinRequestWithUser,
  ProjectMember,
  ProjectSummary,
  SetupInput,
  SetupResponse,
  SetupStatus,
  UserAuthEvent,
  UserProfile,
} from "./types";
import { getTranslator, readStoredLocale } from "./i18n/core";

export type WriteReceipt = { seq: number | null; event_pending?: boolean; event_id?: string };

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(opts: {
    status: number;
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  }) {
    super(opts.message);
    this.name = "ApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
    this.requestId = opts.requestId;
  }
}

async function request<T>(
  path: string,
  options: RequestInit & { ifMatch?: number | string } = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept-Language", readStoredLocale());
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (options.ifMatch !== undefined) {
    headers.set("If-Match", String(options.ifMatch));
  }

  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers,
  });

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const errPayload = parsed as Partial<ApiErrorPayload> | null;
    if (errPayload?.error && typeof errPayload.error.message === "string") {
      throw new ApiError({
        status: response.status,
        code: errPayload.error.code || `HTTP_${response.status}`,
        message: errPayload.error.message,
        details: errPayload.error.details,
        requestId: errPayload.error.request_id,
      });
    }
    throw new ApiError({
      status: response.status,
      code: `HTTP_${response.status}`,
      message: text || `请求失败 (HTTP ${response.status})`,
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError({ status: response.status, code: "INVALID_RESPONSE", message: getTranslator(readStoredLocale())("common.invalidResponse"), requestId: response.headers.get("x-request-id") ?? undefined });
  }
  return parsed as T;
}

export const api = {
  getHealth(): Promise<HealthResponse> {
    return request<HealthResponse>("/health");
  },

  getAuthStatus(): Promise<AuthStatus> {
    return request<AuthStatus>("/auth/status");
  },

  async getSetupStatus(): Promise<SetupStatus> {
    const result = await request<SetupStatus>("/setup/status");
    if (typeof result.needs_setup !== "boolean") {
      throw new ApiError({ status: 200, code: "INVALID_RESPONSE", message: getTranslator(readStoredLocale())("common.invalidResponse") });
    }
    return result;
  },

  setup(input: SetupInput): Promise<SetupResponse> {
    return request<SetupResponse>("/setup", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  login(email: string, password: string): Promise<AuthResponse> {
    return request<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  },

  bootstrap(
    email: string,
    password: string,
    displayName?: string,
  ): Promise<AuthResponse> {
    return request<AuthResponse>("/auth/bootstrap", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        ...(displayName?.trim() ? { display_name: displayName.trim() } : {}),
      }),
    });
  },

  logout(): Promise<{ ok: true }> {
    return request<{ ok: true }>("/auth/logout", { method: "POST" });
  },

  changePassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<{ ok: true; reauth_required: boolean }> {
    return request<{ ok: true; reauth_required: boolean }>("/auth/password", {
      method: "POST",
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: newPassword,
      }),
    });
  },

  getMe(): Promise<MeResponse> {
    return request<MeResponse>("/me");
  },

  getProjects(): Promise<{ projects: ProjectSummary[] }> {
    return request<{ projects: ProjectSummary[] }>("/projects");
  },

  createProject(input: {
    slug: string;
    name: string;
  }): Promise<{ project: Project; enrollment_token: string }> {
    return request<{ project: Project; enrollment_token: string }>("/projects", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  createProjectToken(
    projectId: string,
  ): Promise<{ enrollment_token: string; expires_in_days: number }> {
    return request<{ enrollment_token: string; expires_in_days: number }>(
      `/projects/${encodeURIComponent(projectId)}/tokens`,
      { method: "POST" },
    );
  },

  getProject(projectId: string): Promise<{ project: Project }> {
    return request<{ project: Project }>(`/projects/${encodeURIComponent(projectId)}`);
  },

  getBoard(projectId: string): Promise<BoardResponse> {
    return request<BoardResponse>(`/projects/${encodeURIComponent(projectId)}/board`);
  },

  getProjectCards(
    projectId: string,
    params?: { status?: CardStatus; limit?: number; cursor?: string },
  ): Promise<{ cards: Card[]; next_cursor: string | null }> {
    const search = new URLSearchParams();
    if (params?.status) search.set("status", params.status);
    if (params?.limit !== undefined) search.set("limit", String(params.limit));
    if (params?.cursor) search.set("cursor", params.cursor);
    const qs = search.toString();
    return request<{ cards: Card[]; next_cursor: string | null }>(
      `/projects/${encodeURIComponent(projectId)}/cards${qs ? `?${qs}` : ""}`,
    );
  },

  createCard(
    projectId: string,
    input: {
      title: string;
      body?: string;
      priority?: number;
      criteria?: AcceptanceRule[];
      deadline_at?: string;
    },
  ): Promise<{ card: Card }> {
    return request<{ card: Card }>(`/projects/${encodeURIComponent(projectId)}/cards`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  getCardDetail(cardId: string): Promise<{ card: Card; events: CardEvent[] }> {
    return request<{ card: Card; events: CardEvent[] }>(
      `/cards/${encodeURIComponent(cardId)}`,
    );
  },

  getCardNegotiation(cardId: string): Promise<CardNegotiation> {
    return request<CardNegotiation>(
      `/cards/${encodeURIComponent(cardId)}/negotiation`,
    );
  },

  commitCard(
    cardId: string,
    input: {
      message_id: string;
      session_id?: string;
      proposal_id?: string;
      terms_hash: string;
    },
  ): Promise<{ card: Card; contract_id: string } & WriteReceipt> {
    return request<{ card: Card; contract_id: string } & WriteReceipt>(
      `/cards/${encodeURIComponent(cardId)}/commit`,
      { method: "POST", body: JSON.stringify(input) },
    );
  },

  verifyCard(
    cardId: string,
    input: {
      message_id?: string;
      verdict: "pass" | "reject" | "needs_more";
      reasons?: Array<{ key?: string; message: string; pass?: boolean }>;
      score?: number;
      rule_version?: string;
    },
  ): Promise<{ card: Card } & WriteReceipt> {
    return request<{ card: Card } & WriteReceipt>(
      `/cards/${encodeURIComponent(cardId)}/verify`,
      { method: "POST", body: JSON.stringify(input) },
    );
  },

  interveneCard(
    cardId: string,
    input: {
      message_id?: string;
      type: "reject" | "redirect" | "takeover" | "pause" | "resume";
      reason: string;
      payload?: {
        criteria?: unknown[];
        priority?: number;
        deadline_at?: string | null;
      };
    },
  ): Promise<{ card: Card; intervention_id: string } & WriteReceipt> {
    return request<{ card: Card; intervention_id: string } & WriteReceipt>(
      `/cards/${encodeURIComponent(cardId)}/intervene`,
      { method: "POST", body: JSON.stringify(input) },
    );
  },

  adminActionCard(
    cardId: string,
    version: number,
    input:
      | {
          action: "engage";
          message_id?: string;
          reason: string;
          assignee_agent_id?: string;
        }
      | {
          action: "verify";
          message_id?: string;
          reason: string;
          verdict: "pass" | "reject";
          reasons?: Array<{ key?: string; message: string; pass?: boolean }>;
          score?: number;
          rule_version?: string;
        }
      | {
          action: "cancel" | "release" | "reset";
          message_id?: string;
          reason: string;
        },
  ): Promise<
    {
      card: Card;
      level: "project_owner" | "project_admin" | "instance_admin";
      action: "engage" | "verify" | "cancel" | "release" | "reset";
      admin_action: {
        level: "project_owner" | "project_admin" | "instance_admin";
        action: "engage" | "verify" | "cancel" | "release" | "reset";
        reason: string;
        skipped_gates: string[];
      };
      session_id?: string;
      proposal_id?: string;
      contract_id?: string;
      verdict?: "pass" | "reject";
      outcome?: string;
      evidence_count?: number;
      attempts_abandoned?: number;
      was_paused?: boolean;
      round?: number;
    } & WriteReceipt
  > {
    return request(
      `/cards/${encodeURIComponent(cardId)}/admin-action`,
      { method: "POST", ifMatch: String(version), body: JSON.stringify(input) },
    );
  },

  updateProject(
    projectId: string,
    input: {
      name?: string;
      verification_mode?: "human" | "rule";
      exec_targets?: Array<{
        provider: "github_actions";
        owner: string;
        repo: string;
        workflows: string[];
      }>;
    },
  ): Promise<{ project: Project }> {
    return request<{ project: Project }>(
      `/projects/${encodeURIComponent(projectId)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
  },

  patchCard(
    cardId: string,
    version: number,
    input: {
      title?: string;
      body?: string | null;
      priority?: number;
      deadline_at?: string | null;
    },
  ): Promise<{ card: Card } & WriteReceipt> {
    return request<{ card: Card } & WriteReceipt>(`/cards/${encodeURIComponent(cardId)}`, {
      method: "PATCH",
      ifMatch: String(version),
      body: JSON.stringify(input),
    });
  },

  closeCard(
    cardId: string,
    version: number,
    reason: string,
  ): Promise<{ card: Card } & WriteReceipt> {
    return request<{ card: Card } & WriteReceipt>(
      `/cards/${encodeURIComponent(cardId)}/close`,
      {
        method: "POST",
        ifMatch: String(version),
        body: JSON.stringify({ reason }),
      },
    );
  },

  reopenCard(
    cardId: string,
    version: number,
    reason?: string,
  ): Promise<{ card: Card } & WriteReceipt> {
    const body = reason && reason.trim() ? { reason: reason.trim() } : {};
    return request<{ card: Card } & WriteReceipt>(
      `/cards/${encodeURIComponent(cardId)}/reopen`,
      {
        method: "POST",
        ifMatch: String(version),
        body: JSON.stringify(body),
      },
    );
  },

  getProjectMembers(projectId: string): Promise<{ members: ProjectMember[] }> {
    return request<{ members: ProjectMember[] }>(
      `/projects/${encodeURIComponent(projectId)}/members`,
    );
  },

  addProjectMember(
    projectId: string,
    input: { email: string; role?: "admin" | "member" },
  ): Promise<{ member: ProjectMember }> {
    return request<{ member: ProjectMember }>(
      `/projects/${encodeURIComponent(projectId)}/members`,
      { method: "POST", body: JSON.stringify(input) },
    );
  },

  updateProjectMemberRole(
    projectId: string,
    userId: string,
    role: "owner" | "admin" | "member",
  ): Promise<{ member: ProjectMember }> {
    return request<{ member: ProjectMember }>(
      `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
      { method: "PATCH", body: JSON.stringify({ role }) },
    );
  },

  transferProjectOwner(
    projectId: string,
    userId: string,
  ): Promise<{ owner: ProjectMember; previous_owner_id: string | null }> {
    return request<{ owner: ProjectMember; previous_owner_id: string | null }>(
      `/projects/${encodeURIComponent(projectId)}/owner`,
      { method: "POST", body: JSON.stringify({ user_id: userId }) },
    );
  },

  removeProjectMember(
    projectId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    return request<{ ok: true }>(
      `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
  },

  requestProjectJoin(
    projectId: string,
    note?: string,
  ): Promise<{ join_request: ProjectJoinRequest }> {
    return request<{ join_request: ProjectJoinRequest }>(
      `/projects/${encodeURIComponent(projectId)}/join-requests`,
      {
        method: "POST",
        body: JSON.stringify(note?.trim() ? { note: note.trim() } : {}),
      },
    );
  },

  getMyJoinRequests(): Promise<{ join_requests: MyProjectJoinRequest[] }> {
    return request<{ join_requests: MyProjectJoinRequest[] }>("/join-requests");
  },

  getProjectJoinRequests(
    projectId: string,
  ): Promise<{ join_requests: ProjectJoinRequestWithUser[] }> {
    return request<{ join_requests: ProjectJoinRequestWithUser[] }>(
      `/projects/${encodeURIComponent(projectId)}/join-requests`,
    );
  },

  decideProjectJoinRequest(
    projectId: string,
    userId: string,
    status: "approved" | "rejected",
  ): Promise<{ join_request: ProjectJoinRequest }> {
    return request<{ join_request: ProjectJoinRequest }>(
      `/projects/${encodeURIComponent(projectId)}/join-requests/${encodeURIComponent(userId)}`,
      { method: "PATCH", body: JSON.stringify({ status }) },
    );
  },

  getProjectAgents(projectId: string): Promise<{ agents: AgentSummary[] }> {
    return request<{ agents: AgentSummary[] }>(
      `/projects/${encodeURIComponent(projectId)}/agents`,
    );
  },

  setAgentStatus(
    projectId: string,
    agentId: string,
    status: "active" | "disabled",
  ): Promise<{ agent: AgentSummary }> {
    return request<{ agent: AgentSummary }>(
      `/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}/status`,
      {
        method: "POST",
        body: JSON.stringify({ status }),
      },
    );
  },

  getArchivedProjects(): Promise<{ projects: ArchivedProject[] }> {
    return request<{ projects: ArchivedProject[] }>("/projects/archived");
  },

  archiveProject(
    projectId: string,
    confirmSlug: string,
    reason?: string,
  ): Promise<{ project: Project; original_slug: string }> {
    return request<{ project: Project; original_slug: string }>(
      `/projects/${encodeURIComponent(projectId)}/archive`,
      {
        method: "POST",
        body: JSON.stringify({
          confirm_slug: confirmSlug,
          ...(reason?.trim() ? { reason: reason.trim() } : {}),
        }),
      },
    );
  },

  restoreProject(projectId: string): Promise<{ project: Project }> {
    return request<{ project: Project }>(
      `/projects/${encodeURIComponent(projectId)}/restore`,
      { method: "POST" },
    );
  },

  purgeProject(
    projectId: string,
    confirmSlug: string,
  ): Promise<{ ok: true; events_purged: boolean }> {
    return request<{ ok: true; events_purged: boolean }>(
      `/projects/${encodeURIComponent(projectId)}`,
      {
        method: "DELETE",
        body: JSON.stringify({ confirm_slug: confirmSlug }),
      },
    );
  },

  getAdminOverview(): Promise<AdminOverviewResponse> {
    return request<AdminOverviewResponse>("/admin/overview");
  },

  getUsers(params?: {
    status?: "active" | "disabled";
    role?: "admin" | "member";
    q?: string;
  }): Promise<{ users: UserProfile[] }> {
    const search = new URLSearchParams();
    if (params?.status) search.set("status", params.status);
    if (params?.role) search.set("role", params.role);
    if (params?.q?.trim()) search.set("q", params.q.trim());
    const qs = search.toString();
    return request<{ users: UserProfile[] }>(`/users${qs ? `?${qs}` : ""}`);
  },

  getUserDetail(uid: string): Promise<AdminUserDetailResponse> {
    return request<AdminUserDetailResponse>(`/users/${encodeURIComponent(uid)}`);
  },

  getUserAuthEvents(
    uid: string,
  ): Promise<{ email: string; events: UserAuthEvent[] }> {
    return request<{ email: string; events: UserAuthEvent[] }>(
      `/users/${encodeURIComponent(uid)}/auth-events`,
    );
  },

  createUser(input: {
    email: string;
    display_name?: string;
    password: string;
    role: "admin" | "member";
  }): Promise<{ user: UserProfile }> {
    return request<{ user: UserProfile }>("/users", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  inviteUser(input: {
    email: string;
    display_name?: string;
    role: "admin" | "member";
    send_email: boolean;
  }): Promise<{
    user: UserProfile;
    temporary_password: string;
    email: EmailSendResult | null;
  }> {
    return request<{
      user: UserProfile;
      temporary_password: string;
      email: EmailSendResult | null;
    }>("/users/invite", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  resendUserInvite(uid: string): Promise<{
    user: UserProfile;
    temporary_password: string;
    email: EmailSendResult;
  }> {
    return request<{
      user: UserProfile;
      temporary_password: string;
      email: EmailSendResult;
    }>(`/users/${encodeURIComponent(uid)}/invite`, {
      method: "POST",
    });
  },

  updateUser(
    uid: string,
    input: {
      display_name?: string | null;
      role?: "admin" | "member";
      status?: "active" | "disabled";
    },
  ): Promise<{ user: UserProfile }> {
    return request<{ user: UserProfile }>(`/users/${encodeURIComponent(uid)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },

  softDeleteUser(uid: string): Promise<{ ok: true; soft_deleted: boolean }> {
    return request<{ ok: true; soft_deleted: boolean }>(
      `/users/${encodeURIComponent(uid)}`,
      {
        method: "DELETE",
      },
    );
  },

  revokeUserSessions(uid: string): Promise<{ ok: true }> {
    return request<{ ok: true }>(
      `/users/${encodeURIComponent(uid)}/revoke-sessions`,
      {
        method: "POST",
      },
    );
  },

  resetUserPassword(
    uid: string,
    input: {
      password: string;
      must_change_password: boolean;
      send_email: boolean;
    },
  ): Promise<{
    ok: true;
    user: UserProfile;
    email: EmailSendResult | null;
  }> {
    return request<{
      ok: true;
      user: UserProfile;
      email: EmailSendResult | null;
    }>(`/users/${encodeURIComponent(uid)}/password`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  getAdminEmailStatus(): Promise<AdminEmailStatusResponse> {
    return request<AdminEmailStatusResponse>("/admin/email/status");
  },

  sendAdminTestEmail(to?: string): Promise<{ to: string } & EmailSendResult> {
    return request<{ to: string } & EmailSendResult>("/admin/email/test", {
      method: "POST",
      body: JSON.stringify(to?.trim() ? { to: to.trim() } : {}),
    });
  },

  getAdminEmailLog(params?: {
    status?: "sent" | "failed" | "skipped";
    limit?: number;
  }): Promise<{ emails: EmailLogEntry[] }> {
    const search = new URLSearchParams();
    if (params?.status) search.set("status", params.status);
    if (params?.limit !== undefined) search.set("limit", String(params.limit));
    const qs = search.toString();
    return request<{ emails: EmailLogEntry[] }>(
      `/admin/email/log${qs ? `?${qs}` : ""}`,
    );
  },
};

const VALID_OPS: ReadonlySet<AcceptanceOp> = new Set([
  "eq",
  "gte",
  "lte",
  "matches",
  "exists",
]);

function parseRuleValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (!Number.isNaN(num)) return num;
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * 解析多行文本为 AcceptanceRule[]
 * 每行格式：`key op [value] [block|warn]`，例如：`row_count eq 30000` 或 `summary exists`
 */
export function parseAcceptanceRulesText(text: string): {
  rules: AcceptanceRule[];
  errors: string[];
} {
  const rules: AcceptanceRule[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;

    const match = line.match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/);
    if (!match) {
      errors.push(`第 ${idx + 1} 行格式错误：应为 "key op value"`);
      return;
    }

    const key = match[1];
    const opCandidate = match[2] as AcceptanceOp;
    const rest = (match[3] ?? "").trim();

    if (!VALID_OPS.has(opCandidate)) {
      errors.push(
        `第 ${idx + 1} 行不支持的操作符 "${match[2]}"（支持 eq / gte / lte / matches / exists）`,
      );
      return;
    }

    let severity: "block" | "warn" | undefined;
    let valuePart = rest;

    const severityMatch = valuePart.match(/^(.*?)\s+\[(block|warn)\]$/i);
    if (severityMatch) {
      valuePart = severityMatch[1].trim();
      severity = severityMatch[2].toLowerCase() as "block" | "warn";
    }

    if (opCandidate === "exists") {
      if (valuePart === "block" || valuePart === "warn") {
        severity = valuePart;
        valuePart = "";
      }
      const rule: AcceptanceRule = { key, op: "exists" };
      if (valuePart) {
        rule.value = parseRuleValue(valuePart);
      }
      if (severity) {
        rule.severity = severity;
      }
      rules.push(rule);
      return;
    }

    if (!valuePart) {
      errors.push(`第 ${idx + 1} 行操作符 "${opCandidate}" 需要提供比较值`);
      return;
    }

    const rule: AcceptanceRule = {
      key,
      op: opCandidate,
      value: parseRuleValue(valuePart),
    };
    if (severity) {
      rule.severity = severity;
    }
    rules.push(rule);
  });

  return { rules, errors };
}

export function safeParseCriteriaJson(criteriaJson: string | null): AcceptanceRule[] {
  if (!criteriaJson) return [];
  try {
    const parsed = JSON.parse(criteriaJson);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item): item is AcceptanceRule =>
          Boolean(item && typeof item === "object" && typeof item.key === "string" && typeof item.op === "string"),
      );
    }
    return [];
  } catch {
    return [];
  }
}

export function sortCardsForColumn(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    const timeB = Date.parse(b.updated_at) || 0;
    const timeA = Date.parse(a.updated_at) || 0;
    if (timeB !== timeA) {
      return timeB - timeA;
    }
    return b.id.localeCompare(a.id);
  });
}
