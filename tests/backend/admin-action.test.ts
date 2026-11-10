import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../src/context";
import type { CardRow, Env } from "../../src/types";
import { cardRoutes } from "../../src/routes/cards";
import { projectRoutes } from "../../src/routes/projects";
import { agentApiRoutes } from "../../src/routes/agent-api";
import { publishOutboxEvent, reconcileEvents, type OutboxRow } from "../../src/lib/event-store";
import { formatAgentToken } from "../../src/lib/tokens";
import { tokenHash } from "../../src/lib/crypto";
import { HttpError } from "../../src/lib/http-error";
import { builtin, SqliteD1 } from "../helpers/sqlite-d1";

const { readFileSync, readdirSync } = builtin<{
  readFileSync(path: URL, encoding: string): string;
  readdirSync(path: URL): string[];
}>("node:fs");

const P = "prj_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OWNER = "u_owner";
const MEMBER = "u_member";
const PROJECT_ADMIN = "u_padmin";
const ADMIN = "u_admin";
const OWNER_EMAIL = "owner@example.test";
const MEMBER_EMAIL = "member@example.test";
const PROJECT_ADMIN_EMAIL = "padmin@example.test";
const ADMIN_EMAIL = "admin@example.test";
const BOT = `${P}:bot`;
const PEER = `${P}:peer`;
const BOT_AGENT_ID = "ag_bot";
const PEER_AGENT_ID = "ag_peer";
const BOT_SECRET = "bot-test-secret";

interface ApiBody {
  card?: CardRow;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  level?: string;
  action?: string;
  outcome?: string;
  evidence_count?: number;
  attempts_abandoned?: number;
  was_paused?: boolean;
  round?: number;
  contract_state?: string;
  member?: { id: string; role: string };
  owner?: { id: string; role: string };
  previous_owner_id?: string | null;
  admin_action?: { level: string; action: string; reason: string; skipped_gates: string[] };
  session_id?: string;
  proposal_id?: string;
  contract_id?: string;
  terms_hash?: string;
  ticket_id?: string;
  seq?: number | null;
  event_id?: string;
  event_pending?: boolean;
  duplicate?: boolean;
}

const databases: SqliteD1[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) db.sqlite.close();
});

