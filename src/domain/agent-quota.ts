import { HttpError } from "../lib/http-error";

/**
 * Enrollment quota (issue #3).
 *
 * `project_tokens.max_agents` caps how many agents a project may enroll. The
 * check is embedded as a predicate in the conditional `INSERT … SELECT … WHERE`
 * that creates the membership, so counting and inserting happen in the same
 * statement (and, for registration, the same batch/transaction): concurrent
 * requests cannot both slip under the limit.
 *
 * Counting rules:
 * - an agent that already holds a membership in the project always passes
 *   (re-registration, token rotation);
 * - `disabled` memberships do not count, so disabling an agent frees its slot.
 *
 * Arguments are the positional parameter numbers (`?N`) of agent_id,
 * project_id and max_agents in the enclosing statement.
 */
export function quotaPredicate(agentParam: number, projectParam: number, maxParam: number): string {
  return `(EXISTS (SELECT 1 FROM agent_projects WHERE agent_id = ?${agentParam} AND project_id = ?${projectParam})
    OR (SELECT COUNT(*) FROM agent_projects WHERE project_id = ?${projectParam} AND status <> 'disabled') < ?${maxParam})`;
}

function projectLimitSql(projectParameter: string): string {
  // Expiration ends enrollment authority, not the project's capacity policy.
  // Prefer an unrevoked enrollment; otherwise retain the most recent limit.
  return `COALESCE((SELECT max_agents FROM project_tokens
    WHERE project_id = ${projectParameter}
    ORDER BY (revoked_at IS NULL) DESC, created_at DESC, id DESC LIMIT 1), 50)`;
}

/** Only disabled -> active adds an occupied slot; check it inside the UPDATE. */
export function agentActivationQuotaPredicate(projectParam: number, statusParam: number): string {
  return `(?${statusParam} = 'disabled' OR agent_projects.status <> 'disabled'
    OR (SELECT COUNT(*) FROM agent_projects occupied
        WHERE occupied.project_id = ?${projectParam} AND occupied.status <> 'disabled')
      < ${projectLimitSql(`?${projectParam}`)})`;
}

/** Classify a failed guarded status UPDATE without mistaking a stale token for quota. */
export async function rejectAgentStatusUpdate(
  db: D1Database, agentId: string, projectId: string, expectedVersion: number,
  nextStatus: "active" | "disabled",
): Promise<never> {
  const current = await db.prepare(`SELECT ap.token_version, ap.status,
      (SELECT COUNT(*) FROM agent_projects occupied
       WHERE occupied.project_id = ?2 AND occupied.status <> 'disabled') AS occupied,
      ${projectLimitSql("?2")} AS max_agents
    FROM agent_projects ap WHERE ap.agent_id = ?1 AND ap.project_id = ?2`)
    .bind(agentId, projectId)
    .first<{ token_version: number; status: string; occupied: number; max_agents: number }>();
  if (current?.token_version === expectedVersion && nextStatus === "active" &&
      current.status === "disabled" && current.occupied >= current.max_agents) {
    throw new HttpError(403, "QUOTA_EXCEEDED", "project has no free agent slots", {
      max_agents: current.max_agents, occupied: current.occupied,
    });
  }
  throw new HttpError(409, "CONFLICT", "agent credentials or membership changed; reload before changing status");
}
