import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../src/context";
import type { CardRow, Env } from "../../src/types";
import { cardRoutes } from "../../src/routes/cards";
import { agentApiRoutes } from "../../src/routes/agent-api";
import { projectRoutes } from "../../src/routes/projects";
import { sweepProject } from "../../src/domain/timeouts";
import { evidenceHash, type EvidenceDigestItem } from "../../src/domain/execution";
import { hmacSha256Base64Url, tokenHash } from "../../src/lib/crypto";
import { formatAgentToken } from "../../src/lib/tokens";
import { HttpError } from "../../src/lib/http-error";
import { publishOutboxEvent, reconcileEvents, type OutboxRow } from "../../src/lib/event-store";
import { builtin, SqliteD1 } from "../helpers/sqlite-d1";

const { readFileSync, readdirSync } = builtin<{
  readFileSync(path: URL, encoding: string): string;
  readdirSync(path: URL): string[];
}>("node:fs");

interface ApiBody {
  card?: CardRow;
  error?: { code: string; message: string };
  session_id?: string;
  proposal_id?: string;
  terms_hash?: string;
  ticket_id?: string;
  evidence_hash?: string;
  event_id?: string;
  seq?: number | null;
  event_pending?: boolean;
  duplicate?: boolean;
  status?: CardRow["status"];
  outcome?: CardRow["outcome"];
  auto_closed?: boolean;
  verify_result?: string;
  attempt_id?: string;
}
type Proposal = Required<Pick<ApiBody, "session_id" | "proposal_id" | "terms_hash">>;
type Ticket = Required<Pick<ApiBody, "ticket_id">>;
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
    INSERT INTO users(id,email,role) VALUES('u','audit@example.test','admin');
    INSERT INTO projects(id,slug,name,created_by,exec_targets_json)
      VALUES('prj_01ARZ3NDEKTSV4RRFFQ69G5FAV','audit','Audit','u','[{"provider":"github_actions","owner":"audit","repo":"demo","workflows":["ci.yml"]}]');
    INSERT INTO project_members(project_id,user_id,role,added_by) VALUES('prj_01ARZ3NDEKTSV4RRFFQ69G5FAV','u','owner','u');
    INSERT INTO agents(id,slug) VALUES('prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:bot','bot');
    INSERT INTO agent_projects(agent_id,project_id,status,local_slug) VALUES('prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:bot','prj_01ARZ3NDEKTSV4RRFFQ69G5FAV','active','bot');
    INSERT INTO agents(id,slug) VALUES('prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:peer','peer');
    INSERT INTO agent_projects(agent_id,project_id,status,local_slug) VALUES('prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:peer','prj_01ARZ3NDEKTSV4RRFFQ69G5FAV','active','peer');
  `);
  const hash = await tokenHash("not-a-real-secret", "test-pepper");
  db.sqlite.prepare("INSERT INTO agent_tokens(id,agent_id,project_id,prefix,hash,version,expires_at) VALUES('t','prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:bot','prj_01ARZ3NDEKTSV4RRFFQ69G5FAV','test',?,1,'2099-01-01T00:00:00.000Z')").run(hash);
  const peerHash = await tokenHash("not-a-real-peer-secret", "test-pepper");
  db.sqlite.prepare("INSERT INTO agent_tokens(id,agent_id,project_id,prefix,hash,version,expires_at) VALUES('t_peer','prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:peer','prj_01ARZ3NDEKTSV4RRFFQ69G5FAV','test',?,1,'2099-01-01T00:00:00.000Z')").run(peerHash);
  const events: Array<{ eventType: string; payload: unknown }> = [];
  let publication: Promise<unknown> = Promise.resolve();
  let publicationEnabled = true;
  const board = {
    publish(eventId: string): Promise<{ seq: number }> {
      const operation = publication.then(async () => {
        if (!publicationEnabled) throw new Error("injected publisher outage");
        const row = await db.prepare("SELECT * FROM event_outbox WHERE event_id = ?1").bind(eventId).first<OutboxRow>();
        if (!row) throw new Error("missing outbox receipt");
        if (row.published_seq !== null) return { seq: row.published_seq };
        let head = await reconcileEvents(db.asD1(), row.project_id);
        const pending = await db.prepare(`SELECT * FROM event_outbox
          WHERE project_id=?1 AND published_seq IS NULL AND order_id<=?2 ORDER BY order_id`)
          .bind(row.project_id,row.order_id).all<OutboxRow>();
        for (const earlier of pending.results) {
          head = await publishOutboxEvent(db.asD1(), earlier, head);
          events.push({ eventType: earlier.event_type, payload: JSON.parse(earlier.payload_json) });
        }
        return { seq: head.seq };
      });
      publication = operation.catch(() => undefined);
      return operation;
    },
    async closeConnections() {},
    async purgeProject() {},
  };
  const env = {
    DB: db.asD1(), TOKEN_PEPPER: "test-pepper", GITHUB_TOKEN: "fake-no-network", ENVIRONMENT: "development",
    BOARD_DO: { getByName: () => board },
  } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.onError((error, c) => c.json({ error: { code: error instanceof HttpError ? error.code : "INTERNAL", message: error.message } }, (error instanceof HttpError ? error.status : 500) as 500));
  app.route("/api/v1", cardRoutes);
  app.route("/api/v1", projectRoutes);
  app.route("/agent", agentApiRoutes);
  const token = formatAgentToken("prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:bot", "not-a-real-secret");
  const peerToken = formatAgentToken("prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:peer", "not-a-real-peer-secret");
  async function call(path: string, body: unknown = {}, options: { method?: string; headers?: Record<string, string>; agentToken?: string } = {}) {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...options.headers };
    if (path.startsWith("/agent")) headers.Authorization = `Bearer ${options.agentToken ?? token}`;
    else headers["X-Dev-Email"] = "audit@example.test";
    const response = await app.fetch(new Request(`http://local${path}`, { method: options.method ?? "POST", headers, body: JSON.stringify(body) }), env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    return { status: response.status, body: await response.json() as ApiBody };
  }
  async function createCard(agentOwned = false) {
    const response = await call(agentOwned ? "/agent/cards?project_id=prj_01ARZ3NDEKTSV4RRFFQ69G5FAV" : "/api/v1/projects/prj_01ARZ3NDEKTSV4RRFFQ69G5FAV/cards", { title: "audit card" });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.card!.id;
  }
  let sequence = 0;
  async function proposal(cardId: string, more: Record<string, unknown> = {}, agentToken?: string) {
    const response = await call(`/agent/cards/${cardId}/negotiate`, { message_id: `proposal-${++sequence}`, type: "proposal", card_id: cardId, terms: { scope: `demo-${sequence}` }, ...more }, { agentToken });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body as Proposal;
  }
  async function commit(cardId: string, offer: Proposal) {
    return call(`/api/v1/cards/${cardId}/commit`, { message_id: `commit-${++sequence}-unique`, ...offer });
  }
  async function agentCommit(cardId: string, offer: Proposal) {
    return call(`/agent/cards/${cardId}/negotiate`, {
      message_id: `agent-commit-${++sequence}`, type: "commit", card_id: cardId, ...offer,
      proof: { by: "prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:bot", alg: "HMAC-SHA256", value: await hmacSha256Base64Url("not-a-real-secret", offer.terms_hash) },
    });
  }
  async function engaged() {
    const cid = await createCard();
    const offer = await proposal(cid);
    expect((await commit(cid, offer)).status).toBe(201);
    return cid;
  }
  async function running() {
    const cid = await engaged();
    const response = await call(`/agent/cards/${cid}/tickets`, {});
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return { cid, ticket: response.body as Ticket };
  }
  const card = (cid: string) => db.sqlite.prepare("SELECT * FROM cards WHERE id=?").get(cid) as unknown as CardRow;
  return { db, env, events, board, setPublication(enabled: boolean) { publicationEnabled=enabled; },
    call, createCard, proposal, commit, agentCommit, peerToken, engaged, running, card };
}

