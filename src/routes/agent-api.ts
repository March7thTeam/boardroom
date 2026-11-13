import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { constantTimeEqual, randomSecret, tokenHash } from "../lib/crypto";
import { HttpError } from "../lib/http-error";
import { commitAndPublish, findExistingEvent } from "../lib/event-store";
import { parseBody, parseIfMatch, parseLimit } from "../lib/http";
import { newId } from "../lib/ids";
import { addDaysIso, addMinutesIso, nowIso } from "../lib/time";
import {
  bearerToken,
  formatAgentToken,
  formatScopedAgentRef,
  parseAgentToken,
  parseEnrollmentToken,
  parseScopedAgentRef,
} from "../lib/tokens";
import { assertTransition } from "../domain/state-machine";
import { buildSelfDealBasis, classifySelfDeal, guardedSelfDealWrite, surveyCounterparties, type SelfDealBasis } from "../domain/solo";
import { AGENT_ONLINE_TTL_MINUTES, onlinePresenceSql, onlineSinceIso } from "../domain/presence";
import {
  buildContractReceipt,
  termsHash,
  verifyAcceptanceProof,
} from "../domain/negotiation";
import {
  evidenceHash,
  guardedCardWrite,
  normalizeEvidence,
  retireCardWork,
  parseExecTargets,
  selectExecTarget,
} from "../domain/execution";
import { verifyGithubActionsRun } from "../providers/github";
import { evaluateCriteria } from "../domain/verdict";
import { quotaPredicate } from "../domain/agent-quota";
import {
  allocateLocalSlug,
  assertAgentProjectAccess,
  resolveProjectAgentReference,
  getAgentProject,
  listAgentProjects,
  listLocalSlugs,
} from "../domain/agent-projects";
import { requireAgent } from "../middleware/agent";
import { listAgentCards } from "../lib/agent-cards";
import { registerAgent, joinAgentProject } from "../lib/agent-registration";
import type {
  AgentRow,
  AttemptRow,
  CardRow,
  ContractRow,
  NegotiationSessionRow,
  ProjectRow,
  ProposalRow,
} from "../types";

export const agentApiRoutes = new Hono<AppEnv>();

/**
 * 普通协商的轮次上限（与 cards.ts 的 ROUND_LIMIT 判定一致）。治理 `reset` 可以把
 * 卡片推到 6+ 轮，那时正常协商通道必须关闭，只剩管理员 `engage` 能推进。
 */
const NORMAL_ROUND_LIMIT = 5;

const registerSchema = z.object({
  id: z
    .string()
    .regex(
      /^(?:[a-z0-9][a-z0-9-]*|prj_[0-9A-HJKMNP-TV-Z]{26}):[a-z0-9][a-z0-9-]*$/,
      "id must be <project_id>:<slug> or <projectSlug>:<agentSlug>",
    ),
  harness: z.string().min(1).max(64),
  harness_version: z.string().min(1).max(64).default("unknown"),
  name: z.string().max(64).optional(),
  card: z
    .object({
      description: z.string().max(4000).optional(),
      skills: z
        .array(z.object({ key: z.string().min(1).max(64), level: z.enum(["basic", "normal", "expert"]).optional() }))
        .optional(),
      max_concurrency: z.number().int().min(1).max(16).optional(),
    })
    .optional(),
  rotate_token: z.boolean().default(false),
});

const criteriaSchema = z.array(
  z.object({
    key: z.string().min(1).max(80),
    op: z.enum(["eq", "gte", "lte", "matches", "exists"]),
    value: z.unknown().optional(),
    severity: z.enum(["block", "warn"]).optional(),
  }),
);

const createCardSchema = z.object({
  project_id: z.string().min(1).optional(),
  title: z.string().min(1).max(200),
  body: z.string().max(65536).optional(),
  priority: z.number().int().min(0).max(100).default(0),
  criteria: criteriaSchema.default([]),
  deadline_at: z.string().datetime().nullable().optional(),
  parent_card_id: z.string().nullable().optional(),
  assignee_agent_id: z.string().nullable().optional(),
});

const joinProjectSchema = z.object({
  enrollment_token: z.string().min(1),
});

const closeCardSchema = z.object({
  reason: z.string().min(8).max(2000),
});

const reopenCardSchema = z.object({
  reason: z.string().min(8).max(2000).optional(),
});

const negotiateSchema = z.object({
  message_id: z.string().min(8).max(80),
  type: z.enum(["inquiry", "proposal", "counter", "commit"]),
  card_id: z.string().min(1),
  session_id: z.string().min(1).optional(),
  terms: z.record(z.unknown()).optional(),
  terms_hash: z.string().min(8).max(80).optional(),
  need: z.record(z.unknown()).optional(),
  proof: z
    .object({
      by: z.string().min(1).max(120).optional(),
      alg: z.string().min(1).max(32),
      value: z.string().min(1).max(256),
    })
    .optional(),
});

function normalizeHarness(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]*(cli|agent)$/g, "")
    .replace(/\s+/g, "-");
}

function cleanName(raw: string | undefined): string | null {
  if (!raw) return null;
  const value = raw.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return value.length > 0 ? value.slice(0, 64) : null;
}

function versionConflict(expected: number, actual: number): never {
  throw new HttpError(409, "VERSION_CONFLICT", "card was modified by another actor", {
    expected_version: expected,
    actual_version: actual,
  });
}

/**
 * Load a card the agent may access through an active project membership.
 * `ownOnly` enforces the ownership rule: an agent may close/reopen only cards
 * it created (`created_by_type=agent` and `created_by_id=agent.id`).
 */
async function loadAgentCard(
  c: Context<AppEnv>,
  cardId: string,
  ownOnly: boolean,
): Promise<CardRow> {
  const agent = c.get("agent");
  const card = await c.env.DB.prepare("SELECT * FROM cards WHERE id = ?1").bind(cardId).first<CardRow>();
  if (!card) throw new HttpError(404, "NOT_FOUND", "card not found");
  // A credential bound to another project must not reveal this card exists.
  if (c.get("agentCredentialProject") !== card.project_id) throw new HttpError(404, "NOT_FOUND", "card not found");
  await assertAgentProjectAccess(c.env.DB, agent.id, card.project_id);
  if (ownOnly && (card.created_by_type !== "agent" || card.created_by_id !== agent.id)) {
    throw new HttpError(403, "FORBIDDEN", "agents can only close or reopen cards they created");
  }
  return card;
}

async function appendAgentCardEvent(
  c: Context<AppEnv>, card: CardRow, eventType: string, payload: unknown,
  messageId?: string, mutations: D1PreparedStatement | D1PreparedStatement[] = [],
  receipt: Record<string, unknown> = {},
  onConflict?: () => Promise<never>,
) {
  const result = await commitAndPublish(c, mutations, {
    projectId: card.project_id, cardId: card.id, eventType,
    actorType: "agent", actorId: c.get("agent").id, payload, messageId, receipt,
  }).catch((error: unknown) => {
    if (error instanceof Error && /UNIQUE constraint failed: negotiation_sessions\./i.test(error.message)) {
      throw new HttpError(409, "SESSION_BUSY", "another negotiation session is already active");
    }
    throw error;
  });
  if (!result) {
    if (onConflict) await onConflict();
    versionConflict(card.version, card.version + 1);
  }
  return { seq: result.seq, eventId: result.event_id, eventPending: result.event_pending,
    card: result.card!, receipt: result.receipt, ...(result.duplicate ? { duplicate: true } : {}) };
}

