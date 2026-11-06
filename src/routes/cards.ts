import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { assertTransition } from "../domain/state-machine";
import { buildContractReceipt, termsHash } from "../domain/negotiation";
import { guardedCardWrite, retireCardWork } from "../domain/execution";
import {
  assertShortCircuitLevel,
  assertShortCircuitState,
  buildDirectEngageTerms,
  resolveShortCircuitLevel,
  verifyBypasses,
  type ShortCircuitLevel,
} from "../domain/short-circuit";
import { resolveProjectAgentReference } from "../domain/agent-projects";
import { verifierConflict } from "../domain/verification";
import { HttpError } from "../lib/http-error";
import { sha256Hex } from "../lib/crypto";
import { commitAndPublish, findExistingEvent } from "../lib/event-store";
import { parseBody, parseIfMatch, parseLimit } from "../lib/http";
import { newId } from "../lib/ids";
import { nowIso } from "../lib/time";
import { isAdmin, requireUser } from "../middleware/identity";
import { requireProjectMember } from "../middleware/project";
import type {
  CardEventRow,
  CardRow,
  ContractRow,
  NegotiationSessionRow,
  ProposalRow,
} from "../types";

export const cardRoutes = new Hono<AppEnv>();

const criteriaSchema = z.array(
  z.object({
    key: z.string().min(1).max(80),
    op: z.enum(["eq", "gte", "lte", "matches", "exists"]),
    value: z.unknown().optional(),
    severity: z.enum(["block", "warn"]).optional(),
  }),
);

const createCardSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(65536).optional(),
  priority: z.number().int().min(0).max(100).default(0),
  criteria: criteriaSchema.default([]),
  deadline_at: z.string().datetime().nullable().optional(),
  parent_card_id: z.string().nullable().optional(),
  assignee_agent_id: z.string().nullable().optional(),
});

const patchCardSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(65536).nullable().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  criteria: criteriaSchema.optional(),
  deadline_at: z.string().datetime().nullable().optional(),
  assignee_agent_id: z.string().nullable().optional(),
});

const closeCardSchema = z.object({
  reason: z.string().min(8).max(2000),
});

const reopenCardSchema = z.object({
  reason: z.string().min(8).max(2000).optional(),
});

const commitSchema = z.object({
  message_id: z.string().min(8).max(80),
  session_id: z.string().min(1).optional(),
  proposal_id: z.string().min(1).optional(),
  terms_hash: z.string().min(8).max(80),
});

const verifySchema = z.object({
  message_id: z.string().min(8).max(80).optional(),
  verdict: z.enum(["pass", "reject", "needs_more"]),
  reasons: z
    .array(
      z.object({
        key: z.string().max(80).optional(),
        message: z.string().max(500),
        pass: z.boolean().optional(),
      }),
    )
    .max(100)
    .optional(),
  score: z.number().min(0).max(1).optional(),
  rule_version: z.string().max(50).optional(),
});

const interventionSchema = z.object({
  message_id: z.string().min(8).max(80).optional(),
  type: z.enum(["reject", "redirect", "takeover", "pause", "resume"]),
  reason: z.string().min(8).max(2000),
  payload: z
    .object({
      criteria: criteriaSchema.optional(),
      priority: z.number().int().min(0).max(100).optional(),
      deadline_at: z.string().datetime().nullable().optional(),
    })
    .optional(),
});

const verifyReasonsSchema = z
  .array(
    z.object({
      key: z.string().max(80).optional(),
      message: z.string().max(500),
      pass: z.boolean().optional(),
    }),
  )
  .max(100)
  .optional();

const shortCircuitSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("engage"),
    message_id: z.string().min(8).max(80).optional(),
    reason: z.string().min(8).max(2000),
    assignee_agent_id: z.string().min(1).optional(),
  }),
  z.object({
    action: z.literal("verify"),
    message_id: z.string().min(8).max(80).optional(),
    reason: z.string().min(8).max(2000),
    verdict: z.enum(["pass", "reject"]),
    reasons: verifyReasonsSchema,
    score: z.number().min(0).max(1).optional(),
    rule_version: z.string().max(50).optional(),
  }),
  z.object({
    action: z.literal("cancel"),
    message_id: z.string().min(8).max(80).optional(),
    reason: z.string().min(8).max(2000),
  }),
  z.object({
    action: z.literal("release"),
    message_id: z.string().min(8).max(80).optional(),
    reason: z.string().min(8).max(2000),
  }),
  z.object({
    action: z.literal("reset"),
    message_id: z.string().min(8).max(80).optional(),
    reason: z.string().min(8).max(2000),
  }),
]);

interface CardWithNames extends CardRow {
  assignee_name: string | null;
  requester_name: string | null;
  creator_name: string | null;
  assignee_type: "agent" | "user" | null;
  requester_type: "agent" | "user" | "system";
  creator_type: "agent" | "user" | "system";
  assignee_id: string | null;
  requester_id: string | null;
  creator_id: string;
}

function versionConflict(expected: number, actual: number): never {
  throw new HttpError(409, "VERSION_CONFLICT", "card was modified by another actor", {
    expected_version: expected,
    actual_version: actual,
  });
}

async function loadCardForUser(c: Context<AppEnv>, cardId: string): Promise<CardRow> {
  const card = await c.env.DB.prepare("SELECT * FROM cards WHERE id = ?1").bind(cardId).first<CardRow>();
  if (!card) throw new HttpError(404, "NOT_FOUND", "card not found");
  const project = await c.env.DB.prepare("SELECT archived_at FROM projects WHERE id = ?1")
    .bind(card.project_id)
    .first<{ archived_at: string | null }>();
  if (!project || project.archived_at) throw new HttpError(404, "NOT_FOUND", "card not found");
  const user = c.get("user");
  const membership = await c.env.DB.prepare(
    "SELECT role FROM project_members WHERE project_id = ?1 AND user_id = ?2",
  )
    .bind(card.project_id, user.id)
    .first<{ role: "owner" | "admin" | "member" }>();
  if (!membership && !isAdmin(user)) throw new HttpError(404, "NOT_FOUND", "card not found");
  return card;
}

async function appendCardEvent(
  c: Context<AppEnv>, card: CardRow, eventType: string, payload: unknown,
  messageId?: string, mutations: D1PreparedStatement | D1PreparedStatement[] = [],
  receipt: Record<string, unknown> = {},
) {
  const result = await commitAndPublish(c, mutations, {
    projectId: card.project_id, cardId: card.id, eventType,
    actorType: "user", actorId: c.get("user").id, payload, messageId, receipt,
  });
  if (!result) versionConflict(card.version, card.version + 1);
  const details = await c.env.DB.prepare(`${CARD_SELECT} WHERE c.id = ?1`).bind(card.id).first<CardWithNames>().catch(() => null);
  return { seq: result.seq, eventId: result.event_id, eventPending: result.event_pending,
    card: { ...details, ...result.card! }, receipt: result.receipt, ...(result.duplicate ? { duplicate: true } : {}) };
}

async function findExistingCardMessage(c: Context<AppEnv>, cardId: string, messageId: string): Promise<Record<string, unknown> | null> {
  return findExistingEvent(c, cardId, messageId);
}

