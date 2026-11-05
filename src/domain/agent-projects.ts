import { HttpError } from "../lib/http-error";
import { parseScopedAgentRef } from "../lib/tokens";
import type { AgentProjectRow } from "../types";

export interface AgentProjectWithProject extends AgentProjectRow {
  slug: string;
  name: string;
  archived_at: string | null;
}

export async function listAgentProjects(
  db: D1Database,
  agentId: string,
): Promise<AgentProjectWithProject[]> {
  const rows = await db
    .prepare(
      `SELECT ap.agent_id, ap.project_id, ap.status, ap.local_slug, ap.display_name,
              ap.token_version, ap.assigned_by, ap.assigned_at,
              ap.updated_at, p.slug, p.name, p.archived_at
         FROM agent_projects ap
         JOIN projects p ON p.id = ap.project_id
        WHERE ap.agent_id = ?1
        ORDER BY ap.assigned_at ASC`,
    )
    .bind(agentId)
    .all<AgentProjectWithProject>();
  return rows.results;
}

export async function getAgentProject(
  db: D1Database,
  agentId: string,
  projectId: string,
): Promise<AgentProjectWithProject | null> {
  return db
    .prepare(
      `SELECT ap.agent_id, ap.project_id, ap.status, ap.local_slug, ap.display_name,
              ap.token_version, ap.assigned_by, ap.assigned_at,
              ap.updated_at, p.slug, p.name, p.archived_at
         FROM agent_projects ap
         JOIN projects p ON p.id = ap.project_id
        WHERE ap.agent_id = ?1 AND ap.project_id = ?2`,
    )
    .bind(agentId, projectId)
    .first<AgentProjectWithProject>();
}

/**
 * Enforce that an agent may operate in a project. Archived projects and
 * missing memberships are indistinguishable from "not found" to avoid leaking
 * project existence, except for archived membership which returns an explicit
 * PROJECT_ARCHIVED code (the agent already knows it belongs there).
 */
export async function assertAgentProjectAccess(
  db: D1Database,
  agentId: string,
  projectId: string,
  opts: { active?: boolean } = {},
): Promise<AgentProjectWithProject> {
  const row = await getAgentProject(db, agentId, projectId);
  if (!row) throw new HttpError(404, "NOT_FOUND", "project not found");
  if (row.archived_at) throw new HttpError(403, "PROJECT_ARCHIVED", "project is archived");
  if (row.status === "disabled") {
    throw new HttpError(403, "FORBIDDEN", "agent is disabled in this project");
  }
  if (opts.active !== false && row.status !== "active") {
    throw new HttpError(403, "FORBIDDEN", `agent is ${row.status} in this project, activation required`);
  }
  return row;
}

/** Live project-local slugs; used to allocate one for a joining agent. */
export async function listLocalSlugs(db: D1Database, projectId: string): Promise<string[]> {
  const rows = await db
    .prepare("SELECT local_slug FROM agent_projects WHERE project_id = ?1 AND local_slug IS NOT NULL")
    .bind(projectId)
    .all<{ local_slug: string }>();
  return rows.results.map((row) => row.local_slug);
}

/**
 * Allocate a project-local slug from a preferred base, suffixing `-2`, `-3`, …
 * Kept pure so it can be unit-tested without a database.
 */
export function allocateLocalSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const normalized = base.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  const root = normalized.slice(0, 32);
  if (!used.has(root)) return root;
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${root.slice(0, 32 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new HttpError(409, "LOCAL_SLUG_EXHAUSTED", "unable to allocate a local slug in this project");
}

/** Resolve `<project_id>:<local_slug>` to the per-project agent row. */
export async function findAgentIdByLocalSlug(
  db: D1Database,
  projectId: string,
  localSlug: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT agent_id FROM agent_projects WHERE project_id = ?1 AND local_slug = ?2")
    .bind(projectId, localSlug)
    .first<{ agent_id: string }>();
  return row?.agent_id ?? null;
}

/** Resolve `<project_id>:<local_slug>` inside an already authorized project context. */
export async function resolveProjectAgentReference(
  db: D1Database,
  projectId: string,
  reference: string,
): Promise<string | null> {
  const scoped = parseScopedAgentRef(reference);
  if (!scoped || scoped.projectId !== projectId) return null;
  return findAgentIdByLocalSlug(db, projectId, scoped.localSlug);
}
