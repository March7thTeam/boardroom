import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../src/context";
import type { CardRow, Env } from "../../src/types";
import { cardRoutes } from "../../src/routes/cards";
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
const ADMIN = "u_admin";
const OWNER_EMAIL = "owner@example.test";
const MEMBER_EMAIL = "member@example.test";
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
  short_circuit?: { level: string; action: string; reason: string; bypassed: string[] };
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
      ('${ADMIN}','${ADMIN_EMAIL}','admin');
    INSERT INTO projects(id,slug,name,created_by,exec_targets_json) VALUES
      ('${P}','short-circuit','Short Circuit','${OWNER}',
       '[{"provider":"github_actions","owner":"acme","repo":"demo","workflows":["ci.yml"]}]');
    INSERT INTO project_members(project_id,user_id,role,added_by) VALUES
      ('${P}','${OWNER}','owner','${OWNER}'),
      ('${P}','${MEMBER}','member','${OWNER}');
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
  app.route("/agent", agentApiRoutes);

  async function human(
    path: string,
    body: unknown = {},
    email = OWNER_EMAIL,
    method = "POST",
  ): Promise<{ status: number; body: ApiBody }> {
    const response = await app.fetch(
      new Request(`http://local${path}`, {
        method,
        headers: { "Content-Type": "application/json", "X-Dev-Email": email },
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

  let cardSeq = 0;
  async function createCard(email = OWNER_EMAIL): Promise<string> {
    const response = await human(`/api/v1/projects/${P}/cards`, { title: `card-${++cardSeq}` }, email);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.card!.id;
  }

  function insertCard(input: {
    id: string;
    status: "open" | "review";
    createdByType?: "user" | "agent";
    createdById?: string;
    requesterAgentId?: string | null;
    assigneeAgentId?: string | null;
    pausedAt?: string | null;
  }): void {
    db.sqlite.prepare(
      `INSERT INTO cards
         (id, project_id, title, status, outcome, version, round, requester_agent_id,
          assignee_agent_id, criteria_json, paused_at, created_by_type, created_by_id)
       VALUES (?1, ?2, 'seeded', ?3, NULL, 1, 1, ?4, ?5, '[]', ?6, ?7, ?8)`,
    ).run(
      input.id,
      P,
      input.status,
      input.requesterAgentId ?? null,
      input.assigneeAgentId ?? null,
      input.pausedAt ?? null,
      input.createdByType ?? "user",
      input.createdById ?? OWNER,
    );
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
    agentCall,
    createCard,
    insertCard,
    seedSession,
    seedContract,
    seedReviewCard,
  };
}

describe("admin short-circuit", () => {
  it("lets a project owner engage an open card without a proposal and issue a ticket", async () => {
    const f = await fixture();
    const cid = await f.createCard();

    const response = await f.call(`/api/v1/cards/${cid}/short-circuit`, {
      action: "engage",
      reason: "no online peer to propose",
      assignee_agent_id: BOT,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.level).toBe("project_owner");
    expect(response.body.short_circuit?.bypassed).toEqual(["proposal", "agent_acceptance"]);
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
    expect(event.event_type).toBe("card.short_circuited");
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
    expect(payload.bypassed).toEqual(["proposal", "agent_acceptance"]);

    const audit = f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE card_id = ?").get(cid) as { count: number };
    expect(audit.count).toBeGreaterThan(0);

    const ticket = await f.agentCall(`/agent/cards/${cid}/tickets`, {});
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
    expect(ticket.body.ticket_id).toBeTruthy();
  });

  it("denies a plain project member", async () => {
    const f = await fixture();
    const cid = await f.createCard();
    const response = await f.call(
      `/api/v1/cards/${cid}/short-circuit`,
      { action: "engage", reason: "member should not pass", assignee_agent_id: BOT },
      MEMBER_EMAIL,
    );
    expect(response.status).toBe(403);
    expect(response.body.error?.code).toBe("SHORT_CIRCUIT_FORBIDDEN");
  });

  it("lets an instance admin act on a project without membership", async () => {
    const f = await fixture();
    const cid = await f.createCard();
    const response = await f.call(
      `/api/v1/cards/${cid}/short-circuit`,
      { action: "engage", reason: "instance-wide governance", assignee_agent_id: BOT },
      ADMIN_EMAIL,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.level).toBe("instance_admin");
    expect(response.body.card?.status).toBe("engaged");
  });

  it("refuses to bypass an open negotiation session", async () => {
    const f = await fixture();
    const cid = await f.createCard();
    f.seedSession(cid, "open");
    const response = await f.call(`/api/v1/cards/${cid}/short-circuit`, {
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
    const response = await f.call("/api/v1/cards/c_agent_owned/short-circuit", {
      action: "engage",
      reason: "self assignment must be blocked",
      assignee_agent_id: BOT,
    });
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe("SELF_ASSIGNMENT");
  });

  it("closes a review card with zero evidence and records the bypass", async () => {
    const f = await fixture();
    const contractId = f.seedReviewCard({ id: "c_no_evidence", proposerAgentId: BOT_AGENT_ID });
    const response = await f.call("/api/v1/cards/c_no_evidence/short-circuit", {
      action: "verify",
      reason: "CI green but artifacts were omitted",
      verdict: "pass",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.outcome).toBe("done");
    expect(response.body.evidence_count).toBe(0);
    expect(response.body.short_circuit?.bypassed).toEqual(["evidence_required"]);
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
      bypassed: ["evidence_required"],
    });
  });

  it("records a proposer-verifier conflict bypass even with evidence", async () => {
    const f = await fixture();
    f.seedReviewCard({
      id: "c_conflict",
      proposerUserId: OWNER,
      evidence: true,
    });
    const response = await f.call("/api/v1/cards/c_conflict/short-circuit", {
      action: "verify",
      reason: "owner is the only available verifier",
      verdict: "pass",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.short_circuit?.bypassed).toEqual(["verifier_conflict"]);
    const event = f.db.sqlite.prepare(
      "SELECT payload_json FROM card_events WHERE card_id = ? ORDER BY seq DESC LIMIT 1",
    ).get("c_conflict") as { payload_json: string };
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    expect(payload.verifier_conflict).toBe("PROPOSER_IS_VERIFIER");
  });

  it("short-circuits a rejection and breaches the active contract", async () => {
    const f = await fixture();
    const contractId = f.seedReviewCard({
      id: "c_reject",
      proposerAgentId: BOT_AGENT_ID,
      evidence: true,
    });
    const response = await f.call("/api/v1/cards/c_reject/short-circuit", {
      action: "verify",
      reason: "evidence does not match the delivered scope",
      verdict: "reject",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.outcome).toBe("rejected");
    expect(response.body.short_circuit?.bypassed).toEqual([]);
    const contract = f.db.sqlite.prepare("SELECT state FROM contracts WHERE id = ?").get(contractId) as { state: string };
    expect(contract.state).toBe("breached");
  });

  it("rejects a paused card and the wrong state", async () => {
    const f = await fixture();
    f.insertCard({ id: "c_paused", status: "open", pausedAt: "2026-01-01T00:00:00.000Z" });
    const paused = await f.call("/api/v1/cards/c_paused/short-circuit", {
      action: "engage",
      reason: "paused cards stay paused",
      assignee_agent_id: BOT,
    });
    expect(paused.status).toBe(409);
    expect(paused.body.error?.code).toBe("CARD_PAUSED");

    const cid = await f.createCard();
    const wrongState = await f.call(`/api/v1/cards/${cid}/short-circuit`, {
      action: "verify",
      reason: "open card cannot be verified",
      verdict: "pass",
    });
    expect(wrongState.status).toBe(409);
    expect(wrongState.body.error?.code).toBe("SHORT_CIRCUIT_STATE");
  });

  it("deduplicates a repeated message_id without creating a second contract", async () => {
    const f = await fixture();
    const cid = await f.createCard();
    const body = {
      action: "engage",
      message_id: "short-circuit-message-1",
      reason: "idempotent governance action",
      assignee_agent_id: BOT,
    };
    const first = await f.call(`/api/v1/cards/${cid}/short-circuit`, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await f.call(`/api/v1/cards/${cid}/short-circuit`, body);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    const contracts = f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM contracts WHERE card_id = ?").get(cid) as { count: number };
    expect(contracts.count).toBe(1);
  });
});