async function collectSubtree(db: D1Database, cardId: string): Promise<string[]> {
  const rows = await db
    .prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT ?1
         UNION
         SELECT d.card_id FROM card_deps d JOIN subtree s ON d.depends_on_card_id = s.id
       )
       SELECT id FROM subtree`,
    )
    .bind(cardId)
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

const CARD_SELECT = `
  SELECT c.*,
         CASE
           WHEN c.requester_agent_id IS NOT NULL THEN 'agent'
           WHEN c.created_by_type = 'user' THEN 'user'
           ELSE 'system'
         END AS requester_type,
         CASE
           WHEN c.assignee_agent_id IS NOT NULL THEN 'agent'
           WHEN c.assignee_user_id IS NOT NULL THEN 'user'
           ELSE NULL
         END AS assignee_type,
         c.created_by_type AS creator_type,
         CASE
           WHEN c.requester_agent_id IS NOT NULL THEN c.requester_agent_id
           WHEN c.created_by_type = 'user' THEN c.created_by_id
           ELSE NULL
         END AS requester_id,
         COALESCE(c.assignee_agent_id, c.assignee_user_id) AS assignee_id,
         c.created_by_id AS creator_id,
         CASE
           WHEN c.requester_agent_id IS NOT NULL
             THEN COALESCE(NULLIF(ra.display_name,''), NULLIF(ra.self_reported_name,''), ra.slug)
           WHEN c.created_by_type = 'user' THEN COALESCE(NULLIF(cu.display_name,''), cu.email)
           ELSE NULL
         END AS requester_name,
         CASE
           WHEN c.assignee_agent_id IS NOT NULL
             THEN COALESCE(NULLIF(aa.display_name,''), NULLIF(aa.self_reported_name,''), aa.slug)
           WHEN c.assignee_user_id IS NOT NULL THEN COALESCE(NULLIF(au.display_name,''), au.email)
           ELSE NULL
         END AS assignee_name,
         CASE
           WHEN c.created_by_type = 'user' THEN COALESCE(NULLIF(cu.display_name,''), cu.email)
           ELSE NULL
         END AS creator_name
    FROM cards c
    LEFT JOIN agents ra ON ra.id = c.requester_agent_id
    LEFT JOIN agents aa ON aa.id = c.assignee_agent_id
    LEFT JOIN users cu ON cu.id = c.created_by_id
    LEFT JOIN users au ON au.id = c.assignee_user_id`;

cardRoutes.post(
  "/projects/:pid/cards",
  requireUser,
  requireProjectMember,
  async (c) => {
    const project = c.get("project");
    const user = c.get("user");
    const body = await parseBody(c, createCardSchema);

    if (body.parent_card_id) {
      const parent = await c.env.DB.prepare(
        "SELECT id FROM cards WHERE id = ?1 AND project_id = ?2",
      )
        .bind(body.parent_card_id, project.id)
        .first();
      if (!parent) throw new HttpError(400, "INVALID_ARGUMENT", "parent card not found in this project");
    }
    if (body.assignee_agent_id) {
      const resolved = await resolveProjectAgentReference(c.env.DB, project.id, body.assignee_agent_id);
      if (!resolved) throw new HttpError(400, "INVALID_ARGUMENT", "assignee is not a member of this project");
      body.assignee_agent_id = resolved;
      const agent = await c.env.DB.prepare(
        `SELECT ap.agent_id
           FROM agent_projects ap
           JOIN projects p ON p.id = ap.project_id
          WHERE ap.agent_id = ?1 AND ap.project_id = ?2 AND ap.status = 'active'
            AND p.archived_at IS NULL`,
      )
        .bind(body.assignee_agent_id, project.id)
        .first();
      if (!agent) throw new HttpError(400, "INVALID_ARGUMENT", "assignee is not an active member of this project");
    }

    const now = nowIso();
    const card: CardRow = {
      id: newId("c"),
      project_id: project.id,
      parent_card_id: body.parent_card_id ?? null,
      title: body.title,
      body: body.body ?? null,
      status: "open",
      outcome: null,
      version: 1,
      round: 1,
      priority: body.priority,
      requester_agent_id: null,
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
      created_by_type: "user",
      created_by_id: user.id,
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

    const { seq, eventId, eventPending, card: created } = await appendCardEvent(c, card, "card.created", { after: card }, undefined, mutation);
    return c.json({ card: created, seq, event_id: eventId, event_pending: eventPending }, eventPending ? 202 : 201);
  },
);

cardRoutes.post("/cards/:cid/commit", requireUser, async (c) => {
  const user = c.get("user");
  const card = await loadCardForUser(c, c.req.param("cid"));
  const body = await parseBody(c, commitSchema);

  const createdByAgent = card.created_by_type === "agent";
  if (createdByAgent) {
    // Agent 建卡没有人类发起人：项目 owner 可以代 Agent 接受，责任与审计落在代收人身上。
    const membership = await c.env.DB.prepare(
      "SELECT role FROM project_members WHERE project_id = ?1 AND user_id = ?2",
    )
      .bind(card.project_id, user.id)
      .first<{ role: "owner" | "admin" | "member" }>();
    if (membership?.role !== "owner" && membership?.role !== "admin" && !isAdmin(user)) {
      throw new HttpError(403, "FORBIDDEN", "only a project owner can accept an agent-created card");
    }
  } else if (card.created_by_id !== user.id) {
    throw new HttpError(403, "FORBIDDEN", "only the human requester can accept this proposal");
  }
  const duplicate = await findExistingCardMessage(c, card.id, body.message_id);
  if (duplicate) return c.json(duplicate, duplicate.event_pending ? 202 : 200);

  if (card.paused_at) {
    throw new HttpError(409, "CARD_PAUSED", "card is paused");
  }
  if (card.status !== "open") {
    throw new HttpError(409, "CARD_NOT_OPEN", "only open cards can be accepted");
  }


  const session = body.session_id
    ? await c.env.DB.prepare(
        "SELECT * FROM negotiation_sessions WHERE id = ?1 AND card_id = ?2",
      )
        .bind(body.session_id, card.id)
        .first<NegotiationSessionRow>()
    : await c.env.DB.prepare(
        "SELECT * FROM negotiation_sessions WHERE card_id = ?1 AND state = 'open' ORDER BY round DESC LIMIT 1",
      )
        .bind(card.id)
        .first<NegotiationSessionRow>();
  if (!session) {
    throw new HttpError(404, "SESSION_NOT_FOUND", "no open negotiation session for this card");
  }
  if (session.state !== "open" || session.round !== card.round) {
    throw new HttpError(409, "SESSION_BUSY", "negotiation session is no longer open in the current round");
  }
  if (createdByAgent) {
    // 代收只适用于 Agent 发起的会话；人类发起的人类卡仍只允许本人接受。
    if (session.initiator_user_id !== null) {
      throw new HttpError(403, "FORBIDDEN", "this negotiation was opened by a human requester");
    }
  } else if (session.initiator_user_id !== user.id) {
    throw new HttpError(403, "FORBIDDEN", "only the negotiation initiator can accept this proposal");
  }

  const proposal = await c.env.DB.prepare(
    "SELECT * FROM proposals WHERE session_id = ?1 ORDER BY seq_in_session DESC LIMIT 1",
  )
    .bind(session.id)
    .first<ProposalRow>();
  if (!proposal || proposal.status !== "offered" || (body.proposal_id && body.proposal_id !== proposal.id)) {
    throw new HttpError(409, "PROPOSAL_NOT_FOUND", "no open proposal to accept");
  }
  if (body.terms_hash !== proposal.terms_hash) {
    throw new HttpError(422, "TERMS_HASH_MISMATCH", "terms_hash does not match the latest proposal");
  }

  const activeContract = await c.env.DB.prepare(
    "SELECT id FROM contracts WHERE card_id = ?1 AND state = 'active'",
  )
    .bind(card.id)
    .first<{ id: string }>();
  if (activeContract) {
    throw new HttpError(409, "CONTRACT_CONFLICT", "an active contract already exists for this card");
  }

  const now = nowIso();
  const contractId = newId("ct");
  const receipt = buildContractReceipt({
    actorType: "user",
    actorId: user.id,
    termsHash: proposal.terms_hash,
    requestId: c.get("requestId") ?? "req_unknown",
  });

  const mutations = [
      guardedCardWrite(c.env.DB, card,
        `INSERT INTO contracts
           (id, card_id, session_id, proposer_agent_id, acceptor_user_id, terms_json, terms_hash,
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
        user.id,
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

  const { seq, eventId, eventPending, card: updated, receipt: eventReceipt } = await appendCardEvent(
    c,
    card,
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
      ...(createdByAgent ? { on_behalf_of: card.created_by_id } : {}),
    },
    body.message_id, mutations,
    { session_id: session.id, proposal_id: proposal.id, contract_id: contractId, terms_hash: proposal.terms_hash },
  );
  return c.json(
    {
      card: updated ?? card,
      seq,
      event_id: eventId,
      session_id: session.id,
      proposal_id: proposal.id,
      contract_id: contractId,
      terms_hash: proposal.terms_hash,
      ...eventReceipt, event_pending: eventPending,
    },
    eventPending ? 202 : 201,
  );
});