/**
 * 自交易的两道闸门，提案与接受两个入口共用。
 *
 * 调用方必须先确认这是自交易场景（发起者提案给自己、或接受自己的提案），
 * 因此这里把 actor 也当作 initiator 传进去，只走 classifySelfDeal 的 self 分支：
 * - 有在线对手方 → 409，code 由调用方指定（NOT_RESPONDER / SELF_COMMIT）；
 * - 对手方存在但全部离线 → 要求卡片已过冷静期，否则 409 SELF_DEAL_COOLDOWN；
 * - 项目里没有其他成员 → 直接放行（无人可等，不加等待）。
 */
async function assertSelfDealAllowed(
  c: Context<AppEnv>,
  card: CardRow,
  agentId: string,
  blockedCode: string,
  blockedMessage: string,
): Promise<SelfDealBasis> {
  const nowMs = Date.parse(nowIso());
  const survey = await surveyCounterparties(c.env.DB, card.project_id, agentId, nowMs);
  const decision = classifySelfDeal({
    initiatorAgentId: agentId,
    actorId: agentId,
    survey,
    cardCreatedAt: card.created_at,
    nowMs,
  });

  if (decision.kind === "blocked_online") {
    throw new HttpError(409, blockedCode, blockedMessage);
  }
  if (decision.kind === "blocked_cooldown") {
    throw new HttpError(
      409,
      "SELF_DEAL_COOLDOWN",
      `self-deal opens ${decision.cooldown_minutes} minutes after the card was created while other agents exist in this project`,
      {
        retry_after_seconds: decision.retry_after_seconds,
        cooldown_minutes: decision.cooldown_minutes,
      },
    );
  }
  if (decision.kind === "allowed") return buildSelfDealBasis(card.created_at, survey, decision, nowMs);
  throw new HttpError(409, "CONFLICT", "self-deal conditions changed; retry the negotiation");
}

/** Classification after a rejected transaction does not replace its SQL gate. */
function selfDealConflict(
  c: Context<AppEnv>, card: CardRow, agentId: string, blockedCode: string, blockedMessage: string,
): () => Promise<never> {
  return async () => {
    const current = await c.env.DB.prepare("SELECT * FROM cards WHERE id = ?1").bind(card.id).first<CardRow>();
    if (current?.status === "open") await assertSelfDealAllowed(c, current, agentId, blockedCode, blockedMessage);
    throw new HttpError(409, "CONFLICT", "self-deal conditions changed; retry the negotiation");
  };
}

/**
 * Resolve which project an agent call targets, honouring the credential scope:
 * a project-bound token defaults to its own project and refuses any other one.
 */
function scopedProjectId(c: Context<AppEnv>, requested: string | null | undefined): string {
  const scope = c.get("agentCredentialProject");
  if (requested && requested !== scope) {
    throw new HttpError(
      403,
      "CREDENTIAL_SCOPE_MISMATCH",
      "this agent token is bound to another project; use the token issued for the target project",
    );
  }
  return scope;
}

async function findExistingMessage(c: Context<AppEnv>, cardId: string, messageId: string): Promise<Record<string, unknown> | null> {
  return findExistingEvent(c, cardId, messageId);
}

async function findSession(
  db: D1Database,
  cardId: string,
  sessionId?: string,
): Promise<NegotiationSessionRow | null> {
  if (sessionId) {
    return db
      .prepare("SELECT * FROM negotiation_sessions WHERE id = ?1 AND card_id = ?2")
      .bind(sessionId, cardId)
      .first<NegotiationSessionRow>();
  }
  return db
    .prepare(
      "SELECT * FROM negotiation_sessions WHERE card_id = ?1 AND state = 'open' ORDER BY round DESC LIMIT 1",
    )
    .bind(cardId)
    .first<NegotiationSessionRow>();
}

async function latestProposal(
  db: D1Database,
  sessionId: string,
): Promise<ProposalRow | null> {
  return db
    .prepare("SELECT * FROM proposals WHERE session_id = ?1 ORDER BY seq_in_session DESC LIMIT 1")
    .bind(sessionId)
    .first<ProposalRow>();
}

function requireTerms(body: z.infer<typeof negotiateSchema>): Record<string, unknown> {
  if (!body.terms || typeof body.terms !== "object" || Array.isArray(body.terms)) {
    throw new HttpError(400, "INVALID_ARGUMENT", "terms object is required");
  }
  return body.terms;
}

function requestAgentSecret(c: Context<AppEnv>): string {
  const raw = bearerToken(c.req.raw);
  const parsed = raw ? parseAgentToken(raw) : null;
  if (!parsed) throw new HttpError(401, "UNAUTHENTICATED", "invalid agent token format");
  return parsed.secret;
}

const ticketSchema = z.object({
  provider: z.literal("github_actions").optional(),
  owner: z.string().min(1).max(80).optional(),
  repo: z.string().min(1).max(120).optional(),
  workflow: z.string().min(1).max(200).optional(),
  ref: z.string().min(1).max(120).optional(),
});

const runReportSchema = z.object({
  ticket_id: z.string().min(1).max(80),
  provider: z.literal("github_actions"),
  run: z.object({
    run_id: z.union([z.number().int().positive(), z.string().min(1).max(40)]),
    run_attempt: z.number().int().min(1).max(100),
    html_url: z.string().url().max(500),
  }),
  artifacts: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        sha256: z.string().min(8).max(128),
        size_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .max(50)
    .optional(),
  self_check: z
    .array(
      z.object({
        key: z.string().min(1).max(80),
        value: z.unknown(),
      }),
    )
    .max(100)
    .optional(),
});

const leaseSchema = z.object({
  ttl_minutes: z.number().int().min(5).max(240).optional(),
});

function callbackBase(c: Context<AppEnv>): string {
  return (c.env.APP_BASE_URL ?? new URL(c.req.url).origin).replace(/\/+$/, "");
}

