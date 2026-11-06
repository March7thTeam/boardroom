import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { HttpError } from "../lib/http-error";
import { parseBody } from "../lib/http";
import { addDaysIso, nowIso } from "../lib/time";
import { randomSecret, tokenHash } from "../lib/crypto";
import { newId } from "../lib/ids";
import { formatAgentToken, formatScopedAgentRef, parseScopedAgentRef } from "../lib/tokens";
import { isAdmin, requireUser } from "../middleware/identity";
import { resolveProjectAgentReference } from "../domain/agent-projects";
import type { AgentRow } from "../types";

export const agentRoutes = new Hono<AppEnv>();

const profileSchema = z.object({
  display_name: z.string().max(64).nullable().optional(),
  avatar_key: z.string().max(200).nullable().optional(),
});

type AgentMembershipRow = {
  project_id: string; slug: string; name: string;
  project_status: "pending" | "active" | "disabled";
  role: "owner" | "admin" | "member" | null;
  local_slug: string | null; display_name: string | null; token_version: number;
};

async function loadAgentForUser(c: Context<AppEnv>, reference: string, requestedProject?: string) {
  const user = c.get("user");
  const requested = requestedProject ?? c.req.query("project_id") ?? parseScopedAgentRef(reference)?.projectId;
  const resolved = requested ? await resolveProjectAgentReference(c.env.DB,requested,reference) : null;
  if (!resolved) throw new HttpError(404,"NOT_FOUND","agent not found in this project");
  const agent = await c.env.DB.prepare("SELECT * FROM agents WHERE id=?1").bind(resolved).first<AgentRow>();
  if (!agent) throw new HttpError(404,"NOT_FOUND","agent not found");
  const rows = await c.env.DB.prepare(`SELECT ap.project_id,p.slug,p.name,ap.status AS project_status,
      ap.local_slug,ap.display_name,ap.token_version,pm.role
    FROM agent_projects ap JOIN projects p ON p.id=ap.project_id AND p.archived_at IS NULL
    LEFT JOIN project_members pm ON pm.project_id=ap.project_id AND pm.user_id=?2
    WHERE ap.agent_id=?1 ORDER BY ap.assigned_at ASC`).bind(agent.id,user.id).all<AgentMembershipRow>();
  const accessible = rows.results.filter(row=>isAdmin(user)||row.role!==null);
  const membership = accessible.find(row=>row.project_id===requested);
  if (!membership) throw new HttpError(404,"NOT_FOUND","agent not found in this project");
  const pid = membership.project_id;
  const role = isAdmin(user) ? "owner" : membership.role!;
  const view = {...agent,id:formatScopedAgentRef(pid,membership.local_slug ?? agent.slug),internal_id:agent.id,
    project_id:pid,slug:membership.local_slug ?? agent.slug,status:membership.project_status,
    token_version:membership.token_version,display_name:membership.display_name ?? agent.display_name};
  return {agent,role,membership,view,memberships:[membership]};
}

agentRoutes.get("/agents/:aid", requireUser, async (c) => {
  const { agent, role, memberships, membership, view } = await loadAgentForUser(c, c.req.param("aid"));
  const registrations = await c.env.DB.prepare(
    `SELECT harness, harness_version, self_reported_name, project_id, registered_at
       FROM agent_registrations
      WHERE agent_id = ?1 AND project_id = ?2
      ORDER BY registered_at DESC
      LIMIT 5`,
  )
    .bind(agent.id,membership.project_id)
    .all();
  return c.json({
    agent: view,
    role,
    projects: memberships.map((row) => ({
      id: row.project_id,
      slug: row.slug,
      name: row.name,
      status: row.project_status,
      role: row.role,
    })),
    registrations: registrations.results,
  });
});

agentRoutes.patch("/agents/:aid/profile", requireUser, async (c) => {
  const {agent,role,membership,view} = await loadAgentForUser(c,c.req.param("aid"));
  if(role!=="owner") throw new HttpError(403,"FORBIDDEN","project owner required");
  const body=await parseBody(c,profileSchema);
  const name=body.display_name===undefined?membership.display_name:body.display_name;
  const now=nowIso();
  const statements=[c.env.DB.prepare(`UPDATE agent_projects SET display_name=?1,updated_at=?2
    WHERE agent_id=?3 AND project_id=?4 AND token_version=?5`).bind(name,now,agent.id,membership.project_id,membership.token_version)];
  if(body.avatar_key!==undefined) statements.push(c.env.DB.prepare(`UPDATE agents SET avatar_key=?1,edited_by=?2,edited_at=?3,updated_at=?3
    WHERE id=?4 AND changes()=1`).bind(body.avatar_key,c.get("user").id,now,agent.id));
  const writes=await c.env.DB.batch(statements);
  if(writes[0].meta.changes!==1) throw new HttpError(409,"CONFLICT","agent credentials changed; reload before editing");
  return c.json({agent:{...view,display_name:name,avatar_key:body.avatar_key===undefined?view.avatar_key:body.avatar_key}});
});

/** Recover only this project's credential; disabled memberships stay disabled. */
agentRoutes.post("/agents/:aid/token", requireUser, async (c) => {
  const body = await parseBody(c, z.object({ project_id: z.string().min(1).optional() }));
  const { agent, membership: selected } = await loadAgentForUser(c, c.req.param("aid"), body.project_id);
  const pid = selected.project_id;
  const user = c.get("user");
  const access = await c.env.DB.prepare(`SELECT ap.local_slug,ap.token_version,ap.status,pm.role
    FROM agent_projects ap JOIN projects p ON p.id=ap.project_id AND p.archived_at IS NULL
    LEFT JOIN project_members pm ON pm.project_id=ap.project_id AND pm.user_id=?3
    WHERE ap.agent_id=?1 AND ap.project_id=?2`).bind(agent.id,pid,user.id)
    .first<{ local_slug: string | null; token_version: number; status: string; role: string | null }>();
  if (!access || (!isAdmin(user) && access.role !== "owner")) throw new HttpError(403,"FORBIDDEN","project owner required");
  const id = newId("tok"); const now = nowIso(); const expires = addDaysIso(90);
  const scoped = formatScopedAgentRef(pid,access.local_slug ?? agent.slug);
  const plaintext = formatAgentToken(scoped,randomSecret());
  const secret = plaintext.slice(plaintext.lastIndexOf(".")+1);
  const version = access.token_version+1;
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE agent_projects SET token_version=?1,status=CASE WHEN status='disabled' THEN 'disabled' ELSE 'pending' END,updated_at=?2
      WHERE agent_id=?3 AND project_id=?4 AND token_version=?5`).bind(version,now,agent.id,pid,access.token_version),
    c.env.DB.prepare(`INSERT INTO agent_tokens(id,agent_id,project_id,prefix,hash,version,issued_at,expires_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE changes()=1`).bind(id,agent.id,pid,plaintext.slice(0,12),await tokenHash(secret,c.env.TOKEN_PEPPER),version,now,expires),
    c.env.DB.prepare(`UPDATE agent_tokens SET revoked_at=?1 WHERE agent_id=?2 AND project_id=?3 AND id<>?4 AND revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM agent_tokens WHERE id=?4)`).bind(now,agent.id,pid,id),
  ]);
  if (results[0].meta.changes !== 1) throw new HttpError(409,"CONFLICT","agent credentials changed; reload before recovery");
  return c.json({id:scoped,status:access.status==="disabled"?"disabled":"pending",agent_token:plaintext,token_version:version,token_expires_at:expires},201);
});