cardRoutes.post("/cards/:cid/verify", requireUser, async (c) => {
  const user = c.get("user");
  const card = await loadCardForUser(c, c.req.param("cid"));
  const body = await parseBody(c, verifySchema);

  if (body.message_id) {
    const duplicate = await findExistingCardMessage(c, card.id, body.message_id);
    if (duplicate) return c.json(duplicate, duplicate.event_pending ? 202 : 200);
  }

  if (card.status !== "review") {
    const project = await c.env.DB.prepare(
      "SELECT verification_mode FROM projects WHERE id = ?1",
    )
      .bind(card.project_id)
      .first<{ verification_mode: "human" | "rule" }>();
    if (card.status !== "engaged" || project?.verification_mode !== "human") {
      throw new HttpError(409, "CARD_NOT_IN_REVIEW", "verdict requires a card in review");
    }
  }

  // Human mode may close an engaged contract directly: there is no execution
  // target to produce a run/ticket, so a human attestation is the evidence.
  const humanAttestation = card.status === "engaged";
  const attestationNote = (body.reasons ?? [])
    .map((reason) => reason.message.trim())
    .filter(Boolean)
    .join("\n");
  if (humanAttestation && attestationNote.length < 8) {
    throw new HttpError(
      400,
      "ATTESTATION_REQUIRED",
      "human acceptance requires a note of at least 8 characters",
    );
  }
  if (humanAttestation && body.verdict === "needs_more") {
    throw new HttpError(
      409,
      "ILLEGAL_TRANSITION",
      "needs_more is only available for cards in review; use reopen or intervene",
    );
  }

  const contract = await c.env.DB.prepare(
    "SELECT * FROM contracts WHERE card_id = ?1 AND state = 'active'",
  )
    .bind(card.id)
    .first<ContractRow>();
  if (contract && verifierConflict(contract, user.id)) {
    throw new HttpError(409, "VERIFIER_CONFLICT", "the proposer cannot verify this card");
  }

  if (body.verdict === "pass" && !humanAttestation) {
    const evidence = await c.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM evidence WHERE card_id = ?1",
    )
      .bind(card.id)
      .first<{ count: number }>();
    if ((evidence?.count ?? 0) === 0) {
      throw new HttpError(409, "EVIDENCE_REQUIRED", "a passing verdict requires evidence");
    }
  }

  const now = nowIso();
  const attestationId = humanAttestation ? newId("ev") : null;
  const attestationHash = humanAttestation
    ? await sha256Hex(`${card.id}\n${user.id}\n${now}\n${attestationNote}`)
    : null;
  const attestationDigest = attestationHash ? `sha256:${attestationHash}` : null;
  const reasonsJson = JSON.stringify({
    verdict: body.verdict,
    reasons: body.reasons ?? [],
    score: body.score ?? null,
    rule_version: body.rule_version ?? null,
    self_reported: !humanAttestation,
    verified_by: user.id,
    verified_at: now,
    ...(humanAttestation
      ? {
          human_attested: true,
          verification_mode: "human",
          attestation_id: attestationId,
        }
      : {}),
  });

  if (body.verdict === "needs_more") {
    assertTransition("rework", "review");
    const mutation = c.env.DB.prepare(
      `UPDATE cards SET status = 'engaged', verdict_reasons_json = ?1, verifier_id = ?2,
              lease_owner = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ?3
        WHERE id = ?4 AND version = ?5 AND status = 'review'`,
    )
      .bind(reasonsJson, user.id, now, card.id, card.version);
    const { seq, eventId, eventPending, card: updated } = await appendCardEvent(
      c,
      card,
      "card.verdict",
      {
        verdict: "needs_more",
        from: "review",
        to: "engaged",
        status: "engaged",
        reasons: body.reasons ?? [],
        rule_version: body.rule_version ?? null,
      },
      body.message_id, mutation,
    );
    return c.json({ card: updated, seq, event_id: eventId, event_pending: eventPending }, eventPending ? 202 : 200);
  }

  const outcome = body.verdict === "pass" ? "done" : "rejected";
  assertTransition(humanAttestation ? "attest" : "verdict", card.status, outcome);
  const cardWrite = c.env.DB.prepare(
    `UPDATE cards SET status = 'closed', outcome = ?1, verifier_id = ?2,
            verdict_reasons_json = ?3, evidence_hash = COALESCE(?4, evidence_hash),
            version = version + 1, updated_at = ?5
      WHERE id = ?6 AND version = ?7 AND status = ?8`,
  )
    .bind(outcome, user.id, reasonsJson, attestationDigest, now, card.id, card.version, card.status);
  const attestationStatement = humanAttestation
    ? guardedCardWrite(
        c.env.DB,
        card,
        `INSERT INTO evidence
           (id, card_id, kind, sha256, size_bytes, media_type, summary, produced_by, created_at)
         SELECT ?1, ?2, 'attestation', ?3, ?4, 'text/plain', ?5, ?6, ?7 WHERE /* current_card */`,
        [
          attestationId!,
          card.id,
          attestationHash!,
          new TextEncoder().encode(attestationNote).length,
          attestationNote.slice(0, 500),
          user.id,
          now,
        ],
      )
    : null;
  const related = [
    ...(attestationStatement ? [attestationStatement] : []),
    ...(contract
      ? [
          guardedCardWrite(
            c.env.DB,
            card,
            "UPDATE contracts SET state = ?1, closed_at = ?2 WHERE id = ?3 AND state = 'active' AND /* current_card */",
            [body.verdict === "pass" ? "fulfilled" : "breached", now, contract.id],
          ),
        ]
      : []),
  ];
  const { seq, eventId, eventPending, card: updated } = await appendCardEvent(
    c,
    card,
    "card.verdict",
    {
      verdict: body.verdict,
      from: card.status,
      to: "closed",
      outcome,
      reasons: body.reasons ?? [],
      score: body.score ?? null,
      rule_version: body.rule_version ?? null,
      ...(humanAttestation
        ? {
            human_attested: true,
            verification_mode: "human",
            attestation_id: attestationId,
            evidence_hash: attestationDigest,
          }
        : {}),
    },
    body.message_id, [...related, cardWrite],
  );
  return c.json({ card: updated, seq, event_id: eventId, event_pending: eventPending }, eventPending ? 202 : 200);
});

