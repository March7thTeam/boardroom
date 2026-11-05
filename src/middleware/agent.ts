import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../context";
import { constantTimeEqual, tokenHash } from "../lib/crypto";
import { HttpError } from "../lib/http-error";
import { nowIso } from "../lib/time";
import { bearerToken, parseAgentToken, parseScopedAgentRef } from "../lib/tokens";
import type { AgentRow } from "../types";
import { shouldTouchPresence } from "../domain/presence";

interface AgentTokenRow extends AgentRow {
  token_id: string;
  token_hash: string;
  token_expires_at: string;
  token_project_id: string;
  membership_status: "pending" | "active" | "disabled";
  membership_slug: string | null;
  membership_display_name: string | null;
  membership_token_version: number;
}

const TOKEN_SELECT = `SELECT t.id AS token_id, t.hash AS token_hash, t.expires_at AS token_expires_at,
            t.project_id AS token_project_id,
            ap.status AS membership_status,
            ap.local_slug AS membership_slug,
            ap.display_name AS membership_display_name,
            ap.token_version AS membership_token_version,
            a.*
       FROM agent_tokens t
       JOIN agents a ON a.id = t.agent_id
       JOIN agent_projects ap ON ap.agent_id = t.agent_id AND ap.project_id = t.project_id`;

export async function authenticateAgentToken(db: D1Database, raw: string | null, pepper: string) {
  if (!raw) throw new HttpError(401, "UNAUTHENTICATED", "missing agent token");
  const parsed = parseAgentToken(raw);
  if (!parsed) throw new HttpError(401, "UNAUTHENTICATED", "invalid agent token format");

  // Tokens carry `<project_id>:<local_slug>` as payload; the identity is
  // resolved through the membership row and never depends on the mutable
  // project slug. A token is bound to exactly one project
  // (`agentCredentialProject`); routes must refuse any other project.
  const scoped = parseScopedAgentRef(parsed.agentId);
  if (!scoped) throw new HttpError(401, "UNAUTHENTICATED", "invalid agent token format");
  const membership = await db.prepare(
    "SELECT agent_id FROM agent_projects WHERE project_id = ?1 AND local_slug = ?2",
  )
    .bind(scoped.projectId, scoped.localSlug)
    .first<{ agent_id: string }>();
  if (!membership) throw new HttpError(401, "UNAUTHENTICATED", "agent token not found or revoked");

  const { results: candidates } = await db.prepare(
    `${TOKEN_SELECT}
      WHERE t.agent_id = ?1 AND t.project_id = ?2
        AND t.revoked_at IS NULL
        AND t.version = ap.token_version
      ORDER BY t.version DESC`,
  )
    .bind(membership.agent_id, scoped.projectId)
    .all<AgentTokenRow>();

  const expected = await tokenHash(parsed.secret, pepper);
  const row = candidates.find((candidate) => constantTimeEqual(expected, candidate.token_hash));
  if (!row) throw new HttpError(401, "UNAUTHENTICATED", "agent token not found or revoked");
  if (row.membership_status === "disabled") {
    throw new HttpError(403, "FORBIDDEN", "agent is disabled in this project");
  }
  if (new Date(row.token_expires_at).getTime() <= Date.now()) {
    throw new HttpError(401, "UNAUTHENTICATED", "agent token expired");
  }

  const agent: AgentRow = {
    id: row.id,
    // Project context comes from the token, not from the agent's home project.
    project_id: row.token_project_id,
    slug: row.membership_slug ?? row.slug,
    status: row.membership_status,
    harness: row.harness,
    harness_version: row.harness_version,
    harness_raw: row.harness_raw,
    self_reported_name: row.self_reported_name,
    display_name: row.membership_display_name ?? row.display_name,
    avatar_key: row.avatar_key,
    capabilities_json: row.capabilities_json,
    max_concurrency: row.max_concurrency,
    token_version: row.membership_token_version,
    last_seen_at: row.last_seen_at ?? null,
    edited_by: row.edited_by,
    edited_at: row.edited_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  return { agent, tokenId: row.token_id, projectId: row.token_project_id, scopedProjectId: scoped.projectId, version: row.membership_token_version };
}

export const requireAgent: MiddlewareHandler<AppEnv> = async (c, next) => {
  const credential = await authenticateAgentToken(c.env.DB, bearerToken(c.req.raw), c.env.TOKEN_PEPPER);
  c.executionCtx.waitUntil(c.env.DB.prepare(
    "UPDATE agent_tokens SET last_used_day = ?1 WHERE id = ?2 AND (last_used_day IS NULL OR last_used_day <> ?1)",
  ).bind(nowIso().slice(0, 10), credential.tokenId).run().catch(() => undefined));
  // Preserve the presence signal on authenticated requests.
  const seenAt = nowIso();
  if (shouldTouchPresence(credential.agent.last_seen_at, Date.parse(seenAt))) {
    try {
      await c.env.DB.prepare("UPDATE agents SET last_seen_at = ?1 WHERE id = ?2")
        .bind(seenAt, credential.agent.id).run();
      credential.agent.last_seen_at = seenAt;
    } catch {
      // A failed heartbeat leaves the previous presence observation unchanged.
    }
  }
  c.set("agent", credential.agent);
  c.set("agentCredentialProject", credential.scopedProjectId);
  await next();
};
