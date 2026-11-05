import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../context";
import { assertAgentProjectAccess } from "../domain/agent-projects";
import { HttpError } from "../lib/http-error";
import { isAdmin } from "./identity";
import type { ProjectRow } from "../types";

export async function loadProjectIncludingArchived(
  c: Context<AppEnv>,
  projectId: string,
): Promise<ProjectRow> {
  const project = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?1")
    .bind(projectId)
    .first<ProjectRow>();
  if (!project) throw new HttpError(404, "NOT_FOUND", "project not found");
  return project;
}

export async function loadProject(c: Context<AppEnv>, projectId: string): Promise<ProjectRow> {
  const project = await loadProjectIncludingArchived(c, projectId);
  if (project.archived_at) throw new HttpError(404, "NOT_FOUND", "project not found");
  return project;
}

export const requireProjectMember: MiddlewareHandler<AppEnv> = async (c, next) => {
  const project = await loadProject(c, c.req.param("pid")!);
  const user = c.get("user");
  const membership = await c.env.DB.prepare(
    "SELECT role FROM project_members WHERE project_id = ?1 AND user_id = ?2",
  )
    .bind(project.id, user.id)
    .first<{ role: "owner" | "member" }>();

  const role = membership?.role ?? (isAdmin(user) ? "owner" : null);
  if (!role) throw new HttpError(404, "NOT_FOUND", "project not found");
  c.set("project", project);
  c.set("projectRole", role);
  c.set("projectAccess", membership ? "member" : "admin");
  await next();
};

export const requireProjectOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
  const role = c.get("projectRole");
  if (role !== "owner") throw new HttpError(403, "FORBIDDEN", "project owner required");
  await next();
};

export const requireAgentProject: MiddlewareHandler<AppEnv> = async (c, next) => {
  const project = await loadProject(c, c.req.param("pid")!);
  const agent = c.get("agent");
  const scope = c.get("agentCredentialProject");
  if (scope !== project.id) {
    throw new HttpError(403, "CREDENTIAL_SCOPE_MISMATCH", "agent token is bound to another project");
  }
  await assertAgentProjectAccess(c.env.DB, agent.id, project.id);
  c.set("project", project);
  c.set("projectRole", "member");
  c.set("projectAccess", "member");
  await next();
};