cardRoutes.post("/cards/:cid/intervene", requireUser, async (c) => {
  const user = c.get("user");
  const card = await loadCardForUser(c, c.req.param("cid"));
  const body = await parseBody(c, interventionSchema);

  if (body.message_id) {
    const duplicate = await findExistingCardMessage(c, card.id, body.message_id);
    if (duplicate) return c.json(duplicate, duplicate.event_pending ? 202 : 200);
  }

  const now = nowIso();
  const interventionId = newId("iv");
  const affectedSubtree = await collectSubtree(c.env.DB, card.id);
  let cardStatement: D1PreparedStatement;
  let eventType: string;
  let eventPayload: Record<string, unknown>;
  const related: D1PreparedStatement[] = [];

  if (body.type === "pause") {
    if (card.status === "closed") throw new HttpError(409, "CARD_CLOSED", "card is already closed");
    if (card.paused_at) throw new HttpError(409, "CARD_ALREADY_PAUSED", "card is already paused");
    cardStatement = c.env.DB.prepare(
      `UPDATE cards SET paused_at = ?1, lease_owner = NULL, lease_expires_at = NULL,
              version = version + 1, updated_at = ?1
        WHERE id = ?2 AND version = ?3 AND status <> 'closed'`,
    ).bind(now, card.id, card.version);
    eventType = "card.paused";
    eventPayload = { type: "pause", reason: body.reason, paused_at: now };
  } else if (body.type === "resume") {
    if (!card.paused_at) throw new HttpError(409, "CARD_NOT_PAUSED", "card is not paused");
    const pausedMs = Math.max(0, Date.now() - new Date(card.paused_at).getTime());
    const deadline =
      card.deadline_at && !Number.isNaN(new Date(card.deadline_at).getTime())
        ? new Date(new Date(card.deadline_at).getTime() + pausedMs).toISOString()
        : card.deadline_at;
    cardStatement = c.env.DB.prepare(
      `UPDATE cards SET paused_at = NULL, deadline_at = ?1, version = version + 1, updated_at = ?2
        WHERE id = ?3 AND version = ?4 AND paused_at IS NOT NULL`,
    ).bind(deadline, now, card.id, card.version);
    eventType = "card.resumed";
    eventPayload = {
      type: "resume",
      reason: body.reason,
      paused_ms: pausedMs,
      deadline_at: deadline,
    };
  } else if (body.type === "reject") {
    if (card.status === "review") {
      assertTransition("verdict", "review", "rejected");
      related.push(...retireCardWork(c.env.DB, card, now, "breached", "failed"));
      cardStatement = c.env.DB.prepare(
        `UPDATE cards SET status = 'closed', outcome = 'rejected', verifier_id = ?1,
                verdict_reasons_json = ?2, version = version + 1, updated_at = ?3
          WHERE id = ?4 AND version = ?5 AND status = 'review'`,
      ).bind(
        user.id,
        JSON.stringify({ verdict: "reject", reason: body.reason, rejected_by: user.id }),
        now,
        card.id,
        card.version,
      );
      eventType = "card.verdict";
      eventPayload = {
        type: "reject",
        from: "review",
        to: "closed",
        outcome: "rejected",
        reason: body.reason,
      };
    } else if (card.status === "open") {
      if (card.round >= 5) {
        throw new HttpError(409, "ROUND_LIMIT", "card has reached the maximum number of rounds");
      }
      const session = await c.env.DB.prepare(
        "SELECT * FROM negotiation_sessions WHERE card_id = ?1 AND state = 'open' ORDER BY round DESC LIMIT 1",
      )
        .bind(card.id)
        .first<NegotiationSessionRow>();
      if (session) {
        related.push(
          guardedCardWrite(c.env.DB, card,
            "UPDATE proposals SET status = 'rejected' WHERE session_id = ?1 AND status IN ('offered','countered') AND /* current_card */", [session.id]),
          guardedCardWrite(c.env.DB, card,
            "UPDATE negotiation_sessions SET state = 'failed', closed_at = ?1 WHERE id = ?2 AND /* current_card */", [now, session.id]),
        );
      }
      cardStatement = c.env.DB.prepare(
        `UPDATE cards SET round = round + 1, version = version + 1, updated_at = ?1
          WHERE id = ?2 AND version = ?3 AND status = 'open'`,
      ).bind(now, card.id, card.version);
      eventType = "negotiation.rejected";
      eventPayload = {
        type: "reject",
        from: "open",
        to: "open",
        session_id: session?.id ?? null,
        reason: body.reason,
      };
    } else {
      throw new HttpError(409, "INVALID_STATE", "reject is only allowed for open or review cards");
    }
  } else if (body.type === "redirect") {
    if (card.status !== "open" && card.status !== "engaged") {
      throw new HttpError(409, "INVALID_STATE", "redirect is only allowed for open or engaged cards");
    }
    if (card.round >= 5) {
      throw new HttpError(409, "ROUND_LIMIT", "card has reached the maximum number of rounds");
    }
    const criteriaJson =
      body.payload?.criteria !== undefined
        ? JSON.stringify(body.payload.criteria)
        : card.criteria_json;
    const priority = body.payload?.priority ?? card.priority;
    const deadline =
      body.payload?.deadline_at !== undefined ? body.payload.deadline_at : card.deadline_at;
    related.push(...retireCardWork(c.env.DB, card, now, "superseded", "failed"));
    cardStatement = c.env.DB.prepare(
      `UPDATE cards SET status = 'open', outcome = NULL, round = round + 1, criteria_json = ?1,
              priority = ?2, deadline_at = ?3, paused_at = NULL, lease_owner = NULL,
              lease_expires_at = NULL, verifier_id = NULL, verdict_reasons_json = NULL,
              version = version + 1, updated_at = ?4
        WHERE id = ?5 AND version = ?6 AND status IN ('open','engaged')`,
    ).bind(criteriaJson, priority, deadline, now, card.id, card.version);
    eventType = "card.redirected";
    eventPayload = {
      type: "redirect",
      from: card.status,
      to: "open",
      round: card.round + 1,
      criteria_json: criteriaJson,
      priority,
      deadline_at: deadline,
      reason: body.reason,
    };
  } else if (body.type === "takeover") {
    if (card.status === "closed") throw new HttpError(409, "CARD_CLOSED", "card is already closed");
    related.push(...retireCardWork(c.env.DB, card, now, "breached", "failed"));
    cardStatement = c.env.DB.prepare(
      `UPDATE cards SET assignee_agent_id = NULL, assignee_user_id = ?1, lease_owner = NULL,
              lease_expires_at = NULL, version = version + 1, updated_at = ?2
        WHERE id = ?3 AND version = ?4 AND status <> 'closed'`,
    ).bind(user.id, now, card.id, card.version);
    eventType = "card.takeover";
    eventPayload = {
      type: "takeover",
      assignee_user_id: user.id,
      reason: body.reason,
    };
  } else {
    throw new HttpError(400, "INVALID_ARGUMENT", "unsupported intervention");
  }

  const intervention = guardedCardWrite(c.env.DB, card,
    `INSERT INTO interventions
       (id, card_id, actor_id, type, reason, payload_json, affected_subtree_json, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE /* current_card */`,
    [
      interventionId,
      card.id,
      user.id,
      body.type,
      body.reason,
      body.payload ? JSON.stringify(body.payload) : null,
      JSON.stringify(affectedSubtree),
      now,
    ]);
  const { seq, eventId, eventPending, card: updated, receipt: eventReceipt } = await appendCardEvent(
    c,
    card,
    eventType,
    { ...eventPayload, intervention_id: interventionId, affected_subtree: affectedSubtree },
    body.message_id, [...related, intervention, cardStatement],
    { intervention_id: interventionId, affected_subtree: affectedSubtree },
  );
  return c.json(
    {
      card: updated ?? card,
      intervention_id: interventionId,
      affected_subtree: affectedSubtree,
      seq,
      event_id: eventId, ...eventReceipt, event_pending: eventPending,
    },
    eventPending ? 202 : 200,
  );
});