function runBody(ticket: Ticket) {
  return { ticket_id: ticket.ticket_id, provider: "github_actions", run: { run_id: 123, run_attempt: 1, html_url: "https://github.com/audit/demo/actions/runs/123" }, artifacts: [{ name: "output", sha256: "a".repeat(64), size_bytes: 10 }] };
}
function githubResponse(conclusion = "success") {
  return Response.json({ id: 123, run_attempt: 1, html_url: "https://github.com/audit/demo/actions/runs/123", head_sha: "b".repeat(40), conclusion, event: "workflow_dispatch", path: ".github/workflows/ci.yml", created_at: new Date(Date.now() + 1000).toISOString() });
}
function receiptFields(body: ApiBody) {
  const { status, outcome, auto_closed, verify_result, attempt_id, evidence_hash, event_id, seq } = body;
  return { status, outcome, auto_closed, verify_result, attempt_id, evidence_hash, event_id, seq };
}

describe("card lifecycle and negotiation consistency", () => {
  it("closing a running card retires its execution and permits a fresh commitment after reopening", async () => {
    const f = await fixture(); const { cid, ticket } = await f.running();
    expect((await f.call(`/api/v1/cards/${cid}/close`, { reason: "cancel for replacement" }, { headers: { "If-Match": String(f.card(cid).version) } })).status).toBe(200);
    expect(f.db.sqlite.prepare("SELECT status FROM attempts WHERE id=?").get(ticket.ticket_id)?.status).toBe("abandoned");
    expect((await f.call(`/api/v1/cards/${cid}/reopen`, {}, { headers: { "If-Match": String(f.card(cid).version) } })).status).toBe(200);
    expect((await f.commit(cid, await f.proposal(cid))).status).toBe(201);
  });

  it("agent-owned close and reopen retire the old work and allow a new peer commitment", async () => {
    const f = await fixture(); const cid = await f.createCard(true);
    const offer = await f.proposal(cid, {}, f.peerToken);
    expect((await f.call(`/agent/cards/${cid}/close`, { reason: "requester cancels negotiation" }, { headers: { "If-Match": String(f.card(cid).version) } })).status).toBe(200);
    expect(f.db.sqlite.prepare("SELECT state FROM negotiation_sessions WHERE id=?").get(offer.session_id)?.state).toBe("cancelled");
    expect(f.db.sqlite.prepare("SELECT status FROM proposals WHERE id=?").get(offer.proposal_id)?.status).toBe("expired");
    expect((await f.call(`/agent/cards/${cid}/reopen`, {}, { headers: { "If-Match": String(f.card(cid).version) } })).status).toBe(200);
    const liveOffer = await f.proposal(cid, {}, f.peerToken);
    expect((await f.agentCommit(cid, liveOffer)).status).toBe(201);
    const ticketResponse = await f.call(`/agent/cards/${cid}/tickets`, {}, { agentToken: f.peerToken });
    expect(ticketResponse.status, JSON.stringify(ticketResponse.body)).toBe(201);
    const ticket = ticketResponse.body as Ticket;

    expect((await f.call(`/agent/cards/${cid}/close`, { reason: "requester cancels old work" }, { headers: { "If-Match": String(f.card(cid).version) } })).status).toBe(200);
    expect(f.db.sqlite.prepare("SELECT state FROM contracts WHERE card_id=?").get(cid)?.state).toBe("superseded");
    expect(f.db.sqlite.prepare("SELECT state FROM negotiation_sessions WHERE id=?").get(offer.session_id)?.state).not.toBe("open");
    expect(f.db.sqlite.prepare("SELECT status FROM attempts WHERE id=?").get(ticket.ticket_id)?.status).toBe("abandoned");
    expect((await f.call(`/agent/cards/${cid}/reopen`, {}, { headers: { "If-Match": String(f.card(cid).version) } })).status).toBe(200);
    const fresh = await f.proposal(cid, {}, f.peerToken);
    expect(fresh.session_id).not.toBe(offer.session_id);
    expect((await f.agentCommit(cid, fresh)).status).toBe(201);
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM contracts WHERE card_id=? AND state='active'").get(cid)?.n).toBe(1);
  });

  it("rejects expired sessions and never creates a contract for an old round", async () => {
    const f = await fixture(); const cid = await f.createCard(); const offer = await f.proposal(cid);
    f.db.sqlite.prepare("UPDATE negotiation_sessions SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(offer.session_id);
    await sweepProject(f.env, "prj_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect((await f.commit(cid, offer)).status).toBe(409);
    expect(f.card(cid).status).toBe("open");
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM contracts WHERE card_id=?").get(cid)?.n).toBe(0);
    expect((await f.call(`/agent/cards/${cid}/negotiate`, { type: "counter", message_id: "stale-counter", card_id: cid, session_id: offer.session_id, terms: { scope: "stale" } })).status).toBe(409);
  });

  it("rejects requester-agent commit and counter on an expired peer session", async () => {
    const f = await fixture(); const cid = await f.createCard(true);
    const offer = await f.proposal(cid, {}, f.peerToken);
    f.db.sqlite.prepare("UPDATE negotiation_sessions SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(offer.session_id);
    expect((await sweepProject(f.env, "prj_01ARZ3NDEKTSV4RRFFQ69G5FAV")).sessions).toBe(1);
    const committed = await f.agentCommit(cid, offer);
    expect(committed.status).toBe(409);
    expect(committed.body.error?.code).toBe("SESSION_BUSY");
    const countered = await f.call(`/agent/cards/${cid}/negotiate`, { type: "counter", message_id: "expired-agent-counter", card_id: cid, session_id: offer.session_id, terms: { scope: "stale-agent-terms" } });
    expect(countered.status).toBe(409);
    expect(countered.body.error?.code).toBe("SESSION_BUSY");
    expect(f.card(cid).status).toBe("open");
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM contracts WHERE card_id=?").get(cid)?.n).toBe(0);
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM proposals WHERE session_id=?").get(offer.session_id)?.n).toBe(1);
  });

  it("rejects a countered offer instead of accepting superseded terms", async () => {
    const f = await fixture(); const cid = await f.createCard(); const old = await f.proposal(cid);
    const latest = await f.proposal(cid, { type: "counter", session_id: old.session_id, terms: { scope: "replacement" } });
    expect((await f.commit(cid, old)).status).toBe(409);
    expect((await f.commit(cid, latest)).status).toBe(201);
  });

  it("does not consume another actor's renewed lease or its live ticket during a stale sweep", async () => {
    const f = await fixture(); const { cid, ticket } = await f.running();
    f.db.sqlite.prepare("UPDATE cards SET lease_owner='prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:bot',lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(cid);
    f.db.afterAll = async (sql, rows) => { if (sql.includes("lease_expires_at < ?2") && rows.length) {
      f.db.afterAll = undefined;
      expect((await f.call(`/agent/cards/${cid}/lease`, { ttl_minutes: 60 })).status).toBe(201);
    } };
    expect((await sweepProject(f.env, "prj_01ARZ3NDEKTSV4RRFFQ69G5FAV")).leases).toBe(0);
    expect(f.card(cid).status).toBe("running");
    expect(f.db.sqlite.prepare("SELECT status FROM attempts WHERE id=?").get(ticket.ticket_id)?.status).toBe("issued");
    expect(f.events.some((event) => event.eventType === "lease.expired")).toBe(false);
  });
});

describe("human acceptance of engaged contracts", () => {
  const note = "local typecheck and full test suite pass";

  it("closes an engaged human-mode card with an attestation and no run", async () => {
    const f = await fixture(); const cid = await f.engaged();
    const response = await f.call(`/api/v1/cards/${cid}/verify`, {
      message_id: "human-attest-pass",
      verdict: "pass",
      reasons: [{ message: note, pass: true }],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.card?.status).toBe("closed");
    expect(response.body.card?.outcome).toBe("done");
    const evidence = f.db.sqlite.prepare(
      "SELECT kind,sha256,summary,produced_by FROM evidence WHERE card_id=?",
    ).all(cid) as Array<{ kind: string; sha256: string; summary: string; produced_by: string }>;
    expect(evidence).toHaveLength(1);
    expect(evidence[0].kind).toBe("attestation");
    expect(evidence[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence[0].produced_by).toBe("u");
    expect(f.card(cid).evidence_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(f.db.sqlite.prepare("SELECT state FROM contracts WHERE card_id=?").get(cid)?.state).toBe("fulfilled");
    const event = f.events.find((item) => item.eventType === "card.verdict");
    expect((event?.payload as { from?: string; human_attested?: boolean }).from).toBe("engaged");
    expect((event?.payload as { human_attested?: boolean }).human_attested).toBe(true);
  });

  it("requires a written attestation note before closing", async () => {
    const f = await fixture(); const cid = await f.engaged();
    const response = await f.call(`/api/v1/cards/${cid}/verify`, {
      message_id: "human-attest-no-note",
      verdict: "pass",
    });
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe("ATTESTATION_REQUIRED");
    expect(f.card(cid).status).toBe("engaged");
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM evidence WHERE card_id=?").get(cid)?.n).toBe(0);
  });

  it("rejects an engaged contract and marks it breached", async () => {
    const f = await fixture(); const cid = await f.engaged();
    const response = await f.call(`/api/v1/cards/${cid}/verify`, {
      message_id: "human-attest-reject",
      verdict: "reject",
      reasons: [{ message: "acceptance criteria were not met", pass: false }],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.card?.outcome).toBe("rejected");
    expect(f.db.sqlite.prepare("SELECT state FROM contracts WHERE card_id=?").get(cid)?.state).toBe("breached");
  });

  it("does not allow direct attestation in rule mode", async () => {
    const f = await fixture();
    f.db.sqlite.exec("UPDATE projects SET verification_mode='rule' WHERE id='prj_01ARZ3NDEKTSV4RRFFQ69G5FAV'");
    const cid = await f.engaged();
    const response = await f.call(`/api/v1/cards/${cid}/verify`, {
      message_id: "rule-mode-attest",
      verdict: "pass",
      reasons: [{ message: note, pass: true }],
    });
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe("CARD_NOT_IN_REVIEW");
  });

  it("rejects needs_more from an engaged card", async () => {
    const f = await fixture(); const cid = await f.engaged();
    const response = await f.call(`/api/v1/cards/${cid}/verify`, {
      message_id: "human-attest-needs-more",
      verdict: "needs_more",
      reasons: [{ message: note, pass: false }],
    });
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe("ILLEGAL_TRANSITION");
  });
});

describe("run evidence and concurrent interventions", () => {
  it("replays a published successful ticket receipt without verifying or applying it again", async () => {
    const f = await fixture(); const { cid, ticket } = await f.running();
    const fetchMock = vi.fn(async () => githubResponse()); vi.stubGlobal("fetch", fetchMock);
    const body = runBody(ticket);
    const first = await f.call(`/agent/cards/${cid}/runs`, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const snapshot = f.card(cid); const eventCount = f.events.length;
    const duplicate = await f.call(`/agent/cards/${cid}/runs`, body);
    expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(200);
    expect(duplicate.body.duplicate).toBe(true);
    expect(receiptFields(duplicate.body)).toEqual(receiptFields(first.body));
    expect(f.card(cid)).toEqual(snapshot);
    expect(f.events).toHaveLength(eventCount);
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM evidence WHERE card_id=?").get(cid)?.n).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("replays an old receipt after needs_more and a new ticket without touching the new run", async () => {
    const f = await fixture(); const { cid, ticket } = await f.running();
    const fetchMock = vi.fn(async () => githubResponse()); vi.stubGlobal("fetch", fetchMock);
    const body = runBody(ticket);
    const first = await f.call(`/agent/cards/${cid}/runs`, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect((await f.call(`/api/v1/cards/${cid}/verify`, { verdict: "needs_more", message_id: "needs-more-before-ticket" })).status).toBe(200);
    const nextTicket = await f.call(`/agent/cards/${cid}/tickets`, {});
    expect(nextTicket.status, JSON.stringify(nextTicket.body)).toBe(201);
    const snapshot = f.card(cid); const eventCount = f.events.length;

    const duplicate = await f.call(`/agent/cards/${cid}/runs`, body);
    expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(200);
    expect(duplicate.body.duplicate).toBe(true);
    expect(receiptFields(duplicate.body)).toEqual(receiptFields(first.body));
    expect(f.card(cid)).toEqual(snapshot);
    expect(f.card(cid).status).toBe("running");
    expect(f.db.sqlite.prepare("SELECT status FROM attempts WHERE id=?").get(nextTicket.body.ticket_id!)?.status).toBe("issued");
    expect(f.db.sqlite.prepare("SELECT status FROM attempts WHERE id=?").get(ticket.ticket_id)?.status).toBe("succeeded");
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM evidence WHERE card_id=?").get(cid)?.n).toBe(1);
    expect(f.events).toHaveLength(eventCount);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("applies concurrent identical ticket reports once and replays a later retry", async () => {
    const f = await fixture(); const { cid, ticket } = await f.running();
    const version = f.card(cid).version;
    const releases: Array<(response: Response) => void> = [];
    let notify!: () => void; const bothFetched = new Promise<void>((resolve) => { notify = resolve; });
    const fetchMock = vi.fn(async () => new Promise<Response>((resolve) => {
      releases.push(resolve);
      if (releases.length === 2) notify();
    }));
    vi.stubGlobal("fetch", fetchMock);
    const body = runBody(ticket);
    const requests = [f.call(`/agent/cards/${cid}/runs`, body), f.call(`/agent/cards/${cid}/runs`, body)];
    await bothFetched;
    for (const release of releases) release(githubResponse());
    const responses = await Promise.all(requests);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    const other = responses.find((response) => response.status !== 201)!;
    expect([200, 409]).toContain(other.status);
    if (other.status === 200) expect(other.body.duplicate).toBe(true);
    expect(f.card(cid).status).toBe("review");
    expect(f.card(cid).version).toBe(version + 1);
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM evidence WHERE card_id=?").get(cid)?.n).toBe(1);
    expect(f.db.sqlite.prepare("SELECT status FROM attempts WHERE id=?").get(ticket.ticket_id)?.status).toBe("succeeded");
    expect(f.events.filter((event) => event.eventType === "run.verified")).toHaveLength(1);
    const eventCount = f.events.length; const snapshot = f.card(cid);
    const retry = await f.call(`/agent/cards/${cid}/runs`, body);
    expect(retry.status).toBe(200);
    expect(retry.body.duplicate).toBe(true);
    expect(f.card(cid)).toEqual(snapshot);
    expect(f.events).toHaveLength(eventCount);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not override a pause completed while GitHub verification was in flight", async () => {
    const f = await fixture(); const { cid, ticket } = await f.running();
    let notify!: () => void; const fetched = new Promise<void>((resolve) => { notify = resolve; });
    let release!: (value: Response) => void;
    vi.stubGlobal("fetch", async () => { notify(); return new Promise<Response>((resolve) => { release = resolve; }); });
    const pending = f.call(`/agent/cards/${cid}/runs`, runBody(ticket));
    await fetched;
    expect((await f.call(`/api/v1/cards/${cid}/intervene`, { type: "pause", reason: "pause while checking" })).status).toBe(200);
    release(githubResponse());
    expect((await pending).status).toBe(409);
    expect(f.card(cid).status).toBe("running");
    expect(f.card(cid).paused_at).not.toBeNull();
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM evidence WHERE card_id=?").get(cid)?.n).toBe(0);
    expect(f.db.sqlite.prepare("SELECT status FROM attempts WHERE id=?").get(ticket.ticket_id)?.status).toBe("issued");
  });

  it.each(["success", "failure"])("does not let an old in-flight %s report consume a replacement ticket after timeout", async (conclusion) => {
    const f = await fixture(); const { cid, ticket } = await f.running();
    let notify!: () => void; const fetched = new Promise<void>((resolve) => { notify = resolve; });
    let release!: (value: Response) => void;
    vi.stubGlobal("fetch", async () => { notify(); return new Promise<Response>((resolve) => { release = resolve; }); });
    const pending = f.call(`/agent/cards/${cid}/runs`, runBody(ticket));
    await fetched;
    f.db.sqlite.prepare("UPDATE attempts SET started_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(ticket.ticket_id);
    expect((await sweepProject(f.env, "prj_01ARZ3NDEKTSV4RRFFQ69G5FAV")).attempts).toBe(1);
    const replacement = await f.call(`/agent/cards/${cid}/tickets`, {});
    expect(replacement.status, JSON.stringify(replacement.body)).toBe(201);
    const snapshot = f.card(cid);
    const eventsBefore = f.events.length;
    release(githubResponse(conclusion));

    expect((await pending).status).toBe(409);
    expect(f.card(cid)).toEqual(snapshot);
    expect(f.db.sqlite.prepare("SELECT status FROM attempts WHERE id=?").get(ticket.ticket_id)?.status).toBe("abandoned");
    expect(f.db.sqlite.prepare("SELECT status FROM attempts WHERE id=?").get(replacement.body.ticket_id!)?.status).toBe("issued");
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM evidence WHERE card_id=?").get(cid)?.n).toBe(0);
    expect(f.events).toHaveLength(eventsBefore);
  });

  it.each(["success", "failure"])("rolls back every %s run side effect when pause wins immediately before the CAS batch", async (conclusion) => {
    const f = await fixture(); const { cid, ticket } = await f.running();
    vi.stubGlobal("fetch", async () => githubResponse(conclusion));
    f.db.beforeBatch = async () => {
      f.db.beforeBatch = undefined;
      expect((await f.call(`/api/v1/cards/${cid}/intervene`, { type: "pause", reason: "pause just before commit" })).status).toBe(200);
    };
    expect((await f.call(`/agent/cards/${cid}/runs`, runBody(ticket))).status).toBe(409);
    expect(f.card(cid).status).toBe("running");
    expect(f.card(cid).paused_at).not.toBeNull();
    expect(f.db.sqlite.prepare("SELECT status FROM attempts WHERE id=?").get(ticket.ticket_id)?.status).toBe("issued");
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM evidence WHERE card_id=?").get(cid)?.n).toBe(0);
    expect(f.events.some((event) => event.eventType === "run.verified")).toBe(false);
  });

  it("deduplicates identical artifact declarations before hashing and persistence", async () => {
    const f = await fixture(); const { cid, ticket } = await f.running();
    vi.stubGlobal("fetch", async () => githubResponse());
    const body = runBody(ticket); body.artifacts.push({ ...body.artifacts[0]! });
    expect((await f.call(`/agent/cards/${cid}/runs`, body)).status).toBe(201);
    const stored = f.db.sqlite.prepare("SELECT kind,sha256,size_bytes FROM evidence WHERE card_id=?").all(cid) as unknown as EvidenceDigestItem[];
    expect(stored).toHaveLength(1);
    expect(f.card(cid).evidence_hash).toBe(await evidenceHash(stored));
  });

  it("rejects conflicting sizes for one hash without consuming the ticket", async () => {
    const f = await fixture(); const { cid, ticket } = await f.running();
    const fetchMock = vi.fn(async () => githubResponse()); vi.stubGlobal("fetch", fetchMock);
    const body = runBody(ticket); body.artifacts.push({ ...body.artifacts[0]!, size_bytes: 99 });
    expect((await f.call(`/agent/cards/${cid}/runs`, body)).status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(f.db.sqlite.prepare("SELECT status FROM attempts WHERE id=?").get(ticket.ticket_id)?.status).toBe("issued");
    expect(f.card(cid).status).toBe("running");
  });

  it("rejects a hash whose historical evidence has another size without consuming its ticket", async () => {
    const f = await fixture(); const { cid, ticket } = await f.running();
    f.db.sqlite.prepare("INSERT INTO evidence(id,card_id,kind,sha256,size_bytes,produced_by) VALUES('old_conflict',?,'artifact',?,99,'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:bot')").run(cid, "a".repeat(64));
    vi.stubGlobal("fetch", async () => githubResponse());
    expect((await f.call(`/agent/cards/${cid}/runs`, runBody(ticket))).status).toBe(422);
    expect(f.card(cid).status).toBe("running");
    expect(f.card(cid).evidence_hash).toBeNull();
    expect(f.db.sqlite.prepare("SELECT status FROM attempts WHERE id=?").get(ticket.ticket_id)?.status).toBe("issued");
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM evidence WHERE card_id=?").get(cid)?.n).toBe(1);
  });

  it("reuses matching historical evidence while hashing only this report's artifact set", async () => {
    const f = await fixture(); const { cid, ticket } = await f.running();
    f.db.sqlite.prepare("INSERT INTO evidence(id,card_id,kind,sha256,size_bytes,produced_by) VALUES('old_same',?,'artifact',?,10,'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:bot')").run(cid, "a".repeat(64));
    f.db.sqlite.prepare("INSERT INTO evidence(id,card_id,kind,sha256,size_bytes,produced_by) VALUES('old_unrelated',?,'artifact',?,999,'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:bot')").run(cid, "d".repeat(64));
    vi.stubGlobal("fetch", async () => githubResponse());
    const body = runBody(ticket); body.artifacts.push({ name: "new-output", sha256: "c".repeat(64), size_bytes: 30 });
    const response = await f.call(`/agent/cards/${cid}/runs`, body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const expected = await evidenceHash(body.artifacts.map(({ sha256, size_bytes }) => ({ kind: "artifact", sha256, size_bytes })));
    expect(response.body.evidence_hash).toBe(expected);
    expect(f.card(cid).evidence_hash).toBe(expected);
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM evidence WHERE card_id=?").get(cid)?.n).toBe(3);
    expect(f.db.sqlite.prepare("SELECT attempt_id FROM evidence WHERE id='old_same'").get()?.attempt_id).toBeNull();
    expect(f.db.sqlite.prepare("SELECT status FROM attempts WHERE id=?").get(ticket.ticket_id)?.status).toBe("succeeded");
  });
});

describe("project deletion preserves global identities", () => {
  it("keeps an agent and its membership in another archived project", async () => {
    const f = await fixture();
    f.db.sqlite.exec("INSERT INTO projects(id,slug,name,created_by,archived_at) VALUES('prj_01ARZ3NDEKTSV4RRFFQ69G5FAW','second','Second','u','2026-01-01T00:00:00.000Z'); INSERT INTO agent_projects(agent_id,project_id,status,local_slug) VALUES('prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:bot','prj_01ARZ3NDEKTSV4RRFFQ69G5FAW','active','bot'); UPDATE projects SET archived_at='2026-01-01T00:00:00.000Z' WHERE id='prj_01ARZ3NDEKTSV4RRFFQ69G5FAV';");
    expect((await f.call("/api/v1/projects/prj_01ARZ3NDEKTSV4RRFFQ69G5FAV", { confirm_slug: "audit" }, { method: "DELETE" })).status).toBe(200);
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM agents WHERE id='prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:bot'").get()?.n).toBe(1);
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM agent_projects WHERE project_id='prj_01ARZ3NDEKTSV4RRFFQ69G5FAW'").get()?.n).toBe(1);
    expect(f.db.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("keeps foreign-key references to the agent from cards in another archived project", async () => {
    const f = await fixture();
    f.db.sqlite.exec(`
      INSERT INTO projects(id,slug,name,created_by,archived_at) VALUES('prj_01ARZ3NDEKTSV4RRFFQ69G5FAW','second','Second','u','2026-01-01T00:00:00.000Z');
      INSERT INTO agent_projects(agent_id,project_id,status,local_slug) VALUES('prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:bot','prj_01ARZ3NDEKTSV4RRFFQ69G5FAW','active','bot');
      INSERT INTO cards(id,project_id,title,requester_agent_id,assignee_agent_id,created_by_type,created_by_id)
        VALUES('retained_card','prj_01ARZ3NDEKTSV4RRFFQ69G5FAW','archived card','prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:bot','prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:bot','agent','prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:bot');
      UPDATE projects SET archived_at='2026-01-01T00:00:00.000Z' WHERE id='prj_01ARZ3NDEKTSV4RRFFQ69G5FAV';
    `);
    const response = await f.call("/api/v1/projects/prj_01ARZ3NDEKTSV4RRFFQ69G5FAV", { confirm_slug: "audit" }, { method: "DELETE" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(f.db.sqlite.prepare("SELECT requester_agent_id,assignee_agent_id FROM cards WHERE id='retained_card'").get()).toEqual({ requester_agent_id: "prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:bot", assignee_agent_id: "prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:bot" });
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM agents WHERE id='prj_01ARZ3NDEKTSV4RRFFQ69G5FAV:bot'").get()?.n).toBe(1);
    expect(f.db.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

const PROJECT_A = "prj_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROJECT_B = "prj_01ARZ3NDEKTSV4RRFFQ69G5FAW";

describe("publication outages keep durable commands idempotent", () => {
  it("keeps the self-deal receipt across pending publication and exact retries", async () => {
    const f = await fixture();
    f.db.sqlite.prepare("DELETE FROM agents WHERE id=?").run(PROJECT_A + ":peer");
    const cid = await f.createCard(true);
    const offer = await f.proposal(cid);
    const body = {message_id:"pending-self-deal-commit",card_id:cid,type:"commit",...offer,
      proof:{by:PROJECT_A+":bot",alg:"HMAC-SHA256",value:await hmacSha256Base64Url("not-a-real-secret",offer.terms_hash)}};
    f.setPublication(false);
    const first = await f.call(`/agent/cards/${cid}/negotiate`, body);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({self_deal:true,event_pending:true});
    const snapshot = f.card(cid);
    const pending = await f.call(`/agent/cards/${cid}/negotiate`, body);
    expect(pending.status).toBe(202);
    expect(pending.body).toMatchObject({self_deal:true,event_pending:true,duplicate:true,event_id:first.body.event_id});
    f.setPublication(true);
    const published = await f.call(`/agent/cards/${cid}/negotiate`, body);
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({self_deal:true,event_pending:false,duplicate:true,event_id:first.body.event_id});
    expect(f.card(cid)).toEqual(snapshot);
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM contracts WHERE card_id=?").get(cid)?.n).toBe(1);
  });

  it.each([false,true])("recovers a pending create once without duplicating the %s-owned card", async (agentOwned) => {
    const f=await fixture(); f.setPublication(false);
    const created=await f.call(agentOwned?`/agent/cards?project_id=${PROJECT_A}`:`/api/v1/projects/${PROJECT_A}/cards`,{title:"pending create"});
    expect(created.status).toBe(202); expect(created.body).toMatchObject({seq:null,event_pending:true});
    const cid=created.body.card!.id; const snapshot=f.card(cid);
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM cards").get()?.n).toBe(1);
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM card_events").get()?.n).toBe(0);
    f.setPublication(true);
    const published=await f.board.publish(created.body.event_id!);
    expect(await f.board.publish(created.body.event_id!)).toEqual(published);
    expect(f.card(cid)).toEqual(snapshot);
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM card_events").get()?.n).toBe(1);
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM audit_log").get()?.n).toBe(1);
  });

  it("replays a pending proposal and rejects a reused message with different terms", async () => {
    const f=await fixture(); const cid=await f.createCard(); f.setPublication(false);
    const body={type:"proposal",message_id:"pending-proposal-request",card_id:cid,terms:{scope:"original terms"}};
    const first=await f.call(`/agent/cards/${cid}/negotiate`,body);
    expect(first.status).toBe(202); expect(first.body.event_pending).toBe(true);
    const retry=await f.call(`/agent/cards/${cid}/negotiate`,body);
    expect(retry.status).toBe(202); expect(retry.body).toMatchObject({duplicate:true,event_id:first.body.event_id,proposal_id:first.body.proposal_id,seq:null});
    expect((await f.call(`/agent/cards/${cid}/negotiate`,{...body,terms:{scope:"changed terms"}})).status).toBe(409);
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM proposals").get()?.n).toBe(1);
    f.setPublication(true);
    const published=await f.call(`/agent/cards/${cid}/negotiate`,body);
    expect(published.status).toBe(200); expect(published.body).toMatchObject({duplicate:true,event_pending:false,event_id:first.body.event_id});
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM card_events WHERE message_id=?").get(body.message_id)?.n).toBe(1);
  });

  it.each([false,true])("replays a pending %s-owned commitment without another contract or version change", async (agentOwned) => {
    const f=await fixture(); const cid=await f.createCard(agentOwned);
    const offer=await f.proposal(cid,{},agentOwned?f.peerToken:undefined);
    const body={message_id:"pending-commit-request",...offer,...(agentOwned?{type:"commit",card_id:cid,proof:{by:PROJECT_A+":bot",alg:"HMAC-SHA256",value:await hmacSha256Base64Url("not-a-real-secret",offer.terms_hash)}}:{})};
    const path=agentOwned?`/agent/cards/${cid}/negotiate`:`/api/v1/cards/${cid}/commit`;
    f.setPublication(false); const first=await f.call(path,body);
    expect(first.status).toBe(202); expect(first.body.event_pending).toBe(true); const snapshot=f.card(cid);
    const retry=await f.call(path,body); expect(retry.status).toBe(202); expect(retry.body.duplicate).toBe(true);
    expect((await f.call(path,{...body,terms_hash:"sha256:"+"f".repeat(64)})).status).toBe(409);
    expect(f.card(cid)).toEqual(snapshot); expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM contracts WHERE card_id=?").get(cid)?.n).toBe(1);
    f.setPublication(true); const published=await f.call(path,body);
    expect(published.status).toBe(200); expect(published.body).toMatchObject({event_pending:false,duplicate:true,event_id:first.body.event_id});
    expect(f.card(cid)).toEqual(snapshot);
  });

  it.each(["success","failure"])("replays a pending %s run receipt without touching a newer ticket", async (conclusion) => {
    const f=await fixture(); const {cid,ticket}=await f.running();
    const fetchMock=vi.fn(async()=>githubResponse(conclusion)); vi.stubGlobal("fetch",fetchMock);
    const body=runBody(ticket); f.setPublication(false);
    const first=await f.call(`/agent/cards/${cid}/runs`,body);
    expect(first.status).toBe(202); expect(first.body).toMatchObject({event_pending:true,seq:null,status:conclusion==="success"?"review":"engaged",verify_result:conclusion==="success"?"ok":"failed"});
    const pending=await f.call(`/agent/cards/${cid}/runs`,body); expect(pending.status).toBe(202); expect(pending.body.duplicate).toBe(true);
    expect((await f.call(`/agent/cards/${cid}/runs`,{...body,artifacts:[{...body.artifacts[0],size_bytes:99}]})).status).toBe(409);
    if(conclusion==="success") expect((await f.call(`/api/v1/cards/${cid}/verify`,{verdict:"needs_more",message_id:"pending-rework-request"})).status).toBe(202);
    const newer=await f.call(`/agent/cards/${cid}/tickets`,{}); expect(newer.status).toBe(202);
    const snapshot=f.card(cid); f.setPublication(true);
    const replay=await f.call(`/agent/cards/${cid}/runs`,body); expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({duplicate:true,event_pending:false,event_id:first.body.event_id,status:first.body.status,verify_result:first.body.verify_result});
    expect(replay.body.evidence_hash).toBe(first.body.evidence_hash);
    expect(f.card(cid)).toEqual(snapshot);
    expect(f.db.sqlite.prepare("SELECT status FROM attempts WHERE id=?").get(newer.body.ticket_id!)?.status).toBe("issued");
    expect(f.db.sqlite.prepare("SELECT published_seq FROM event_outbox WHERE event_id=?").get(newer.body.event_id!)?.published_seq).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recovers a committed timeout event while a second sweep remains a no-op", async () => {
    const f=await fixture(); const {cid,ticket}=await f.running();
    f.db.sqlite.prepare("UPDATE attempts SET started_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(ticket.ticket_id);
    f.setPublication(false); expect((await sweepProject(f.env,PROJECT_A)).attempts).toBe(1); const snapshot=f.card(cid);
    const row=f.db.sqlite.prepare("SELECT event_id,published_seq FROM event_outbox WHERE message_id=?").get(`ticket-expired:${ticket.ticket_id}`)!;
    expect(row.published_seq).toBeNull(); expect((await sweepProject(f.env,PROJECT_A)).attempts).toBe(0);
    f.setPublication(true); await f.board.publish(String(row.event_id)); await f.board.publish(String(row.event_id));
    expect(f.card(cid)).toEqual(snapshot);
    expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM card_events WHERE event_id=?").get(String(row.event_id))?.n).toBe(1);
  });
});

it("activates and assigns guest public IDs and accepts the requester's project-local proof", async () => {
  const f=await fixture();
  const projectC="prj_01ARZ3NDEKTSV4RRFFQ69G5FAX";
  f.db.sqlite.exec(`INSERT INTO projects(id,slug,name,created_by) VALUES('${PROJECT_B}','other','Other','u'),('${projectC}','third','Third','u');
    INSERT INTO project_members(project_id,user_id,role,added_by) VALUES('${PROJECT_B}','u','owner','u');
    INSERT INTO agent_projects(agent_id,project_id,status,local_slug) VALUES('${PROJECT_A}:bot','${PROJECT_B}','pending','bot'),('${PROJECT_A}:peer','${PROJECT_B}','pending','peer'),('${PROJECT_A}:bot','${projectC}','active','bot');`);
  for(const slug of ["bot","peer"]) {
    f.db.sqlite.prepare("INSERT INTO agent_tokens(id,agent_id,project_id,prefix,hash,version,expires_at) VALUES(?,?,?,?,?,1,'2099-01-01T00:00:00.000Z')")
      .run('b-'+slug,PROJECT_A+':'+slug,PROJECT_B,'test',await tokenHash('secret-b-'+slug,'test-pepper'));
    expect((await f.call(`/api/v1/projects/${PROJECT_B}/agents/${encodeURIComponent(PROJECT_B+':'+slug)}/status`,{status:"active"})).status).toBe(200);
  }
  const bot=formatAgentToken(PROJECT_B+':bot','secret-b-bot'); const peer=formatAgentToken(PROJECT_B+':peer','secret-b-peer');
  const created=await f.call(`/agent/cards?project_id=${PROJECT_B}`,{title:"B peer work",assignee_agent_id:PROJECT_B+':peer'},{agentToken:bot});
  expect(created.status).toBe(201); expect(created.body.card?.assignee_agent_id).toBe(PROJECT_A+':peer'); const cid=created.body.card!.id;
  const offered=await f.call(`/agent/cards/${cid}/negotiate`,{message_id:"public-b-proposal",card_id:cid,type:"proposal",terms:{scope:"B work"}},{agentToken:peer});
  expect(offered.status).toBe(201); const offer=offered.body as Proposal;
  const body={message_id:"public-b-commit",card_id:cid,type:"commit",...offer,proof:{by:PROJECT_B+':bot',alg:"HMAC-SHA256",value:await hmacSha256Base64Url('secret-b-bot',offer.terms_hash)}};
  expect((await f.call(`/agent/cards/${cid}/negotiate`,{...body,message_id:"wrong-project-commit",proof:{...body.proof,by:projectC+':bot'}},{agentToken:bot})).status).toBe(422);
  expect((await f.call(`/agent/cards/${cid}/negotiate`,body,{agentToken:bot})).status).toBe(201);
  expect((await f.call(`/agent/cards?project_id=${PROJECT_B}`,{title:"bad reference",assignee_agent_id:'prj_01ARZ3NDEKTSV4RRFFQ69G5FAX:peer'},{agentToken:bot})).status).toBe(400);
});