function parseProviderRef(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

agentApiRoutes.post("/cards/:cid/negotiate", requireAgent, async (c) => {
  const agent = c.get("agent");
  const card = await loadAgentCard(c, c.req.param("cid"), false);
  const body = await parseBody(c, negotiateSchema);
  if (body.card_id !== card.id) {
    throw new HttpError(400, "INVALID_ARGUMENT", "card_id must match the URL card");
  }
  const duplicate = await findExistingMessage(c, card.id, body.message_id);
  if (duplicate) return c.json(duplicate, duplicate.event_pending ? 202 : 200);
  if (card.paused_at) {
    throw new HttpError(409, "CARD_PAUSED", "card is paused");
  }
  if (card.status !== "open") {
    throw new HttpError(409, "CARD_NOT_OPEN", "negotiation is only allowed while the card is open");
  }
  // 治理 `reset` 会把轮次推到 6+，此时必须关掉正常协商：普通 Agent 一旦开出
  // round 6 的 session，特权 `engage` 就会撞 NEGOTIATION_OPEN，低权限成员反而
  // 锁死了 reset 本要提供的治理兜底。`inquiry` 只是留言、不建 session，不拦；
  // 治理侧的合成 session 由 cards.ts 的 admin-action 自己建，不走这里。
  if (card.round > NORMAL_ROUND_LIMIT && body.type !== "inquiry") {
    throw new HttpError(409, "ROUND_LIMIT", "card has reached the maximum number of rounds", {
      round: card.round,
      normal_limit: NORMAL_ROUND_LIMIT,
    });
  }

  const now = nowIso();
  const requestId = c.get("requestId") ?? "req_unknown";

  if (body.type === "inquiry") {
    const { seq, eventId, eventPending } = await appendAgentCardEvent(
      c,
      card,
      "negotiation.inquiry",
      {
        type: "inquiry",
        need: body.need ?? null,
        terms_hash: body.terms_hash ?? null,
        status: card.status,
      },
      body.message_id,
      guardedCardWrite(c.env.DB, card, "UPDATE cards SET version = version WHERE id = ?1 AND /* current_card */", [card.id]),
      { status: card.status, type: "inquiry" },
    );
    return c.json(
      { event_id: eventId, seq, status: card.status, type: "inquiry", event_pending: eventPending },
      eventPending ? 202 : 201,
    );
  }

  let session = await findSession(c.env.DB, card.id, body.session_id);
  let sessionMutation: D1PreparedStatement | undefined;
  let selfProposalBasis: SelfDealBasis | null = null;
  const selfProposalBlocked = "the card requester cannot propose to itself while another agent is available in this project";

  if (!session && body.type === "proposal") {
    const initiatorAgentId =
      card.created_by_type === "agent"
        ? (card.requester_agent_id ?? card.created_by_id)
        : null;
    const initiatorUserId = card.created_by_type === "user" ? card.created_by_id : null;
    // Solo 例外：当前没有其他在线、可接单的 Agent 时，发起者可以对自己提案。
    // 有对手方在线时仍走 NOT_RESPONDER；对手方存在但全部离线时还要过冷静期。
    if (initiatorAgentId === agent.id) {
      selfProposalBasis = await assertSelfDealAllowed(
        c,
        card,
        agent.id,
        "NOT_RESPONDER",
        selfProposalBlocked,
      );
    }
    const sessionRow: NegotiationSessionRow = {
      id: newId("ns"),
      card_id: card.id,
      initiator_agent_id: initiatorAgentId,
      initiator_user_id: initiatorUserId,
      responder_agent_id: agent.id,
      round: card.round,
      state: "open",
      created_at: now,
      closed_at: null,
    };
      sessionMutation = guardedSelfDealWrite(c.env.DB, card, agent.id, selfProposalBasis,
        `INSERT INTO negotiation_sessions
           (id, card_id, initiator_agent_id, initiator_user_id, responder_agent_id, round, state, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7 WHERE /* current_card */`,
        [
          sessionRow.id,
          sessionRow.card_id,
          sessionRow.initiator_agent_id,
          sessionRow.initiator_user_id,
          sessionRow.responder_agent_id,
          sessionRow.round,
          sessionRow.created_at,
        ]);
      session = sessionRow;
  }

  if (!session) {
    throw new HttpError(404, "SESSION_NOT_FOUND", "no open negotiation session for this card");
  }
  if (session.state !== "open" || session.round !== card.round) {
    throw new HttpError(409, "SESSION_BUSY", "negotiation session is no longer open in the current round");
  }
  if (session.initiator_agent_id !== agent.id && session.responder_agent_id !== agent.id) {
    throw new HttpError(403, "FORBIDDEN", "agent is not a participant in this negotiation");
  }

  if (body.type === "proposal" || body.type === "counter") {
    if (body.type === "proposal" && session.responder_agent_id !== agent.id) {
      throw new HttpError(409, "NOT_RESPONDER", "only the responder can submit the first proposal");
    }
    if (body.type === "proposal" && session.initiator_agent_id === agent.id && !selfProposalBasis) {
      selfProposalBasis = await assertSelfDealAllowed(c, card, agent.id, "NOT_RESPONDER", selfProposalBlocked);
    }
    const terms = requireTerms(body);
    const hash = await termsHash(terms);
    if (body.terms_hash && body.terms_hash !== hash) {
      throw new HttpError(422, "TERMS_HASH_MISMATCH", "terms_hash does not match the submitted terms");
    }

    const previous = await latestProposal(c.env.DB, session.id);
    if (body.type === "proposal" && previous) {
      throw new HttpError(409, "PROPOSAL_EXISTS", "use counter to revise an existing proposal");
    }
    if (body.type === "counter" && !previous) {
      throw new HttpError(409, "PROPOSAL_NOT_FOUND", "no proposal to counter");
    }

    const proposalId = newId("pp");
    const seqInSession = (previous?.seq_in_session ?? 0) + 1;
    const statements = [
      ...(sessionMutation ? [sessionMutation] : []),
      guardedSelfDealWrite(c.env.DB, card, agent.id, selfProposalBasis,
        `INSERT INTO proposals
           (id, session_id, from_agent_id, seq_in_session, terms_json, terms_hash, status, supersedes_id, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'offered', ?7, ?8
          WHERE /* current_card */
            AND EXISTS (SELECT 1 FROM negotiation_sessions WHERE id = ?2 AND state = 'open' AND round = ?9)
            AND COALESCE((SELECT MAX(seq_in_session) FROM proposals WHERE session_id = ?2), 0) = ?10`,
      [
        proposalId,
        session.id,
        agent.id,
        seqInSession,
        JSON.stringify(terms),
        hash,
        previous?.id ?? null,
        now,
        card.round,
        previous?.seq_in_session ?? 0,
      ]),
    ];
    if (previous) {
      statements.push(
        c.env.DB.prepare("UPDATE proposals SET status = 'countered' WHERE id = ?1 AND EXISTS (SELECT 1 FROM proposals WHERE id = ?2)").bind(previous.id, proposalId),
      );
    }
    const { seq, eventId, eventPending, receipt: eventReceipt } = await appendAgentCardEvent(
      c,
      card,
      body.type === "counter" ? "negotiation.counter" : "negotiation.proposal",
      {
        type: body.type,
        session_id: session.id,
        proposal_id: proposalId,
        seq_in_session: seqInSession,
        terms_hash: hash,
        status: card.status,
        ...(selfProposalBasis ? { self_deal: true, self_deal_basis: selfProposalBasis } : {}),
      },
      body.message_id,
      statements,
      { session_id: session.id, proposal_id: proposalId, terms_hash: hash, status: card.status,
        ...(selfProposalBasis ? { self_deal: true, self_deal_basis: selfProposalBasis } : {}) },
      selfProposalBasis ? selfDealConflict(c, card, agent.id, "NOT_RESPONDER", selfProposalBlocked) : undefined,
    );
    return c.json(
      {
        event_id: eventId,
        seq,
        session_id: session.id,
        proposal_id: proposalId,
        terms_hash: hash,
        status: card.status,
        ...eventReceipt, event_pending: eventPending,
      },
      eventPending ? 202 : 201,
    );
  }

  if (body.type === "commit") {
    if (session.initiator_user_id) {
      throw new HttpError(
        409,
        "HUMAN_ACCEPT_REQUIRED",
        "human-created cards must be accepted through POST /api/v1/cards/:cid/commit",
      );
    }
    if (session.initiator_agent_id !== agent.id) {
      throw new HttpError(409, "NOT_ACCEPTOR", "only the requester can commit to a proposal");
    }
    const proposal = await latestProposal(c.env.DB, session.id);
    if (!proposal || proposal.status !== "offered") {
      throw new HttpError(409, "PROPOSAL_NOT_FOUND", "no open proposal to commit");
    }
    // Solo 例外：当前没有其他在线、可接单的 Agent 时允许接受自己的提案，
    // 契约的 proposer 与 acceptor 会是同一 Agent，事件带 self_deal 与判定依据。
    let selfDeal = false;
    let selfDealBasis: SelfDealBasis | null = null;
    const selfCommitBlocked = "an agent cannot accept its own proposal while another agent is available in this project";
    if (proposal.from_agent_id === agent.id) {
      selfDealBasis = await assertSelfDealAllowed(
        c,
        card,
        agent.id,
        "SELF_COMMIT",
        selfCommitBlocked,
      );
      selfDeal = true;
    }

    const providedHash = body.terms_hash ?? proposal.terms_hash;
    if (providedHash !== proposal.terms_hash) {
      throw new HttpError(422, "TERMS_HASH_MISMATCH", "terms_hash does not match the latest proposal");
    }
    if (body.terms) {
      const computed = await termsHash(body.terms);
      if (computed !== proposal.terms_hash) {
        throw new HttpError(422, "TERMS_HASH_MISMATCH", "terms do not match the latest proposal");
      }
    }

    const secret = requestAgentSecret(c);
    let proof = body.proof;
    if (proof?.by) {
      const signer = await resolveProjectAgentReference(c.env.DB, card.project_id, proof.by);
      if (signer !== agent.id) throw new HttpError(422, "INVALID_PROOF", "acceptance proof signer is not the authenticated agent");
      proof = { ...proof, by: agent.id };
    }
    if (!(await verifyAcceptanceProof(secret, proposal.terms_hash, proof, agent.id))) {
      throw new HttpError(422, "INVALID_PROOF", "acceptance proof is missing or invalid");
    }

    const activeContract = await c.env.DB.prepare(
      "SELECT id FROM contracts WHERE card_id = ?1 AND state = 'active'",
    )
      .bind(card.id)
      .first<{ id: string }>();
    if (activeContract) {
      throw new HttpError(409, "CONTRACT_CONFLICT", "an active contract already exists for this card");
    }

    const contractId = newId("ct");
    const receipt = buildContractReceipt({
      actorType: "agent",
      actorId: agent.id,
      termsHash: proposal.terms_hash,
      requestId,
      proof: body.proof,
    });

    const mutations = [
        guardedSelfDealWrite(c.env.DB, card, agent.id, selfDealBasis,
          `INSERT INTO contracts
             (id, card_id, session_id, proposer_agent_id, acceptor_agent_id, terms_json, terms_hash,
              acceptance_proof_json, state, version, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', 1, ?9
            WHERE /* current_card */
              AND EXISTS (SELECT 1 FROM negotiation_sessions WHERE id = ?3 AND state = 'open' AND round = ?10)
              AND EXISTS (SELECT 1 FROM proposals WHERE id = ?11 AND status = 'offered'
                AND seq_in_session = (SELECT MAX(seq_in_session) FROM proposals WHERE session_id = ?3))`,
        [
          contractId,
          card.id,
          session.id,
          proposal.from_agent_id,
          agent.id,
          proposal.terms_json,
          proposal.terms_hash,
          JSON.stringify(receipt),
          now,
          card.round,
          proposal.id,
        ]),
        c.env.DB.prepare(
          "UPDATE proposals SET status = 'accepted' WHERE id = ?1 AND EXISTS (SELECT 1 FROM contracts WHERE id = ?2)",
        ).bind(proposal.id, contractId),
        c.env.DB.prepare(
          "UPDATE negotiation_sessions SET state = 'committed', closed_at = ?1 WHERE id = ?2 AND EXISTS (SELECT 1 FROM contracts WHERE id = ?3)",
        ).bind(now, session.id, contractId),
        c.env.DB.prepare(
          `UPDATE cards SET status = 'engaged', outcome = NULL, assignee_agent_id = ?1,
            assignee_user_id = NULL, version = version + 1, updated_at = ?2
           WHERE id = ?3 AND EXISTS (SELECT 1 FROM contracts WHERE id = ?4)`,
        ).bind(proposal.from_agent_id, now, card.id, contractId),
    ];

    const { seq, eventId, eventPending, receipt: eventReceipt } = await appendAgentCardEvent(
      c,
      { ...card, status: "engaged", assignee_agent_id: proposal.from_agent_id },
      "card.committed",
      {
        type: "commit",
        from: card.status,
        to: "engaged",
        session_id: session.id,
        proposal_id: proposal.id,
        contract_id: contractId,
        terms_hash: proposal.terms_hash,
        status: "engaged",
        self_deal: selfDeal,
        ...(selfDealBasis ? { self_deal_basis: selfDealBasis } : {}),
      },
      body.message_id, mutations,
      { session_id: session.id, proposal_id: proposal.id, contract_id: contractId, terms_hash: proposal.terms_hash,
        status: "engaged", self_deal: selfDeal, ...(selfDealBasis ? { self_deal_basis: selfDealBasis } : {}) },
      selfDealBasis ? selfDealConflict(c, card, agent.id, "SELF_COMMIT", selfCommitBlocked) : undefined,
    );
    return c.json(
      {
        event_id: eventId,
        seq,
        session_id: session.id,
        proposal_id: proposal.id,
        contract_id: contractId,
        terms_hash: proposal.terms_hash,
        status: "engaged",
        self_deal: selfDeal,
        ...eventReceipt, event_pending: eventPending,
      },
      eventPending ? 202 : 201,
    );
  }

  throw new HttpError(400, "INVALID_ARGUMENT", "unsupported negotiation message");
});

function parseTermsJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Read the negotiation state of a card. The requester needs the latest
 * `terms_hash` to build its acceptance proof, and no other agent endpoint
 * exposes it; without this read the agent-created card can never be accepted.
 * An existing session is only visible to its two participants.
 */
agentApiRoutes.get("/cards/:cid/negotiation", requireAgent, async (c) => {
  const agent = c.get("agent");
  const card = await loadAgentCard(c, c.req.param("cid"), false);
  const session = await c.env.DB.prepare(
    "SELECT * FROM negotiation_sessions WHERE card_id = ?1 ORDER BY round DESC LIMIT 1",
  )
    .bind(card.id)
    .first<NegotiationSessionRow>();

  if (!session) {
    return c.json({
      card_id: card.id,
      card_status: card.status,
      session: null,
      proposals: [],
      latest_proposal: null,
      contract: null,
    });
  }
  if (session.initiator_agent_id !== agent.id && session.responder_agent_id !== agent.id) {
    throw new HttpError(403, "FORBIDDEN", "agent is not a participant in this negotiation");
  }

  const [proposals, contract] = await Promise.all([
    c.env.DB.prepare(
      "SELECT * FROM proposals WHERE session_id = ?1 ORDER BY seq_in_session ASC",
    )
      .bind(session.id)
      .all<ProposalRow>(),
    c.env.DB.prepare(
      "SELECT * FROM contracts WHERE card_id = ?1 ORDER BY created_at DESC LIMIT 1",
    )
      .bind(card.id)
      .first<ContractRow>(),
  ]);

  const items = proposals.results.map((proposal) => ({
    id: proposal.id,
    session_id: proposal.session_id,
    from_agent_id: proposal.from_agent_id,
    seq_in_session: proposal.seq_in_session,
    terms: parseTermsJson(proposal.terms_json),
    terms_hash: proposal.terms_hash,
    status: proposal.status,
    supersedes_id: proposal.supersedes_id,
    created_at: proposal.created_at,
  }));

  return c.json({
    card_id: card.id,
    card_status: card.status,
    session,
    proposals: items,
    latest_proposal: items.length > 0 ? items[items.length - 1] : null,
    contract,
  });
});

agentApiRoutes.post("/cards/:cid/tickets", requireAgent, async (c) => {
  const agent = c.get("agent");
  const card = await loadAgentCard(c, c.req.param("cid"), false);
  const body = await parseBody(c, ticketSchema);

  if (card.paused_at) throw new HttpError(409, "CARD_PAUSED", "card is paused");
  if (card.status !== "engaged") {
    throw new HttpError(409, "CARD_NOT_ENGAGED", "tickets can only be issued for engaged cards");
  }
  if (card.assignee_agent_id !== agent.id) {
    throw new HttpError(403, "FORBIDDEN", "only the assigned agent can request a ticket");
  }

  const contract = await c.env.DB.prepare(
    "SELECT * FROM contracts WHERE card_id = ?1 AND state = 'active'",
  )
    .bind(card.id)
    .first<ContractRow>();
  if (!contract) {
    throw new HttpError(409, "CONTRACT_REQUIRED", "card has no active contract");
  }

  const project = await c.env.DB.prepare("SELECT exec_targets_json FROM projects WHERE id = ?1")
    .bind(card.project_id)
    .first<{ exec_targets_json: string }>();
  const targets = parseExecTargets(project?.exec_targets_json);
  const selected = selectExecTarget(targets, body.owner, body.repo, body.workflow);
  if (!selected) {
    throw new HttpError(
      409,
      "EXEC_TARGET_NOT_CONFIGURED",
      "no matching execution target is configured for this project",
    );
  }

  const activeAttempt = await c.env.DB.prepare(
    "SELECT id FROM attempts WHERE card_id = ?1 AND status IN ('issued','running')",
  )
    .bind(card.id)
    .first<{ id: string }>();
  if (activeAttempt) {
    throw new HttpError(409, "TICKET_ACTIVE", "an active ticket already exists for this card");
  }

  const maxAttempt = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(attempt_no), 0) AS attempt_no FROM attempts WHERE card_id = ?1",
  )
    .bind(card.id)
    .first<{ attempt_no: number }>();
  const attemptNo = (maxAttempt?.attempt_no ?? 0) + 1;
  const ticketId = newId("att");
  const nonce = randomSecret(18);
  const now = nowIso();
  const expiresAt = addMinutesIso(10);
  const ref = body.ref ?? "main";
  const providerRef = {
    owner: selected.target.owner,
    repo: selected.target.repo,
    workflow: selected.workflow,
    ref,
    expires_at: expiresAt,
  };

  const ticketWrite = guardedCardWrite(c.env.DB, card,
    `INSERT INTO attempts
       (id, card_id, contract_id, agent_id, attempt_no, status, ticket_nonce, provider, provider_ref, started_at)
     SELECT ?1, ?2, ?3, ?4, ?5, 'issued', ?6, ?7, ?8, ?9
      WHERE /* current_card */ AND EXISTS (SELECT 1 FROM contracts WHERE id = ?3 AND state = 'active')
        AND NOT EXISTS (SELECT 1 FROM attempts WHERE card_id = ?2 AND status IN ('issued','running'))`,
    [
      ticketId,
      card.id,
      contract.id,
      agent.id,
      attemptNo,
      nonce,
      "github_actions",
      JSON.stringify(providerRef),
      now,
    ]);
  const mutations = [
    ticketWrite,
    c.env.DB.prepare(
      `UPDATE cards SET status = 'running', version = version + 1, updated_at = ?1
        WHERE id = ?2 AND EXISTS (SELECT 1 FROM attempts WHERE id = ?3)`,
    ).bind(now, card.id, ticketId),
  ];

  const ticketReceipt = {
    ticket_id: ticketId, card_id: card.id, attempt_no: attemptNo, provider: "github_actions",
    target: { owner: selected.target.owner, repo: selected.target.repo, workflow: selected.workflow, ref },
    inputs: { card_id: card.id, terms_hash: contract.terms_hash, nonce, ref },
    callback: `${callbackBase(c)}/agent/cards/${encodeURIComponent(card.id)}/runs`,
    expires_at: expiresAt, ticket_nonce: nonce,
  };
  const { seq, eventId, eventPending, receipt } = await appendAgentCardEvent(
    c,
    { ...card, status: "running" },
    "ticket.issued",
    {
      attempt_id: ticketId,
      attempt_no: attemptNo,
      provider: "github_actions",
      target: providerRef,
      expires_at: expiresAt,
      terms_hash: contract.terms_hash,
    },
    `ticket:${ticketId}`, mutations, ticketReceipt,
  );

  return c.json({ ...receipt, seq, event_id: eventId, event_pending: eventPending }, eventPending ? 202 : 201);
});