/**
 * Governance short-circuit. Two levels share the same two actions; the scope
 * differs: a project owner may act only inside the looked-up project, while an
 * instance admin may act on any unarchived project (loadCardForUser already
 * grants that access). Every branch writes one card.short_circuited event and
 * the usual card CAS, so seq/audit/SSE invariants are unchanged.
 */
cardRoutes.post("/cards/:cid/short-circuit", requireUser, async (c) => {
  const user = c.get("user");
  const card = await loadCardForUser(c, c.req.param("cid"));
  const body = await parseBody(c, shortCircuitSchema);

  const membership = await c.env.DB.prepare(
    "SELECT role FROM project_members WHERE project_id = ?1 AND user_id = ?2",
  )
    .bind(card.project_id, user.id)
    .first<{ role: "owner" | "admin" | "member" }>();
  const level: ShortCircuitLevel | null = resolveShortCircuitLevel({
    globalAdmin: isAdmin(user),
    projectRole: membership?.role ?? null,
  });
  assertShortCircuitLevel(level);

  if (body.message_id) {
    const duplicate = await findExistingCardMessage(c, card.id, body.message_id);
    if (duplicate) return c.json(duplicate, duplicate.event_pending ? 202 : 200);
  }

  assertShortCircuitState(body.action, card);

  const now = nowIso();

  if (body.action === "engage") {
    const target = body.assignee_agent_id ?? card.assignee_agent_id;
    if (!target) {
      throw new HttpError(400, "ASSIGNEE_REQUIRED", "engage requires an assignee agent");
    }
    const resolved = await resolveProjectAgentReference(c.env.DB, card.project_id, target);
    if (!resolved) {
      throw new HttpError(400, "ASSIGNEE_NOT_ACTIVE", "assignee is not an active member of this project");
    }
    if (card.created_by_type === "agent" && card.created_by_id === resolved) {
      throw new HttpError(409, "SELF_ASSIGNMENT", "cannot directly engage the card creator");
    }
    const agent = await c.env.DB.prepare(
      `SELECT ap.agent_id
         FROM agent_projects ap
         JOIN projects p ON p.id = ap.project_id
        WHERE ap.agent_id = ?1 AND ap.project_id = ?2 AND ap.status = 'active'
          AND p.archived_at IS NULL`,
    )
      .bind(resolved, card.project_id)
      .first();
    if (!agent) {
      throw new HttpError(400, "ASSIGNEE_NOT_ACTIVE", "assignee is not an active member of this project");
    }

    const existingSession = await c.env.DB.prepare(
      "SELECT id, state FROM negotiation_sessions WHERE card_id = ?1 AND round = ?2",
    )
      .bind(card.id, card.round)
      .first<{ id: string; state: string }>();
    if (existingSession) {
      if (existingSession.state === "open") {
        throw new HttpError(409, "NEGOTIATION_OPEN", "an open negotiation session already exists; use commit");
      }
      throw new HttpError(409, "ADMIN_ACTION_STATE", "the current round already has a negotiation record", {
        action: body.action,
        session_id: existingSession.id,
        session_state: existingSession.state,
      });
    }
    const activeContract = await c.env.DB.prepare(
      "SELECT id FROM contracts WHERE card_id = ?1 AND state = 'active'",
    )
      .bind(card.id)
      .first<{ id: string }>();
    if (activeContract) {
      throw new HttpError(409, "CONTRACT_CONFLICT", "an active contract already exists for this card");
    }

    const terms = buildDirectEngageTerms({
      card,
      assigneeAgentId: resolved,
      level,
      actorUserId: user.id,
      reason: body.reason,
      now,
    });
    const termsJson = JSON.stringify(terms);
    const hash = await termsHash(terms);
    const sessionId = newId("ns");
    const proposalId = newId("p");
    const contractId = newId("ct");
    const proofJson = JSON.stringify({
      type: "admin_short_circuit",
      level,
      by_type: "user",
      by_id: user.id,
      reason: body.reason,
      accepted_at: now,
      synthetic: true,
    });
    const bypassed = ["proposal", "agent_acceptance"] as const;

    const mutations = [
      guardedCardWrite(
        c.env.DB,
        card,
        `INSERT INTO negotiation_sessions
           (id, card_id, initiator_agent_id, initiator_user_id, responder_agent_id, round,
            state, created_at, closed_at)
         SELECT ?1, ?2, NULL, ?3, ?4, ?5, 'committed', ?6, ?6
          WHERE /* current_card */
            AND NOT EXISTS (SELECT 1 FROM negotiation_sessions WHERE card_id = ?2 AND round = ?5)
            AND NOT EXISTS (SELECT 1 FROM contracts WHERE card_id = ?2 AND state = 'active')`,
        [sessionId, card.id, user.id, resolved, card.round, now],
      ),
      guardedCardWrite(
        c.env.DB,
        card,
        `INSERT INTO proposals
           (id, session_id, from_agent_id, seq_in_session, terms_json, terms_hash, status, created_at)
         SELECT ?1, ?2, ?3, 1, ?4, ?5, 'accepted', ?6
          WHERE /* current_card */
            AND EXISTS (SELECT 1 FROM negotiation_sessions WHERE id = ?2 AND state = 'committed')`,
        [proposalId, sessionId, resolved, termsJson, hash, now],
      ),
      guardedCardWrite(
        c.env.DB,
        card,
        `INSERT INTO contracts
           (id, card_id, session_id, proposer_agent_id, proposer_user_id, acceptor_agent_id,
            acceptor_user_id, terms_json, terms_hash, acceptance_proof_json, state, version, created_at)
         SELECT ?1, ?2, ?3, ?4, NULL, NULL, ?5, ?6, ?7, ?8, 'active', 1, ?9
          WHERE /* current_card */
            AND EXISTS (SELECT 1 FROM proposals WHERE id = ?10 AND status = 'accepted')`,
        [contractId, card.id, sessionId, resolved, user.id, termsJson, hash, proofJson, now, proposalId],
      ),
      c.env.DB.prepare(
        `UPDATE cards SET status = 'engaged', outcome = NULL, assignee_agent_id = ?1,
                assignee_user_id = NULL, version = version + 1, updated_at = ?2
          WHERE id = ?3 AND version = ?4 AND status = 'open' AND paused_at IS NULL
            AND EXISTS (SELECT 1 FROM contracts WHERE id = ?5 AND state = 'active')`,
      ).bind(resolved, now, card.id, card.version, contractId),
    ];

    const { seq, eventId, eventPending, card: updated, receipt } = await appendCardEvent(
      c,
      card,
      "card.short_circuited",
      {
        action: "engage",
        level,
        reason: body.reason,
        bypassed,
        short_circuit: { level, action: "engage", reason: body.reason, bypassed },
        from: "open",
        to: "engaged",
        synthetic: true,
        assignee_agent_id: resolved,
        session_id: sessionId,
        proposal_id: proposalId,
        contract_id: contractId,
        terms_hash: hash,
      },
      body.message_id,
      mutations,
      { level, action: "engage", session_id: sessionId, proposal_id: proposalId, contract_id: contractId, terms_hash: hash, bypassed },
    );
    return c.json(
      {
        card: updated ?? card,
        level,
        action: "engage",
        short_circuit: { level, action: "engage", reason: body.reason, bypassed },
        session_id: sessionId,
        proposal_id: proposalId,
        contract_id: contractId,
        terms_hash: hash,
        seq,
        event_id: eventId,
        ...receipt,
        event_pending: eventPending,
      },
      eventPending ? 202 : 201,
    );
  }

  if (body.action === "cancel") {
    const attempts = await c.env.DB.prepare(
      "SELECT id FROM attempts WHERE card_id = ?1 AND status IN ('issued','running')",
    )
      .bind(card.id)
      .all<{ id: string }>();
    const contract = await c.env.DB.prepare(
      "SELECT id FROM contracts WHERE card_id = ?1 AND state = 'active'",
    )
      .bind(card.id)
      .first<{ id: string }>();
    const related = retireCardWork(c.env.DB, card, now, "superseded", "cancelled");
    const cardWrite = c.env.DB.prepare(
      `UPDATE cards SET status = 'closed', outcome = 'cancelled', version = version + 1,
              lease_owner = NULL, lease_expires_at = NULL, paused_at = NULL, updated_at = ?1
        WHERE id = ?2 AND version = ?3 AND status <> 'closed'`,
    ).bind(now, card.id, card.version);
    const bypassed = ["active_work"] as const;
    const attemptsAbandoned = attempts.results.length;
    const wasPaused = Boolean(card.paused_at);
    const { seq, eventId, eventPending, card: updated, receipt } = await appendCardEvent(
      c,
      card,
      "card.short_circuited",
      {
        action: "cancel",
        level,
        reason: body.reason,
        bypassed,
        short_circuit: { level, action: "cancel", reason: body.reason, bypassed },
        from: card.status,
        to: "closed",
        outcome: "cancelled",
        attempts_abandoned: attemptsAbandoned,
        was_paused: wasPaused,
        contract_state: contract ? "superseded" : null,
        contract_id: contract?.id ?? null,
      },
      body.message_id,
      [...related, cardWrite],
      { level, action: "cancel", from: card.status, to: "closed", outcome: "cancelled", attempts_abandoned: attemptsAbandoned, bypassed },
    );
    return c.json(
      {
        card: updated ?? card,
        level,
        action: "cancel",
        short_circuit: { level, action: "cancel", reason: body.reason, bypassed },
        outcome: "cancelled",
        attempts_abandoned: attemptsAbandoned,
        was_paused: wasPaused,
        ...(contract ? { contract_id: contract.id } : {}),
        seq,
        event_id: eventId,
        ...receipt,
        event_pending: eventPending,
      },
      eventPending ? 202 : 200,
    );
  }

  if (body.action === "release") {
    const attempts = await c.env.DB.prepare(
      "SELECT id FROM attempts WHERE card_id = ?1 AND status IN ('issued','running')",
    )
      .bind(card.id)
      .all<{ id: string }>();
    const contract = await c.env.DB.prepare(
      "SELECT id FROM contracts WHERE card_id = ?1 AND state = 'active'",
    )
      .bind(card.id)
      .first<{ id: string }>();
    const leaseOwner = card.lease_owner;
    const attemptWrite = guardedCardWrite(
      c.env.DB,
      card,
      `UPDATE attempts SET status = 'abandoned', ended_at = ?1
        WHERE card_id = ?2 AND status IN ('issued','running') AND /* current_card */`,
      [now, card.id],
    );
    const cardWrite = c.env.DB.prepare(
      `UPDATE cards SET status = 'engaged', version = version + 1,
              lease_owner = NULL, lease_expires_at = NULL, updated_at = ?1
        WHERE id = ?2 AND version = ?3 AND status = 'running' AND paused_at IS NULL`,
    ).bind(now, card.id, card.version);
    const bypassed = ["attempt_lease"] as const;
    const attemptsAbandoned = attempts.results.length;
    const { seq, eventId, eventPending, card: updated, receipt } = await appendCardEvent(
      c,
      card,
      "card.short_circuited",
      {
        action: "release",
        level,
        reason: body.reason,
        bypassed,
        short_circuit: { level, action: "release", reason: body.reason, bypassed },
        from: "running",
        to: "engaged",
        attempt_ids: attempts.results.map((attempt) => attempt.id),
        attempts_abandoned: attemptsAbandoned,
        lease_owner: leaseOwner,
        contract_id: contract?.id ?? null,
      },
      body.message_id,
      [attemptWrite, cardWrite],
      { level, action: "release", from: "running", to: "engaged", attempts_abandoned: attemptsAbandoned, bypassed },
    );
    return c.json(
      {
        card: updated ?? card,
        level,
        action: "release",
        short_circuit: { level, action: "release", reason: body.reason, bypassed },
        attempts_abandoned: attemptsAbandoned,
        ...(contract ? { contract_id: contract.id } : {}),
        seq,
        event_id: eventId,
        ...receipt,
        event_pending: eventPending,
      },
      eventPending ? 202 : 200,
    );
  }

  if (body.action === "reset") {
    const attempts = await c.env.DB.prepare(
      "SELECT id FROM attempts WHERE card_id = ?1 AND status IN ('issued','running')",
    )
      .bind(card.id)
      .all<{ id: string }>();
    const evidence = await c.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM evidence WHERE card_id = ?1",
    )
      .bind(card.id)
      .first<{ count: number }>();
    const contract = await c.env.DB.prepare(
      "SELECT id FROM contracts WHERE card_id = ?1 AND state = 'active'",
    )
      .bind(card.id)
      .first<{ id: string }>();
    const related = retireCardWork(c.env.DB, card, now, "superseded", "cancelled");
    const nextRound = card.round + 1;
    const cardWrite = c.env.DB.prepare(
      `UPDATE cards SET status = 'open', outcome = NULL, round = ?1,
              verifier_id = NULL, verdict_reasons_json = NULL, evidence_hash = NULL,
              assignee_agent_id = NULL, assignee_user_id = NULL,
              lease_owner = NULL, lease_expires_at = NULL, paused_at = NULL,
              version = version + 1, updated_at = ?2
        WHERE id = ?3 AND version = ?4 AND status IN ('engaged','running','review')`,
    ).bind(nextRound, now, card.id, card.version);
    const roundLimitBypassed = nextRound > 5;
    const bypassed = roundLimitBypassed
      ? (["active_work", "round_limit"] as const)
      : (["active_work"] as const);
    const attemptsAbandoned = attempts.results.length;
    const { seq, eventId, eventPending, card: updated, receipt } = await appendCardEvent(
      c,
      card,
      "card.short_circuited",
      {
        action: "reset",
        level,
        reason: body.reason,
        bypassed,
        short_circuit: { level, action: "reset", reason: body.reason, bypassed },
        from: card.status,
        to: "open",
        round: nextRound,
        round_limit_bypassed: roundLimitBypassed,
        attempts_abandoned: attemptsAbandoned,
        evidence_count: Number(evidence?.count ?? 0),
        contract_id: contract?.id ?? null,
      },
      body.message_id,
      [...related, cardWrite],
      { level, action: "reset", from: card.status, to: "open", round: nextRound, attempts_abandoned: attemptsAbandoned, bypassed },
    );
    return c.json(
      {
        card: updated ?? card,
        level,
        action: "reset",
        short_circuit: { level, action: "reset", reason: body.reason, bypassed },
        round: nextRound,
        attempts_abandoned: attemptsAbandoned,
        ...(contract ? { contract_id: contract.id } : {}),
        seq,
        event_id: eventId,
        ...receipt,
        event_pending: eventPending,
      },
      eventPending ? 202 : 200,
    );
  }

  const evidence = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM evidence WHERE card_id = ?1",
  )
    .bind(card.id)
    .first<{ count: number }>();
  const evidenceCount = Number(evidence?.count ?? 0);
  const contract = await c.env.DB.prepare(
    "SELECT * FROM contracts WHERE card_id = ?1 AND state = 'active'",
  )
    .bind(card.id)
    .first<ContractRow>();
  const conflict = contract ? verifierConflict(contract, user.id) : null;
  const bypassed = verifyBypasses({ verdict: body.verdict, evidenceCount, verifierConflict: conflict });
  const outcome = body.verdict === "pass" ? "done" : "rejected";
  assertTransition("verdict", "review", outcome);

  const reasonsJson = JSON.stringify({
    verdict: body.verdict,
    reasons: body.reasons ?? [],
    score: body.score ?? null,
    rule_version: body.rule_version ?? null,
    self_reported: true,
    verified_by: user.id,
    verified_at: now,
    short_circuit: { level, action: "verify", reason: body.reason, bypassed },
  });

  const related = contract
    ? [
        guardedCardWrite(
          c.env.DB,
          card,
          `UPDATE contracts SET state = ?1, closed_at = ?2
            WHERE id = ?3 AND state = 'active' AND /* current_card */`,
          [body.verdict === "pass" ? "fulfilled" : "breached", now, contract.id],
        ),
      ]
    : [];
  const cardWrite = c.env.DB.prepare(
    `UPDATE cards SET status = 'closed', outcome = ?1, verifier_id = ?2,
            verdict_reasons_json = ?3, version = version + 1, updated_at = ?4
      WHERE id = ?5 AND version = ?6 AND status = 'review' AND paused_at IS NULL`,
  ).bind(outcome, user.id, reasonsJson, now, card.id, card.version);

  const { seq, eventId, eventPending, card: updated, receipt } = await appendCardEvent(
    c,
    card,
    "card.short_circuited",
    {
      action: "verify",
      level,
      reason: body.reason,
      bypassed,
      short_circuit: { level, action: "verify", reason: body.reason, bypassed },
      from: "review",
      to: "closed",
      outcome,
      verdict: body.verdict,
      evidence_count: evidenceCount,
      contract_id: contract?.id ?? null,
      verifier_conflict: conflict,
      reasons: body.reasons ?? [],
      score: body.score ?? null,
      rule_version: body.rule_version ?? null,
    },
    body.message_id,
    [...related, cardWrite],
    { level, action: "verify", verdict: body.verdict, outcome, evidence_count: evidenceCount, bypassed },
  );
  return c.json(
    {
      card: updated ?? card,
      level,
      action: "verify",
      short_circuit: { level, action: "verify", reason: body.reason, bypassed },
      verdict: body.verdict,
      outcome,
      evidence_count: evidenceCount,
      ...(contract ? { contract_id: contract.id } : {}),
      seq,
      event_id: eventId,
      ...receipt,
      event_pending: eventPending,
    },
    eventPending ? 202 : 200,
  );
});