async function fixture() {
  const db = new SqliteD1();
  databases.push(db);
  const migrations = new URL("../../migrations/", (import.meta as ImportMeta & { url: string }).url);
  for (const name of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort()) {
    db.sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  db.sqlite.exec(`
    INSERT INTO users(id,email,role) VALUES
      ('${OWNER}','${OWNER_EMAIL}','member'),
      ('${MEMBER}','${MEMBER_EMAIL}','member'),
      ('${PROJECT_ADMIN}','${PROJECT_ADMIN_EMAIL}','member'),
      ('${ADMIN}','${ADMIN_EMAIL}','admin');
    INSERT INTO projects(id,slug,name,created_by,exec_targets_json) VALUES
      ('${P}','admin-action','Admin Action','${OWNER}',
       '[{"provider":"github_actions","owner":"acme","repo":"demo","workflows":["ci.yml"]}]');
    INSERT INTO project_members(project_id,user_id,role,added_by) VALUES
      ('${P}','${OWNER}','owner','${OWNER}'),
      ('${P}','${MEMBER}','member','${OWNER}'),
      ('${P}','${PROJECT_ADMIN}','admin','${OWNER}');
    INSERT INTO agents(id,slug) VALUES ('${BOT_AGENT_ID}','bot'),('${PEER_AGENT_ID}','peer');
    INSERT INTO agent_projects(agent_id,project_id,status,local_slug) VALUES
      ('${BOT_AGENT_ID}','${P}','active','bot'),
      ('${PEER_AGENT_ID}','${P}','active','peer');
  `);
  const botHash = await tokenHash(BOT_SECRET, "test-pepper");
  db.sqlite.prepare(
    `INSERT INTO agent_tokens(id,agent_id,project_id,prefix,hash,version,expires_at)
     VALUES('t_bot',?,?,'test',?,1,'2099-01-01T00:00:00.000Z')`,
  ).run(BOT_AGENT_ID, P, botHash);

  const board = {
    async publish(eventId: string): Promise<{ seq: number }> {
      const row = await db.prepare("SELECT * FROM event_outbox WHERE event_id = ?1").bind(eventId).first<OutboxRow>();
      if (!row) throw new Error("missing outbox receipt");
      let head = await reconcileEvents(db.asD1(), row.project_id);
      const pending = await db.prepare(
        `SELECT * FROM event_outbox
          WHERE project_id = ?1 AND published_seq IS NULL AND order_id <= ?2
          ORDER BY order_id`,
      ).bind(row.project_id, row.order_id).all<OutboxRow>();
      for (const earlier of pending.results) {
        head = await publishOutboxEvent(db.asD1(), earlier, head);
      }
      return { seq: head.seq };
    },
    async closeConnections() {},
    async purgeProject() {},
  };
  const env = {
    DB: db.asD1(),
    TOKEN_PEPPER: "test-pepper",
    GITHUB_TOKEN: "fake-no-network",
    ENVIRONMENT: "development",
    ADMIN_EMAILS: ADMIN_EMAIL,
    BOARD_DO: { getByName: () => board },
  } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.onError((error, c) =>
    c.json(
      { error: { code: error instanceof HttpError ? error.code : "INTERNAL", message: error.message } },
      (error instanceof HttpError ? error.status : 500) as 500,
    ),
  );
  app.route("/api/v1", cardRoutes);
  app.route("/api/v1", projectRoutes);
  app.route("/agent", agentApiRoutes);

  async function human(
    path: string,
    body: unknown = {},
    email = OWNER_EMAIL,
    method = "POST",
    ifMatch?: number,
  ): Promise<{ status: number; body: ApiBody }> {
    const headers: Record<string, string> = { "Content-Type": "application/json", "X-Dev-Email": email };
    if (ifMatch !== undefined) headers["If-Match"] = String(ifMatch);
    const response = await app.fetch(
      new Request(`http://local${path}`, {
        method,
        headers,
        body: method === "GET" ? undefined : JSON.stringify(body),
      }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    return { status: response.status, body: (await response.json()) as ApiBody };
  }

  async function agentCall(
    path: string,
    body: unknown = {},
  ): Promise<{ status: number; body: ApiBody }> {
    const response = await app.fetch(
      new Request(`http://local${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${formatAgentToken(BOT, BOT_SECRET)}`,
        },
        body: JSON.stringify(body),
      }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    return { status: response.status, body: (await response.json()) as ApiBody };
  }

  /**
   * Admin-action call with the card's CURRENT version as If-Match, mirroring
   * what the drawer does after refreshing. Optionally pin a stale version to
   * exercise the precondition path.
   */
  async function adminCall(
    path: string,
    body: unknown,
    email: string = OWNER_EMAIL,
    staleVersion?: number,
  ): Promise<{ status: number; body: ApiBody }> {
    const cardId = path.split("/")[4] ?? "";
    const row = cardId
      ? await db.prepare("SELECT version FROM cards WHERE id = ?1").bind(cardId).first<{ version: number }>()
      : null;
    const version = staleVersion ?? row?.version ?? 1;
    return human(path, body, email, "POST", version);
  }

  let cardSeq = 0;
  async function createCard(email = OWNER_EMAIL): Promise<string> {
    const response = await human(`/api/v1/projects/${P}/cards`, { title: `card-${++cardSeq}` }, email);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.card!.id;
  }

  function insertCard(input: {
    id: string;
    status: "open" | "engaged" | "running" | "review" | "closed";
    createdByType?: "user" | "agent";
    createdById?: string;
    requesterAgentId?: string | null;
    assigneeAgentId?: string | null;
    pausedAt?: string | null;
    round?: number;
    leaseOwner?: string | null;
  }): void {
    db.sqlite.prepare(
      `INSERT INTO cards
         (id, project_id, title, status, outcome, version, round, requester_agent_id,
          assignee_agent_id, criteria_json, paused_at, lease_owner, created_by_type, created_by_id)
       VALUES (?1, ?2, 'seeded', ?3, NULL, 1, ?4, ?5, ?6, '[]', ?7, ?8, ?9, ?10)`,
    ).run(
      input.id,
      P,
      input.status,
      input.round ?? 1,
      input.requesterAgentId ?? null,
      input.assigneeAgentId ?? null,
      input.pausedAt ?? null,
      input.leaseOwner ?? null,
      input.createdByType ?? "user",
      input.createdById ?? OWNER,
    );
  }

  function seedAttempt(
    cardId: string,
    contractId: string,
    status: "issued" | "running" = "issued",
  ): string {
    const id = `at_${cardId}`;
    db.sqlite.prepare(
      `INSERT INTO attempts
         (id, card_id, contract_id, agent_id, attempt_no, status, ticket_nonce)
       VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)`,
    ).run(id, cardId, contractId, BOT_AGENT_ID, status, `nonce_${cardId}`);
    return id;
  }

  function seedSession(cardId: string, state: "open" | "committed" = "committed"): string {
    const id = `ns_${cardId}`;
    db.sqlite.prepare(
      `INSERT INTO negotiation_sessions
         (id, card_id, initiator_agent_id, initiator_user_id, responder_agent_id, round, state, closed_at)
       VALUES (?1, ?2, NULL, ?3, ?4, 1, ?5, ?6)`,
    ).run(id, cardId, OWNER, BOT_AGENT_ID, state, state === "committed" ? "2026-01-01T00:00:00.000Z" : null);
    return id;
  }

  function seedEvidence(cardId: string): void {
    db.sqlite.prepare(
      `INSERT INTO evidence(id, card_id, kind, sha256, size_bytes, produced_by)
       VALUES (?1, ?2, 'artifact', ?3, 10, ?4)`,
    ).run(`ev_${cardId}`, cardId, "a".repeat(64), BOT_AGENT_ID);
  }

  function seedContract(
    cardId: string,
    input: { proposerAgentId?: string | null; proposerUserId?: string | null; acceptorUserId: string },
  ): string {
    const sessionId = seedSession(cardId);
    const id = `ct_${cardId}`;
    db.sqlite.prepare(
      `INSERT INTO contracts
         (id, card_id, session_id, proposer_agent_id, proposer_user_id, acceptor_agent_id,
          acceptor_user_id, terms_json, terms_hash, acceptance_proof_json, state, version)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, '{}', 'sha256:test', '{}', 'active', 1)`,
    ).run(
      id,
      cardId,
      sessionId,
      input.proposerAgentId ?? null,
      input.proposerUserId ?? null,
      input.acceptorUserId,
    );
    return id;
  }

  function seedReviewCard(input: {
    id: string;
    proposerAgentId?: string | null;
    proposerUserId?: string | null;
    evidence?: boolean;
  }): string {
    insertCard({ id: input.id, status: "review", assigneeAgentId: BOT_AGENT_ID });
    const contractId = seedContract(input.id, {
      proposerAgentId: input.proposerAgentId,
      proposerUserId: input.proposerUserId,
      acceptorUserId: OWNER,
    });
    if (input.evidence) seedEvidence(input.id);
    return contractId;
  }

  return {
    db,
    call: human,
    adminCall,
    human,
    agentCall,
    createCard,
    insertCard,
    seedSession,
    seedContract,
    seedReviewCard,
    seedAttempt,
  };
}

describe("admin action", () => {
  it("lets a project owner engage an open card without a proposal and issue a ticket", async () => {
    const f = await fixture();
    const cid = await f.createCard();

    const response = await f.adminCall(`/api/v1/cards/${cid}/admin-action`, {
      action: "engage",
      reason: "no online peer to propose",
      assignee_agent_id: BOT,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.level).toBe("project_owner");
    expect(response.body.admin_action?.skipped_gates).toEqual(["proposal", "agent_acceptance"]);
    expect(response.body.card?.status).toBe("engaged");
    expect(response.body.card?.assignee_agent_id).toBe(BOT_AGENT_ID);

    const session = f.db.sqlite.prepare("SELECT * FROM negotiation_sessions WHERE card_id = ?").get(cid) as Record<string, unknown>;
    expect(session).toMatchObject({ initiator_user_id: OWNER, responder_agent_id: BOT_AGENT_ID, state: "committed" });
    const proposal = f.db.sqlite.prepare("SELECT * FROM proposals WHERE session_id = ?").get(session.id as string) as Record<string, unknown>;
    expect(proposal).toMatchObject({ from_agent_id: BOT_AGENT_ID, status: "accepted" });
    const contract = f.db.sqlite.prepare("SELECT * FROM contracts WHERE card_id = ?").get(cid) as Record<string, unknown>;
    expect(contract).toMatchObject({
      proposer_agent_id: BOT_AGENT_ID,
      acceptor_user_id: OWNER,
      state: "active",
    });

    const event = f.db.sqlite.prepare(
      "SELECT event_type, payload_json FROM card_events WHERE card_id = ? ORDER BY seq DESC LIMIT 1",
    ).get(cid) as Record<string, unknown>;
    expect(event.event_type).toBe("card.admin_action");
    const payload = JSON.parse(event.payload_json as string) as Record<string, unknown>;
    expect(payload).toMatchObject({
      action: "engage",
      level: "project_owner",
      synthetic: true,
      from: "open",
      to: "engaged",
      session_id: response.body.session_id,
      contract_id: response.body.contract_id,
    });
    expect(payload.skipped_gates).toEqual(["proposal", "agent_acceptance"]);

    const audit = f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE card_id = ?").get(cid) as { count: number };
    expect(audit.count).toBeGreaterThan(0);

    const ticket = await f.agentCall(`/agent/cards/${cid}/tickets`, {});
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
    expect(ticket.body.ticket_id).toBeTruthy();
  });

  it("denies a plain project member", async () => {
    const f = await fixture();
    const cid = await f.createCard();
    const response = await f.adminCall(`/api/v1/cards/${cid}/admin-action`,
      { action: "engage", reason: "member should not pass", assignee_agent_id: BOT },
      MEMBER_EMAIL,
    );
    expect(response.status).toBe(403);
    expect(response.body.error?.code).toBe("ADMIN_PRIVILEGED_FORBIDDEN");
  });

  it("lets a project admin act without being an instance admin", async () => {
    const f = await fixture();
    const cid = await f.createCard();
    const response = await f.adminCall(`/api/v1/cards/${cid}/admin-action`,
      { action: "engage", reason: "project admin governance", assignee_agent_id: BOT },
      PROJECT_ADMIN_EMAIL,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.level).toBe("project_admin");
    expect(response.body.card?.status).toBe("engaged");
  });

  it("does not let a project admin manage project members", async () => {
    const f = await fixture();
    const response = await f.call(
      `/api/v1/projects/${P}/members/${MEMBER}`,
      { role: "admin" },
      PROJECT_ADMIN_EMAIL,
      "PATCH",
    );
    expect(response.status).toBe(403);
  });

  it("lets the owner grant and revoke the project admin role", async () => {
    const f = await fixture();
    const granted = await f.call(
      `/api/v1/projects/${P}/members/${MEMBER}`,
      { role: "admin" },
      OWNER_EMAIL,
      "PATCH",
    );
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    expect(granted.body.member?.role).toBe("admin");

    const revoked = await f.call(
      `/api/v1/projects/${P}/members/${MEMBER}`,
      { role: "member" },
      OWNER_EMAIL,
      "PATCH",
    );
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body.member?.role).toBe("member");
  });

  it("lets the owner transfer ownership to a project admin", async () => {
    const f = await fixture();
    const response = await f.call(
      `/api/v1/projects/${P}/owner`,
      { user_id: PROJECT_ADMIN },
      OWNER_EMAIL,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.owner?.role).toBe("owner");
    expect(response.body.previous_owner_id).toBe(OWNER);
    const previous = f.db.sqlite
      .prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?")
      .get(P, OWNER) as { role: string };
    expect(previous.role).toBe("member");
  });

  it("lets an instance admin act on a project without membership", async () => {
    const f = await fixture();
    const cid = await f.createCard();
    const response = await f.adminCall(`/api/v1/cards/${cid}/admin-action`,
      { action: "engage", reason: "instance-wide governance", assignee_agent_id: BOT },
      ADMIN_EMAIL,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.level).toBe("instance_admin");
    expect(response.body.card?.status).toBe("engaged");
  });

  it("refuses to engage over an open negotiation session", async () => {
    const f = await fixture();
    const cid = await f.createCard();
    f.seedSession(cid, "open");
    const response = await f.adminCall(`/api/v1/cards/${cid}/admin-action`, {
      action: "engage",
      reason: "should use normal commit",
      assignee_agent_id: BOT,
    });
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe("NEGOTIATION_OPEN");
  });

  it("refuses to engage the agent that created the card", async () => {
    const f = await fixture();
    f.insertCard({
      id: "c_agent_owned",
      status: "open",
      createdByType: "agent",
      createdById: BOT_AGENT_ID,
      requesterAgentId: BOT_AGENT_ID,
    });
    const response = await f.adminCall("/api/v1/cards/c_agent_owned/admin-action", {
      action: "engage",
      reason: "self assignment must be blocked",
      assignee_agent_id: BOT,
    });
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe("SELF_ASSIGNMENT");
  });

  it("closes a review card with zero evidence and records the skipped gate", async () => {
    const f = await fixture();
    const contractId = f.seedReviewCard({ id: "c_no_evidence", proposerAgentId: BOT_AGENT_ID });
    const response = await f.adminCall("/api/v1/cards/c_no_evidence/admin-action", {
      action: "verify",
      reason: "CI green but artifacts were omitted",
      verdict: "pass",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.outcome).toBe("done");
    expect(response.body.evidence_count).toBe(0);
    expect(response.body.admin_action?.skipped_gates).toEqual(["evidence_required"]);
    expect(response.body.card?.status).toBe("closed");
    expect(response.body.card?.outcome).toBe("done");

    const contract = f.db.sqlite.prepare("SELECT state FROM contracts WHERE id = ?").get(contractId) as { state: string };
    expect(contract.state).toBe("fulfilled");
    const event = f.db.sqlite.prepare(
      "SELECT payload_json FROM card_events WHERE card_id = ? ORDER BY seq DESC LIMIT 1",
    ).get("c_no_evidence") as { payload_json: string };
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    expect(payload).toMatchObject({
      action: "verify",
      outcome: "done",
      evidence_count: 0,
      skipped_gates: ["evidence_required"],
    });
  });

  it("records a proposer-verifier conflict skip even with evidence", async () => {
    const f = await fixture();
    f.seedReviewCard({
      id: "c_conflict",
      proposerUserId: OWNER,
      evidence: true,
    });
    const response = await f.adminCall("/api/v1/cards/c_conflict/admin-action", {
      action: "verify",
      reason: "owner is the only available verifier",
      verdict: "pass",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.admin_action?.skipped_gates).toEqual(["verifier_conflict"]);
    const event = f.db.sqlite.prepare(
      "SELECT payload_json FROM card_events WHERE card_id = ? ORDER BY seq DESC LIMIT 1",
    ).get("c_conflict") as { payload_json: string };
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    expect(payload.verifier_conflict).toBe("PROPOSER_IS_VERIFIER");
  });

  it("records an admin rejection and breaches the active contract", async () => {
    const f = await fixture();
    const contractId = f.seedReviewCard({
      id: "c_reject",
      proposerAgentId: BOT_AGENT_ID,
      evidence: true,
    });
    const response = await f.adminCall("/api/v1/cards/c_reject/admin-action", {
      action: "verify",
      reason: "evidence does not match the delivered scope",
      verdict: "reject",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.outcome).toBe("rejected");
    expect(response.body.admin_action?.skipped_gates).toEqual([]);
    const contract = f.db.sqlite.prepare("SELECT state FROM contracts WHERE id = ?").get(contractId) as { state: string };
    expect(contract.state).toBe("breached");
  });

  it("rejects a paused card and the wrong state", async () => {
    const f = await fixture();
    f.insertCard({ id: "c_paused", status: "open", pausedAt: "2026-01-01T00:00:00.000Z" });
    const paused = await f.adminCall("/api/v1/cards/c_paused/admin-action", {
      action: "engage",
      reason: "paused cards stay paused",
      assignee_agent_id: BOT,
    });
    expect(paused.status).toBe(409);
    expect(paused.body.error?.code).toBe("CARD_PAUSED");

    const cid = await f.createCard();
    const wrongState = await f.adminCall(`/api/v1/cards/${cid}/admin-action`, {
      action: "verify",
      reason: "open card cannot be verified",
      verdict: "pass",
    });
    expect(wrongState.status).toBe(409);
    expect(wrongState.body.error?.code).toBe("ADMIN_ACTION_STATE");
  });

  it("deduplicates a repeated message_id without creating a second contract", async () => {
    const f = await fixture();
    const cid = await f.createCard();
    const body = {
      action: "engage",
      message_id: "admin-action-message-1",
      reason: "idempotent governance action",
      assignee_agent_id: BOT,
    };
    const first = await f.adminCall(`/api/v1/cards/${cid}/admin-action`, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await f.adminCall(`/api/v1/cards/${cid}/admin-action`, body);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    const contracts = f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM contracts WHERE card_id = ?").get(cid) as { count: number };
    expect(contracts.count).toBe(1);
  });

  it("cancels a paused running card and abandons its ticket", async () => {
    const f = await fixture();
    f.insertCard({
      id: "c_cancel",
      status: "running",
      assigneeAgentId: BOT_AGENT_ID,
      pausedAt: "2026-01-01T00:00:00.000Z",
      leaseOwner: BOT_AGENT_ID,
    });
    const contractId = f.seedContract("c_cancel", {
      proposerAgentId: BOT_AGENT_ID,
      acceptorUserId: OWNER,
    });
    f.seedAttempt("c_cancel", contractId, "running");

    const response = await f.adminCall("/api/v1/cards/c_cancel/admin-action", {
      action: "cancel",
      reason: "abusive card; emergency stop",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.outcome).toBe("cancelled");
    expect(response.body.attempts_abandoned).toBe(1);
    expect(response.body.was_paused).toBe(true);
    expect(response.body.contract_id).toBe(contractId);
    expect(response.body.card?.status).toBe("closed");
    expect(response.body.card?.outcome).toBe("cancelled");

    const card = f.db.sqlite.prepare(
      "SELECT paused_at, lease_owner FROM cards WHERE id = 'c_cancel'",
    ).get() as { paused_at: string | null; lease_owner: string | null };
    expect(card.paused_at).toBeNull();
    expect(card.lease_owner).toBeNull();
    const attempt = f.db.sqlite.prepare(
      "SELECT status FROM attempts WHERE id = 'at_c_cancel'",
    ).get() as { status: string };
    expect(attempt.status).toBe("abandoned");
    const contract = f.db.sqlite.prepare(
      "SELECT state FROM contracts WHERE id = ?",
    ).get(contractId) as { state: string };
    expect(contract.state).toBe("superseded");

    const event = f.db.sqlite.prepare(
      "SELECT payload_json FROM card_events WHERE card_id = 'c_cancel' ORDER BY seq DESC LIMIT 1",
    ).get() as { payload_json: string };
    expect(JSON.parse(event.payload_json)).toMatchObject({
      action: "cancel",
      from: "running",
      to: "closed",
      outcome: "cancelled",
      attempts_abandoned: 1,
      was_paused: true,
    });
  });

  it("releases a stuck running card back to engaged and abandons the attempt", async () => {
    const f = await fixture();
    f.insertCard({
      id: "c_release",
      status: "running",
      assigneeAgentId: BOT_AGENT_ID,
      leaseOwner: BOT_AGENT_ID,
    });
    const contractId = f.seedContract("c_release", {
      proposerAgentId: BOT_AGENT_ID,
      acceptorUserId: OWNER,
    });
    f.seedAttempt("c_release", contractId, "issued");

    const response = await f.adminCall("/api/v1/cards/c_release/admin-action", {
      action: "release",
      reason: "execution ticket is stuck; return to engaged",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.card?.status).toBe("engaged");
    expect(response.body.attempts_abandoned).toBe(1);
    expect(response.body.admin_action?.skipped_gates).toEqual(["attempt_lease"]);

    const card = f.db.sqlite.prepare(
      "SELECT status, lease_owner, lease_expires_at FROM cards WHERE id = 'c_release'",
    ).get() as { status: string; lease_owner: string | null; lease_expires_at: string | null };
    expect(card).toMatchObject({ status: "engaged", lease_owner: null, lease_expires_at: null });
    const attempt = f.db.sqlite.prepare(
      "SELECT status FROM attempts WHERE id = 'at_c_release'",
    ).get() as { status: string };
    expect(attempt.status).toBe("abandoned");
    const contract = f.db.sqlite.prepare(
      "SELECT state FROM contracts WHERE id = ?",
    ).get(contractId) as { state: string };
    expect(contract.state).toBe("active");
  });

  it("resets a review card to open, starts a new round and retires live work", async () => {
    const f = await fixture();
    const contractId = f.seedReviewCard({
      id: "c_reset",
      proposerAgentId: BOT_AGENT_ID,
      evidence: true,
    });

    const response = await f.adminCall("/api/v1/cards/c_reset/admin-action", {
      action: "reset",
      reason: "platform bug left the card in review",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.card?.status).toBe("open");
    expect(response.body.card?.round).toBe(2);
    expect(response.body.round).toBe(2);
    expect(response.body.admin_action?.skipped_gates).toEqual(["active_work"]);

    const card = f.db.sqlite.prepare(
      "SELECT status, round, assignee_agent_id, verifier_id, evidence_hash FROM cards WHERE id = 'c_reset'",
    ).get() as Record<string, unknown>;
    expect(card).toMatchObject({
      status: "open",
      round: 2,
      assignee_agent_id: null,
      verifier_id: null,
      evidence_hash: null,
    });
    const contract = f.db.sqlite.prepare(
      "SELECT state FROM contracts WHERE id = ?",
    ).get(contractId) as { state: string };
    expect(contract.state).toBe("superseded");
    const evidence = f.db.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM evidence WHERE card_id = 'c_reset'",
    ).get() as { count: number };
    expect(evidence.count).toBe(1);
  });

  it("rejects release/reset on the wrong state and cancel by a plain member", async () => {
    const f = await fixture();
    const cid = await f.createCard();

    const release = await f.adminCall(`/api/v1/cards/${cid}/admin-action`, {
      action: "release",
      reason: "open cards have no ticket to release",
    });
    expect(release.status).toBe(409);
    expect(release.body.error?.code).toBe("ADMIN_ACTION_STATE");

    const reset = await f.adminCall(`/api/v1/cards/${cid}/admin-action`, {
      action: "reset",
      reason: "open cards are already open",
    });
    expect(reset.status).toBe(409);
    expect(reset.body.error?.code).toBe("ADMIN_ACTION_STATE");

    const memberCancel = await f.adminCall(`/api/v1/cards/${cid}/admin-action`,
      { action: "cancel", reason: "member cannot stop the card" },
      MEMBER_EMAIL,
    );
    expect(memberCancel.status).toBe(403);
    expect(memberCancel.body.error?.code).toBe("ADMIN_PRIVILEGED_FORBIDDEN");
  });

  it("requires If-Match and rejects a stale version (P2-A)", async () => {
    const f = await fixture();
    const cid = await f.createCard();

    // no If-Match at all -> 428, like every other card write
    const bare = await f.human(`/api/v1/cards/${cid}/admin-action`, {
      action: "cancel", reason: "no header at all",
    });
    expect(bare.status).toBe(428);
    expect(bare.body.error?.code).toBe("PRECONDITION_REQUIRED");

    // build round-2 work: engage -> reset -> engage again
    let r = await f.adminCall(`/api/v1/cards/${cid}/admin-action`, {
      action: "engage", reason: "no online peer to propose", assignee_agent_id: BOT,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    r = await f.adminCall(`/api/v1/cards/${cid}/admin-action`, {
      action: "reset", reason: "platform bug needs a new round",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    r = await f.adminCall(`/api/v1/cards/${cid}/admin-action`, {
      action: "engage", reason: "re-engage after bug recovery", assignee_agent_id: BOT,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const contracts = f.db.sqlite
      .prepare("SELECT id FROM contracts WHERE card_id = ? ORDER BY created_at")
      .all(cid) as Array<{ id: string }>;
    expect(contracts.length).toBe(2);

    // a stale page holding version 1 must NOT cancel the round-2 work anymore
    const stale = await f.adminCall(
      `/api/v1/cards/${cid}/admin-action`,
      { action: "cancel", reason: "stale page emergency stop" },
      OWNER_EMAIL,
      1,
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe("VERSION_CONFLICT");

    const card = f.db.sqlite
      .prepare("SELECT status, outcome, round FROM cards WHERE id = ?")
      .get(cid) as Record<string, unknown>;
    expect(card).toMatchObject({ status: "engaged", outcome: null, round: 2 });
    const c2 = f.db.sqlite
      .prepare("SELECT state FROM contracts WHERE id = ?")
      .get(contracts[1].id) as Record<string, unknown>;
    expect(c2.state).toBe("active");

    // and the fresh version still works
    const fresh = await f.adminCall(`/api/v1/cards/${cid}/admin-action`, {
      action: "cancel", reason: "legit emergency stop now",
    });
    expect(fresh.status).toBe(200);
  });

  it("engages with the card's existing internal assignee when the field is omitted (P2-B)", async () => {
    const f = await fixture();
    const cid = "c_fallback";
    f.insertCard({ id: cid, status: "open", assigneeAgentId: BOT_AGENT_ID });

    // previously: 400 ASSIGNEE_NOT_ACTIVE (internal ag_* id fed to the scoped-ref resolver)
    const response = await f.adminCall(`/api/v1/cards/${cid}/admin-action`, {
      action: "engage", reason: "fallback assignee must work",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.card?.status).toBe("engaged");
    expect(response.body.card?.assignee_agent_id).toBe(BOT_AGENT_ID);
    const contract = f.db.sqlite
      .prepare("SELECT proposer_agent_id, state FROM contracts WHERE card_id = ?")
      .get(cid) as Record<string, unknown>;
    expect(contract).toMatchObject({ proposer_agent_id: BOT_AGENT_ID, state: "active" });
  });

  it("resets a round-5 card into round 6 instead of 500 (P2-C)", async () => {
    const f = await fixture();
    const cid = "c_round6";
    f.insertCard({ id: cid, status: "running", round: 5 });

    // previously: 500 CHECK constraint failed: round BETWEEN 1 AND 5
    const response = await f.adminCall(`/api/v1/cards/${cid}/admin-action`, {
      action: "reset", reason: "governance reset past the round ceiling",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.round).toBe(6);
    expect(response.body.admin_action?.skipped_gates).toEqual(["active_work", "round_limit"]);

    const card = f.db.sqlite
      .prepare("SELECT status, round FROM cards WHERE id = ?")
      .get(cid) as Record<string, unknown>;
    expect(card).toMatchObject({ status: "open", round: 6 });

    // governance can keep pushing the round forward, and re-engaging in round 6 works
    const again = await f.adminCall(`/api/v1/cards/${cid}/admin-action`, {
      action: "engage", reason: "engage again in round six", assignee_agent_id: BOT,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    const session = f.db.sqlite
      .prepare("SELECT round, state FROM negotiation_sessions WHERE card_id = ?")
      .get(cid) as Record<string, unknown>;
    expect(session).toMatchObject({ round: 6, state: "committed" });

    // normal negotiation still enforces the 5-round cap at the route layer:
    // reopen of a closed card at round 6 is refused (state/permission guards),
    // and a fresh round-6 reopen by the creator is capped at ROUND_LIMIT — never a 500.
    const closed = f.db.sqlite
      .prepare("SELECT status FROM cards WHERE id = ?")
      .get(cid) as Record<string, unknown>;
    expect(closed.status).not.toBe("closed"); // card is engaged; reopen guard fires first
    expect(Number((f.db.sqlite.prepare("SELECT round FROM cards WHERE id = ?").get(cid) as Record<string, unknown>).round)).toBe(6);
  });
});