agentApiRoutes.post("/cards/:cid/runs", requireAgent, async (c) => {
  const agent = c.get("agent");
  const card = await loadAgentCard(c, c.req.param("cid"), false);
  const body = await parseBody(c, runReportSchema);

  const attempt = await c.env.DB.prepare(
    "SELECT * FROM attempts WHERE id = ?1 AND card_id = ?2 AND agent_id = ?3",
  )
    .bind(body.ticket_id, card.id, agent.id)
    .first<AttemptRow>();
  if (!attempt) {
    throw new HttpError(404, "TICKET_NOT_FOUND", "ticket not found for this card and agent");
  }
  // A published receipt remains replayable after this ticket has completed,
  // even if the card has entered review or started a later execution.
  const messageId = `run:${body.ticket_id}`;
  const duplicate = await findExistingMessage(c, card.id, messageId);
  if (duplicate) return c.json(duplicate, duplicate.event_pending ? 202 : 200);

  if (card.paused_at) throw new HttpError(409, "CARD_PAUSED", "card is paused");
  if (card.status !== "running") {
    throw new HttpError(409, "CARD_NOT_RUNNING", "runs can only be reported while the card is running");
  }
  if (card.assignee_agent_id !== agent.id) {
    throw new HttpError(403, "FORBIDDEN", "only the assigned agent can report runs");
  }
  if (attempt.status !== "issued" && attempt.status !== "running") {
    throw new HttpError(409, "TICKET_CONSUMED", "ticket has already been used");
  }
  if (attempt.provider !== body.provider) {
    throw new HttpError(400, "INVALID_ARGUMENT", "provider does not match the issued ticket");
  }

  const providerRef = parseProviderRef(attempt.provider_ref);
  const target = {
    owner: String(providerRef.owner ?? ""),
    repo: String(providerRef.repo ?? ""),
    workflow: String(providerRef.workflow ?? ""),
    ref: String(providerRef.ref ?? "main"),
  };
  if (!target.owner || !target.repo || !target.workflow) {
    throw new HttpError(409, "TICKET_INVALID", "ticket target is missing");
  }
  const expiresAt = String(providerRef.expires_at ?? "");
  const now = nowIso();
  async function expireTicket(): Promise<Response> {
    const mutations = [
      guardedCardWrite(c.env.DB, card,
        "UPDATE attempts SET status = 'abandoned', ended_at = ?1 WHERE id = ?2 AND /* current_card */",
        [nowIso(), attempt!.id]),
      guardedCardWrite(c.env.DB, card,
        `UPDATE cards SET status = 'engaged', version = version + 1, updated_at = ?1,
          lease_owner = NULL, lease_expires_at = NULL
          WHERE id = ?2 AND /* current_card */`, [nowIso(), card.id]),
    ];
    const result = await appendAgentCardEvent(
      c,
      { ...card, status: "engaged" },
      "ticket.expired",
      { attempt_id: attempt!.id, expires_at: expiresAt },
      messageId, mutations,
      { attempt_id: attempt!.id, status: "engaged", outcome: null, auto_closed: false, error_code: "TICKET_EXPIRED" },
    );
    if (result.eventPending) return c.json({ ...result.receipt, seq: result.seq, event_id: result.eventId, event_pending: true }, 202);
    throw new HttpError(409, "TICKET_EXPIRED", "ticket has expired");
  }
  if (!expiresAt || new Date(expiresAt).getTime() <= Date.now()) return expireTicket();

  // A report with no declared artifact would move the card into `review` with
  // zero evidence rows, where `POST /api/v1/cards/:cid/verify` can only answer
  // 409 EVIDENCE_REQUIRED. Reject it here so the card stays `running` and the
  // assignee can re-report within the ticket window instead of parking an
  // unverifiable card.
  const artifacts = normalizeEvidence((body.artifacts ?? []).map((artifact) => ({ ...artifact, kind: "artifact" as const })));
  if (artifacts.length === 0) {
    throw new HttpError(
      422,
      "EVIDENCE_REQUIRED",
      "a run report must declare at least one artifact",
    );
  }

  const storedEvidence = await c.env.DB.prepare(
    `SELECT kind, sha256, size_bytes FROM evidence WHERE card_id = ?1 AND kind = 'artifact'
      AND sha256 IN (${artifacts.map((_, i) => `?${i + 2}`).join(",")})`,
  ).bind(card.id, ...artifacts.map((item) => item.sha256)).all<{ kind: string; sha256: string; size_bytes: number }>();
  normalizeEvidence([...artifacts, ...storedEvidence.results]);

  const verify = await verifyGithubActionsRun(c.env, {
    target,
    runUrl: body.run.html_url,
    runId: body.run.run_id,
    runAttempt: body.run.run_attempt,
    issuedAt: attempt.started_at,
  });

  // GitHub is an external await. A pause, reassignment, sweep, or new ticket
  // may have completed since the original read; never adopt that new state.
  const current = await c.env.DB.prepare("SELECT * FROM cards WHERE id = ?1").bind(card.id).first<CardRow>();
  if (!current || current.version !== card.version || current.status !== "running" || current.paused_at || current.assignee_agent_id !== agent.id) {
    versionConflict(card.version, current?.version ?? card.version + 1);
  }
  const liveAttempt = await c.env.DB.prepare(
    `SELECT a.id FROM attempts a JOIN contracts ct ON ct.id = a.contract_id
      WHERE a.id = ?1 AND a.status IN ('issued','running') AND ct.state = 'active'
        AND ct.card_id = ?2`,
  ).bind(attempt.id, card.id).first();
  if (!liveAttempt) throw new HttpError(409, "TICKET_CONSUMED", "ticket or contract is no longer active");
  if (new Date(expiresAt).getTime() <= Date.now()) return expireTicket();

  if (!verify.ok && verify.result === "unverifiable") {
    throw new HttpError(
      503,
      "RUN_UNVERIFIABLE",
      verify.error ?? "unable to verify the run with GitHub",
    );
  }

  if (!verify.ok || !verify.run) {
    const mutations = [
      guardedCardWrite(c.env.DB, card,
        `UPDATE attempts SET status = 'failed', run_url = ?1, verify_result = ?2,
                error_code = ?2, ended_at = ?3
          WHERE id = ?4 AND /* current_card */`,
      [body.run.html_url, verify.result, now, attempt.id]),
      guardedCardWrite(c.env.DB, card,
        `UPDATE cards SET status = 'engaged', version = version + 1,
                lease_owner = NULL, lease_expires_at = NULL, updated_at = ?1
          WHERE id = ?2 AND /* current_card */`, [now, card.id]),
    ];
    const result = await appendAgentCardEvent(
      c,
      { ...card, status: "engaged" },
      "run.unverified",
      {
        attempt_id: attempt.id,
        status: "engaged",
        outcome: null,
        auto_closed: false,
        verify_result: verify.result,
        error: verify.error ?? null,
        run_url: body.run.html_url,
      },
      messageId, mutations,
      { attempt_id: attempt.id, status: "engaged", outcome: null, auto_closed: false,
        verify_result: verify.result, error_code: "RUN_VERIFICATION_FAILED" },
    );
    if (result.eventPending) return c.json({ ...result.receipt, seq: result.seq, event_id: result.eventId, event_pending: true }, 202);
    throw new HttpError(
      422,
      "RUN_VERIFICATION_FAILED",
      verify.error ?? "run verification failed",
      { verify_result: verify.result },
    );
  }

  const evidenceItems = artifacts.map((artifact) => ({
    kind: "artifact" as const,
    name: artifact.name,
    sha256: artifact.sha256,
    size_bytes: artifact.size_bytes,
  }));
  const digest = await evidenceHash(evidenceItems);
  const evidenceStatements = evidenceItems.map((artifact) =>
    guardedCardWrite(c.env.DB, card,
      `INSERT OR IGNORE INTO evidence
         (id, card_id, attempt_id, kind, sha256, size_bytes, summary, produced_by, created_at)
       SELECT ?1, ?2, ?3, 'artifact', ?4, ?5, ?6, ?7, ?8 WHERE /* current_card */`,
    [
      newId("ev"),
      card.id,
      attempt.id,
      artifact.sha256,
      artifact.size_bytes,
      artifact.name,
      agent.id,
      now,
    ]),
  );

  const updatedProviderRef = {
    ...providerRef,
    run_id: verify.run.id,
    run_attempt: verify.run.run_attempt,
    html_url: verify.run.html_url,
    head_sha: verify.run.head_sha,
  };

  const project = await c.env.DB.prepare("SELECT verification_mode FROM projects WHERE id = ?1")
    .bind(card.project_id)
    .first<{ verification_mode: "human" | "rule" }>();
  const evaluation = evaluateCriteria(card.criteria_json, body.self_check);
  const autoClose =
    project?.verification_mode === "rule" && evaluation.pass && evidenceItems.length > 0;
  const nextStatus = autoClose ? "closed" : "review";

  const cardStatement = autoClose
    ? guardedCardWrite(c.env.DB, card,
        `UPDATE cards SET status = 'closed', outcome = 'done', verifier_id = 'system:rule',
                verdict_reasons_json = ?1, evidence_hash = ?2, version = version + 1,
                lease_owner = NULL, lease_expires_at = NULL, updated_at = ?3
          WHERE id = ?4 AND /* current_card */`,
      [JSON.stringify(evaluation), digest, now, card.id])
    : guardedCardWrite(c.env.DB, card,
        `UPDATE cards SET status = 'review', evidence_hash = ?1, version = version + 1,
                lease_owner = NULL, lease_expires_at = NULL, updated_at = ?2
          WHERE id = ?3 AND /* current_card */`, [digest, now, card.id]);

  const statements = [
    ...evidenceStatements,
    guardedCardWrite(c.env.DB, card,
      `UPDATE attempts SET status = 'succeeded', run_url = ?1, head_sha = ?2,
              verify_result = 'ok', verified_at = ?3, provider_ref = ?4, ended_at = ?3
        WHERE id = ?5 AND /* current_card */`,
    [
      verify.run.html_url,
      verify.run.head_sha,
      now,
      JSON.stringify(updatedProviderRef),
      attempt.id,
    ]),
  ];
  if (autoClose) {
    statements.push(
      guardedCardWrite(c.env.DB, card,
        "UPDATE contracts SET state = 'fulfilled', closed_at = ?1 WHERE id = ?2 AND state = 'active' AND /* current_card */",
        [now, attempt.contract_id]),
    );
  }

  const { seq, eventId, eventPending, receipt } = await appendAgentCardEvent(
    c,
    { ...card, status: nextStatus, evidence_hash: digest },
    autoClose ? "card.verdict" : "run.verified",
    {
      attempt_id: attempt.id,
      status: nextStatus,
      outcome: autoClose ? "done" : null,
      auto_closed: autoClose,
      verify_result: "ok",
      run_url: verify.run.html_url,
      head_sha: verify.run.head_sha,
      evidence_hash: digest,
      artifacts: evidenceItems.map(({ kind, sha256, size_bytes }) => ({ kind, sha256, size_bytes })),
      self_check: body.self_check ?? [],
      ...(autoClose
        ? {
            from: "running",
            to: "closed",
            outcome: "done",
            verdict: "pass",
            self_reported: true,
            reasons: evaluation.reasons,
            rule_version: "criteria-v1",
          }
        : {}),
    },
    messageId, [...statements, cardStatement],
    { attempt_id: attempt.id, status: nextStatus, outcome: autoClose ? "done" : null,
      verify_result: "ok", evidence_hash: digest, auto_closed: autoClose },
  );

  return c.json({ ...receipt, seq, event_id: eventId, event_pending: eventPending }, eventPending ? 202 : 201);
});