cardRoutes.get(
  "/projects/:pid/board",
  requireUser,
  requireProjectMember,
  async (c) => {
    const project = c.get("project");
    const seq = await c.env.BOARD_DO.getByName(project.id).getSeq();
    const rows = await c.env.DB.prepare(
      `${CARD_SELECT} WHERE c.project_id = ?1 ORDER BY c.priority DESC, c.updated_at DESC`,
    )
      .bind(project.id)
      .all<CardWithNames>();

    const columns: Record<string, CardWithNames[]> = {
      open: [],
      engaged: [],
      running: [],
      review: [],
      closed: [],
    };
    for (const card of rows.results) columns[card.status]?.push(card);

    return c.json({
      seq,
      project: {
        id: project.id,
        slug: project.slug,
        name: project.name,
        verification_mode: project.verification_mode,
        role: c.get("projectRole"),
      },
      columns,
    });
  },
);

cardRoutes.get(
  "/projects/:pid/cards",
  requireUser,
  requireProjectMember,
  async (c) => {
    const project = c.get("project");
    const status = c.req.query("status");
    const limit = parseLimit(c.req.query("limit"), 50, 200);
    const filters = ["c.project_id = ?1"];
    const bindings: unknown[] = [project.id];

    if (status) {
      filters.push(`c.status = ?${bindings.length + 1}`);
      bindings.push(status);
    }

    const cursorRaw = c.req.query("cursor");
    if (cursorRaw) {
      try {
        const cursor = JSON.parse(atob(cursorRaw)) as { updated_at: string; id: string };
        filters.push(
          `(c.updated_at < ?${bindings.length + 1} OR (c.updated_at = ?${bindings.length + 1} AND c.id < ?${bindings.length + 2}))`,
        );
        bindings.push(cursor.updated_at, cursor.id);
      } catch {
        throw new HttpError(400, "INVALID_ARGUMENT", "invalid cursor");
      }
    }

    bindings.push(limit + 1);
    const rows = await c.env.DB.prepare(
      `${CARD_SELECT} WHERE ${filters.join(" AND ")}
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT ?${bindings.length}`,
    )
      .bind(...bindings)
      .all<CardWithNames>();

    const hasMore = rows.results.length > limit;
    const cards = hasMore ? rows.results.slice(0, limit) : rows.results;
    const last = cards.at(-1);
    const nextCursor =
      hasMore && last ? btoa(JSON.stringify({ updated_at: last.updated_at, id: last.id })) : null;
    return c.json({ cards, next_cursor: nextCursor });
  },
);