agentApiRoutes.post("/cards/:cid/lease", requireAgent, async (c) => {
  const agent = c.get("agent");
  const card = await loadAgentCard(c, c.req.param("cid"), false);
  const body = await parseBody(c, leaseSchema);
  if (card.paused_at) throw new HttpError(409, "CARD_PAUSED", "card is paused");
  if (card.status !== "engaged" && card.status !== "running") {
    throw new HttpError(409, "CARD_NOT_LEASABLE", "lease requires an engaged or running card");
  }
  if (card.assignee_agent_id !== agent.id) {
    throw new HttpError(403, "FORBIDDEN", "only the assigned agent can hold a lease");
  }

  const now = nowIso();
  const ttl = body.ttl_minutes ?? 60;
  const expiresAt = addMinutesIso(ttl);
  const wasActive =
    card.lease_owner === agent.id &&
    card.lease_expires_at !== null &&
    new Date(card.lease_expires_at).getTime() > Date.now();

  const mutation = guardedCardWrite(c.env.DB, card,
    `UPDATE cards SET lease_owner = ?1, lease_expires_at = ?2
      WHERE id = ?3 AND assignee_agent_id = ?4 AND status IN ('engaged','running')
        AND paused_at IS NULL AND /* current_card */`,
    [agent.id, expiresAt, card.id, agent.id]);
  const { seq, eventId, eventPending } = await appendAgentCardEvent(c, card, wasActive ? "lease.renewed" : "lease.acquired", {
    lease_owner: agent.id, lease_expires_at: expiresAt,
  }, undefined, mutation);
  return c.json({ lease_owner: agent.id, lease_expires_at: expiresAt, seq, event_id: eventId,
    event_pending: eventPending }, eventPending ? 202 : wasActive ? 200 : 201);
});