cardRoutes.get("/cards/:cid", requireUser, async (c) => {
  const card = await loadCardForUser(c, c.req.param("cid"));
  const [detailed, events] = await Promise.all([
    c.env.DB.prepare(`${CARD_SELECT} WHERE c.id = ?1`).bind(card.id).first<CardWithNames>(),
    c.env.DB.prepare(
      "SELECT * FROM card_events WHERE card_id = ?1 ORDER BY seq ASC LIMIT 500",
    )
      .bind(card.id)
      .all<CardEventRow>(),
  ]);
  return c.json({ card: detailed ?? card, events: events.results });
});

cardRoutes.patch("/cards/:cid", requireUser, async (c) => {
  const card = await loadCardForUser(c, c.req.param("cid"));
  const expected = parseIfMatch(c);
  if (card.version !== expected) versionConflict(expected, card.version);
  const body = await parseBody(c, patchCardSchema);

  const next = {
    title: body.title ?? card.title,
    body: body.body === undefined ? card.body : body.body,
    priority: body.priority ?? card.priority,
    criteria_json:
      body.criteria === undefined ? card.criteria_json : JSON.stringify(body.criteria),
    deadline_at: body.deadline_at === undefined ? card.deadline_at : body.deadline_at,
    assignee_agent_id:
      body.assignee_agent_id === undefined ? card.assignee_agent_id : body.assignee_agent_id,
  };

  if (next.assignee_agent_id) {
    const resolved = await resolveProjectAgentReference(c.env.DB, card.project_id, next.assignee_agent_id);
    if (!resolved) throw new HttpError(400, "INVALID_ARGUMENT", "assignee is not a member of this project");
    next.assignee_agent_id = resolved;
    const agent = await c.env.DB.prepare(
      `SELECT ap.agent_id
         FROM agent_projects ap
         JOIN projects p ON p.id = ap.project_id
        WHERE ap.agent_id = ?1 AND ap.project_id = ?2 AND ap.status = 'active'
          AND p.archived_at IS NULL`,
    )
      .bind(next.assignee_agent_id, card.project_id)
      .first();
    if (!agent) throw new HttpError(400, "INVALID_ARGUMENT", "assignee is not an active member of this project");
  }

  const now = nowIso();
  const mutation = c.env.DB.prepare(
    `UPDATE cards SET title = ?1, body = ?2, priority = ?3, criteria_json = ?4,
            deadline_at = ?5, assignee_agent_id = ?6, version = version + 1, updated_at = ?7
      WHERE id = ?8 AND version = ?9`,
  )
    .bind(
      next.title,
      next.body,
      next.priority,
      next.criteria_json,
      next.deadline_at,
      next.assignee_agent_id,
      now,
      card.id,
      expected,
    );

  const { seq, eventId, eventPending, card: updated } = await appendCardEvent(c, card, "card.updated", {
    before: {
      title: card.title,
      body: card.body,
      priority: card.priority,
      criteria_json: card.criteria_json,
      deadline_at: card.deadline_at,
      assignee_agent_id: card.assignee_agent_id,
    },
    after: next,
  }, undefined, mutation);
  return c.json({ card: updated, seq, event_id: eventId, event_pending: eventPending }, eventPending ? 202 : 200);
});

cardRoutes.post("/cards/:cid/close", requireUser, async (c) => {
  const card = await loadCardForUser(c, c.req.param("cid"));
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
  const { seq, eventId, eventPending, card: updated } = await appendCardEvent(c, card, "card.closed", {
    from: card.status,
    to: "closed",
    outcome: "cancelled",
    reason: body.reason,
  }, undefined, [...retireCardWork(c.env.DB, card, now), cardWrite]);
  return c.json({ card: updated, seq, event_id: eventId, event_pending: eventPending }, eventPending ? 202 : 200);
});

cardRoutes.post("/cards/:cid/reopen", requireUser, async (c) => {
  const card = await loadCardForUser(c, c.req.param("cid"));
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
  const { seq, eventId, eventPending, card: updated } = await appendCardEvent(c, card, "card.reopened", {
    from: "closed",
    to: "open",
    round: card.round + 1,
    reason: body.reason ?? null,
  }, undefined, [...retireCardWork(c.env.DB, card, now), cardWrite]);
  return c.json({ card: updated, seq, event_id: eventId, event_pending: eventPending }, eventPending ? 202 : 200);
});

cardRoutes.get("/cards/:cid/negotiation", requireUser, async (c) => {
  const card = await loadCardForUser(c, c.req.param("cid"));
  const session = await c.env.DB.prepare(
    "SELECT * FROM negotiation_sessions WHERE card_id = ?1 ORDER BY round DESC LIMIT 1",
  )
    .bind(card.id)
    .first<NegotiationSessionRow>();
  const [proposals, contract, attempts, evidence] = await Promise.all([
    session
      ? c.env.DB.prepare(
          "SELECT * FROM proposals WHERE session_id = ?1 ORDER BY seq_in_session ASC",
        )
          .bind(session.id)
          .all<ProposalRow>()
      : Promise.resolve({ results: [] as ProposalRow[] }),
    c.env.DB.prepare(
      "SELECT * FROM contracts WHERE card_id = ?1 ORDER BY created_at DESC LIMIT 1",
    )
      .bind(card.id)
      .first<ContractRow>(),
    c.env.DB.prepare("SELECT * FROM attempts WHERE card_id = ?1 ORDER BY attempt_no DESC")
      .bind(card.id)
      .all(),
    c.env.DB.prepare("SELECT * FROM evidence WHERE card_id = ?1 ORDER BY created_at DESC")
      .bind(card.id)
      .all(),
  ]);
  return c.json({
    session,
    proposals: proposals.results,
    contract,
    attempts: attempts.results,
    evidence: evidence.results,
  });
});

cardRoutes.get("/cards/:cid/events", requireUser, async (c) => {
  const card = await loadCardForUser(c, c.req.param("cid"));
  const since = Number(c.req.query("since") ?? "0") || 0;
  const limit = parseLimit(c.req.query("limit"), 200, 500);
  const rows = await c.env.DB.prepare(
    "SELECT * FROM card_events WHERE card_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3",
  )
    .bind(card.id, since, limit)
    .all<CardEventRow>();
  return c.json({ events: rows.results });
});