agentApiRoutes.delete("/cards/:cid/lease", requireAgent, async (c) => {
  const agent = c.get("agent");
  const card = await loadAgentCard(c, c.req.param("cid"), false);
  if (card.lease_owner && card.lease_owner !== agent.id) {
    throw new HttpError(403, "FORBIDDEN", "lease is held by another agent");
  }
  if (!card.lease_owner) {
    return c.json({ ok: true, released: false });
  }
  const mutation = guardedCardWrite(c.env.DB, card,
    `UPDATE cards SET lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ?1 AND lease_owner = ?2 AND lease_expires_at IS ?3 AND /* current_card */`,
    [card.id, agent.id, card.lease_expires_at]);
  const { seq, eventId, eventPending } = await appendAgentCardEvent(c, card, "lease.released", {
    lease_owner: agent.id,
  }, undefined, mutation);
  return c.json({ ok: true, released: true, seq, event_id: eventId, event_pending: eventPending }, eventPending ? 202 : 200);
});

agentApiRoutes.post("/register", async (c) => {
  return c.json(await registerAgent(c, await parseBody(c, registerSchema)));
});

agentApiRoutes.post("/projects", requireAgent, async (c) => {
  const result = await joinAgentProject(c, await parseBody(c, joinProjectSchema));
  return c.json(result.body, result.status);
});

agentApiRoutes.get("/me", requireAgent, async (c) => {
  const agent = c.get("agent");
  const memberships = await listAgentProjects(c.env.DB, agent.id);
  const projects = memberships
    .filter((row) => row.archived_at === null)
    .map((row) => ({
      id: row.project_id,
      slug: row.slug,
      name: row.name,
      status: row.status,
      local_slug: row.local_slug,
      agent_id: row.local_slug ? formatScopedAgentRef(row.project_id, row.local_slug) : null,
      assigned_at: row.assigned_at,
    }));
  const project = await c.env.DB.prepare(
    "SELECT id, slug, name, verification_mode FROM projects WHERE id = ?1",
  )
    .bind(agent.project_id)
    .first<{ id: string; slug: string; name: string; verification_mode: string }>();
  const token = await c.env.DB.prepare(
    "SELECT expires_at FROM agent_tokens WHERE agent_id = ?1 AND project_id = ?2 AND revoked_at IS NULL ORDER BY version DESC LIMIT 1",
  )
    .bind(agent.id, agent.project_id)
    .first<{ expires_at: string }>();
  const peers = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM agent_projects ap
       JOIN projects p ON p.id = ap.project_id
      WHERE ap.project_id = ?1 AND ap.status = 'active' AND p.archived_at IS NULL`,
  )
    .bind(agent.project_id)
    .first<{ count: number }>();

  return c.json({
    agent: {
      id: formatScopedAgentRef(agent.project_id, agent.slug),
      internal_id: agent.id,
      project_id: agent.project_id,
      slug: agent.slug,
      status: agent.status,
      harness: agent.harness,
      harness_version: agent.harness_version,
      max_concurrency: agent.max_concurrency,
      token_version: agent.token_version,
      token_expires_at: token?.expires_at ?? null,
      // 最近一次成功记录的全局认证心跳；最佳努力写入失败时可能仍为空。
      last_seen_at: agent.last_seen_at,
    },
    project,
    projects,
    peers: peers?.count ?? 0,
  });
});

agentApiRoutes.get("/peers", requireAgent, async (c) => {
  const agent = c.get("agent");
  const projectId = scopedProjectId(c, c.req.query("project_id"));
  await assertAgentProjectAccess(c.env.DB, agent.id, projectId);
  const nowMs = Date.parse(nowIso());
  const rows = await c.env.DB.prepare(
    `SELECT ap.project_id || ':' || ap.local_slug AS id, ap.local_slug AS slug, a.harness, a.harness_version, a.max_concurrency, ap.status,
            a.last_seen_at,
            CASE WHEN ${onlinePresenceSql("?1", "?2", "?3")} THEN 1 ELSE 0 END AS online,
            COALESCE(NULLIF(ap.display_name,''), NULLIF(a.display_name,''), NULLIF(a.self_reported_name,''), ap.local_slug, a.harness || ' agent') AS resolved_name
       FROM agent_projects ap
       JOIN agents a ON a.id = ap.agent_id
      WHERE ap.project_id = ?1 AND ap.status = 'active'
      ORDER BY ap.assigned_at ASC`,
  )
    .bind(projectId, onlineSinceIso(nowMs), new Date(nowMs).toISOString())
    .all<{
      id: string;
      slug: string;
      harness: string;
      harness_version: string;
      max_concurrency: number;
      status: string;
      last_seen_at: string | null;
      online: number;
      resolved_name: string;
    }>();
  // online 与自交易放行共用同一判定口径，便于解释"为什么允许自己接自己的卡"。
  return c.json({
    project_id: projectId,
    online_ttl_minutes: AGENT_ONLINE_TTL_MINUTES,
    peers: rows.results.map((peer) => ({ ...peer, online: peer.online === 1 })),
  });
});

agentApiRoutes.post("/cards", requireAgent, async (c) => {
  const agent = c.get("agent");
  const body = await parseBody(c, createCardSchema);
  const project = await assertAgentProjectAccess(c.env.DB, agent.id, scopedProjectId(c, body.project_id));

  if (body.parent_card_id) {
    const parent = await c.env.DB.prepare(
      "SELECT id FROM cards WHERE id = ?1 AND project_id = ?2",
    )
      .bind(body.parent_card_id, project.project_id)
      .first();
    if (!parent) throw new HttpError(400, "INVALID_ARGUMENT", "parent card not found in this project");
  }
  if (body.assignee_agent_id) {
    const resolved = await resolveProjectAgentReference(c.env.DB, project.project_id, body.assignee_agent_id);
    if (!resolved) throw new HttpError(400, "INVALID_ARGUMENT", "assignee is not a member of this project");
    body.assignee_agent_id = resolved;
    const assignee = await c.env.DB.prepare(
      `SELECT ap.agent_id
         FROM agent_projects ap
         JOIN projects p ON p.id = ap.project_id
        WHERE ap.agent_id = ?1 AND ap.project_id = ?2 AND ap.status = 'active'
          AND p.archived_at IS NULL`,
    )
      .bind(body.assignee_agent_id, project.project_id)
      .first();
    if (!assignee) throw new HttpError(400, "INVALID_ARGUMENT", "assignee is not an active member of this project");
  }

  const now = nowIso();
  const card: CardRow = {
    id: newId("c"),
    project_id: project.project_id,
    parent_card_id: body.parent_card_id ?? null,
    title: body.title,
    body: body.body ?? null,
    status: "open",
    outcome: null,
    version: 1,
    round: 1,
    priority: body.priority,
    requester_agent_id: agent.id,
    assignee_agent_id: body.assignee_agent_id ?? null,
    assignee_user_id: null,
    criteria_json: JSON.stringify(body.criteria),
    verifier_id: null,
    verdict_reasons_json: null,
    lease_owner: null,
    lease_expires_at: null,
    paused_at: null,
    deadline_at: body.deadline_at ?? null,
    evidence_hash: null,
    created_by_type: "agent",
    created_by_id: agent.id,
    created_at: now,
    updated_at: now,
  };

  const mutation = c.env.DB.prepare(
    `INSERT INTO cards
       (id, project_id, parent_card_id, title, body, status, outcome, version, round, priority,
        requester_agent_id, assignee_agent_id, assignee_user_id, criteria_json, verifier_id,
        verdict_reasons_json, lease_owner, lease_expires_at, deadline_at, evidence_hash,
        created_by_type, created_by_id, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)`,
  )
    .bind(
      card.id,
      card.project_id,
      card.parent_card_id,
      card.title,
      card.body,
      card.status,
      card.outcome,
      card.version,
      card.round,
      card.priority,
      card.requester_agent_id,
      card.assignee_agent_id,
      card.assignee_user_id,
      card.criteria_json,
      card.verifier_id,
      card.verdict_reasons_json,
      card.lease_owner,
      card.lease_expires_at,
      card.deadline_at,
      card.evidence_hash,
      card.created_by_type,
      card.created_by_id,
      card.created_at,
      card.updated_at,
    );

  const { seq, eventId, eventPending, card: savedCard } = await appendAgentCardEvent(c, card, "card.created", { after: card }, undefined, mutation);
  return c.json({ card: savedCard, seq, event_id: eventId, event_pending: eventPending }, eventPending ? 202 : 201);
});

agentApiRoutes.post("/cards/:cid/close", requireAgent, async (c) => {
  const card = await loadAgentCard(c, c.req.param("cid"), true);
  const expected = parseIfMatch(c);
  if (card.version !== expected) versionConflict(expected, card.version);
  assertTransition("cancel", card.status, "cancelled");
  const body = await parseBody(c, closeCardSchema);

  const now = nowIso();
  const cardWrite = c.env.DB.prepare(
    `UPDATE cards SET status = 'closed', outcome = 'cancelled', version = version + 1,
            lease_owner = NULL, lease_expires_at = NULL, paused_at = NULL, updated_at = ?1
      WHERE id = ?2 AND version = ?3`,
  )
    .bind(now, card.id, expected);
  const { seq, eventId, eventPending, card: updated } = await appendAgentCardEvent(c, card, "card.closed", {
    from: card.status,
    to: "closed",
    outcome: "cancelled",
    reason: body.reason,
  }, undefined, [...retireCardWork(c.env.DB, card, now), cardWrite]);
  return c.json({ card: updated, seq, event_id: eventId, event_pending: eventPending }, eventPending ? 202 : 200);
});

agentApiRoutes.post("/cards/:cid/reopen", requireAgent, async (c) => {
  const card = await loadAgentCard(c, c.req.param("cid"), true);
  const expected = parseIfMatch(c);
  if (card.version !== expected) versionConflict(expected, card.version);
  assertTransition("reopen", card.status);
  if (card.round >= 5) {
    throw new HttpError(409, "ROUND_LIMIT", "card has reached the maximum number of rounds");
  }
  const body = await parseBody(c, reopenCardSchema);

  const now = nowIso();
  const cardWrite = c.env.DB.prepare(
    `UPDATE cards SET status = 'open', outcome = NULL, round = round + 1,
            verifier_id = NULL, verdict_reasons_json = NULL, evidence_hash = NULL,
            assignee_agent_id = NULL, assignee_user_id = NULL, lease_owner = NULL, lease_expires_at = NULL, paused_at = NULL, version = version + 1, updated_at = ?1
      WHERE id = ?2 AND version = ?3`,
  )
    .bind(now, card.id, expected);
  const { seq, eventId, eventPending, card: updated } = await appendAgentCardEvent(c, card, "card.reopened", {
    from: "closed",
    to: "open",
    round: card.round + 1,
    reason: body.reason ?? null,
  }, undefined, [...retireCardWork(c.env.DB, card, now), cardWrite]);
  return c.json({ card: updated, seq, event_id: eventId, event_pending: eventPending }, eventPending ? 202 : 200);
});

agentApiRoutes.get("/cards", requireAgent, async (c) => {
  const agent = c.get("agent");
  // A project-bound token only ever sees its own project.
  const requestedProjectId = scopedProjectId(c, c.req.query("project_id"));
  const project = await assertAgentProjectAccess(c.env.DB, agent.id, requestedProjectId);
  const result = await listAgentCards(c.env.DB, [project.project_id], {
    status: c.req.query("status"), since: c.req.query("since"), limit: c.req.query("limit"),
    cursor: c.req.query("cursor"), order: c.req.query("order"),
  });
  return c.json({ projects: [project.project_id], ...result });
});
