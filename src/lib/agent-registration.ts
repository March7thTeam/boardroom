import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { AgentRow, ProjectRow } from "../types";
import { allocateLocalSlug, getAgentProject, listLocalSlugs } from "../domain/agent-projects";
import { quotaPredicate } from "../domain/agent-quota";
import { authenticateAgentToken } from "../middleware/agent";
import { constantTimeEqual, randomSecret, tokenHash } from "./crypto";
import { HttpError } from "./http-error";
import { newId } from "./ids";
import { addDaysIso, nowIso } from "./time";
import { bearerToken, formatAgentToken, formatScopedAgentRef, parseEnrollmentToken, parseScopedAgentRef } from "./tokens";

export interface RegistrationInput {
  id: string; harness: string; harness_version: string; name?: string;
  card?: { description?: string; skills?: Array<{ key: string; level?: string }>; max_concurrency?: number };
  rotate_token: boolean;
}
interface Enrollment { id: string; hash: string; max_agents: number; expires_at: string }
type Gate = { sql: string; values: unknown[] };
function gated(db: D1Database, sql: string, values: unknown[], gate: Gate) {
  const shifted = gate.sql.replace(/\?(\d+)/g, (_, n: string) => `?${values.length + Number(n)}`);
  return db.prepare(sql.replaceAll("/* gate */", shifted)).bind(...values, ...gate.values);
}
async function enrollment(c: Context<AppEnv>, raw: string | null) {
  const parsed = parseEnrollmentToken(raw ?? "");
  if (!parsed) throw new HttpError(401, "UNAUTHENTICATED", "invalid enrollment token");
  const project = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?1 AND archived_at IS NULL").bind(parsed.projectId).first<ProjectRow>();
  const rows = await c.env.DB.prepare("SELECT * FROM project_tokens WHERE project_id = ?1 AND revoked_at IS NULL AND expires_at > ?2").bind(parsed.projectId, nowIso()).all<Enrollment>();
  const hash = await tokenHash(parsed.secret, c.env.TOKEN_PEPPER);
  const token = rows.results.find(row => constantTimeEqual(hash, row.hash));
  if (!project || !token) throw new HttpError(401, "UNAUTHENTICATED", "enrollment token is not valid");
  return { project, token };
}
function enrollmentGate(token: Enrollment): Gate {
  return { sql: "EXISTS (SELECT 1 FROM project_tokens pt JOIN projects p ON p.id=pt.project_id WHERE pt.id=?1 AND pt.revoked_at IS NULL AND pt.expires_at>?2 AND p.archived_at IS NULL)", values: [token.id, nowIso()] };
}
function combine(...gates: Gate[]): Gate {
  const values: unknown[] = [];
  const sql = gates.map(g => { const s = g.sql.replace(/\?(\d+)/g, (_, n: string) => `?${values.length + Number(n)}`); values.push(...g.values); return `(${s})`; }).join(" AND ");
  return { sql, values };
}
function proofGate(proof: Awaited<ReturnType<typeof authenticateAgentToken>>): Gate {
  return { sql: `EXISTS (SELECT 1 FROM agent_tokens t JOIN agent_projects ap ON ap.agent_id=t.agent_id AND ap.project_id=t.project_id
    WHERE t.id=?1 AND t.agent_id=?2 AND t.project_id=?3 AND t.version=?4 AND ap.token_version=t.version
      AND t.revoked_at IS NULL AND t.expires_at>?5 AND ap.status<>'disabled')`, values: [proof.tokenId, proof.agent.id, proof.projectId, proof.version, nowIso()] };
}
function history(db: D1Database, aid: string, pid: string, harness: string, version: string, name: string | null, body: unknown, now: string, gate: Gate) {
  return gated(db, `INSERT INTO agent_registrations(agent_id,project_id,harness,harness_version,self_reported_name,raw_payload,registered_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE /* gate */`, [aid,pid,harness,version,name,JSON.stringify(body),now], gate);
}
function trimHistory(db: D1Database, aid: string, pid: string) {
  return db.prepare(`DELETE FROM agent_registrations WHERE changes()=1 AND agent_id=?1 AND project_id=?2 AND id NOT IN
    (SELECT id FROM agent_registrations WHERE agent_id=?1 AND project_id=?2 ORDER BY id DESC LIMIT 50)`).bind(aid,pid);
}
async function tokenMaterial(aid: string, pid: string, slug: string, version: number, pepper: string) {
  const secret = randomSecret(); const token = formatAgentToken(formatScopedAgentRef(pid, slug), secret);
  return { id: newId("tok"), aid, pid, token, hash: await tokenHash(secret, pepper), version, expires: addDaysIso(90) };
}
function insertToken(db: D1Database, material: Awaited<ReturnType<typeof tokenMaterial>>, now: string) {
  return db.prepare(`INSERT INTO agent_tokens(id,agent_id,project_id,prefix,hash,version,issued_at,expires_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE changes()=1`).bind(material.id,material.aid,material.pid,material.token.slice(0,12),material.hash,material.version,now,material.expires);
}
function revokeOthers(db: D1Database, material: Awaited<ReturnType<typeof tokenMaterial>>, now: string) {
  return db.prepare(`UPDATE agent_tokens SET revoked_at=?1 WHERE agent_id=?2 AND project_id=?3 AND id<>?4 AND revoked_at IS NULL
    AND EXISTS (SELECT 1 FROM agent_tokens WHERE id=?4)`).bind(now,material.aid,material.pid,material.id);
}
function issuedGate(id: string): Gate { return { sql: "EXISTS (SELECT 1 FROM agent_tokens WHERE id=?1)", values: [id] }; }
async function response(db: D1Database, aid: string, pid: string, slug: string, issued: string | null = null) {
  const agent = await db.prepare("SELECT * FROM agents WHERE id=?1").bind(aid).first<AgentRow>();
  const membership = await getAgentProject(db, aid, pid);
  const token = await db.prepare("SELECT expires_at FROM agent_tokens WHERE agent_id=?1 AND project_id=?2 AND revoked_at IS NULL ORDER BY version DESC LIMIT 1").bind(aid,pid).first<{expires_at:string}>();
  return { id:formatScopedAgentRef(pid,slug),status:membership?.status ?? "pending",resolved_name:membership?.display_name || agent?.display_name || agent?.self_reported_name || slug,
    agent_token:issued,token_expires_at:token?.expires_at ?? null,token_unchanged:issued===null };
}

export async function registerAgent(c: Context<AppEnv>, body: RegistrationInput) {
  const db=c.env.DB; const {project,token}=await enrollment(c,bearerToken(c.req.raw));
  const scoped=parseScopedAgentRef(body.id);
  if (!scoped || scoped.projectId!==project.id) throw new HttpError(403,"FORBIDDEN","agent id must be `<project_id>:<local_slug>` for the enrollment project");
  const slug=scoped.localSlug;
  const membership=await db.prepare("SELECT agent_id FROM agent_projects WHERE project_id=?1 AND local_slug=?2").bind(project.id,slug).first<{agent_id:string}>();
  if (!membership) return createAgent(c,body,project,token,slug);
  const aid=membership.agent_id;
  const existing=await db.prepare("SELECT * FROM agents WHERE id=?1").bind(aid).first<AgentRow>();
  if(!existing) throw new HttpError(404,"NOT_FOUND","agent not found");
  const holder=await db.prepare("SELECT agent_id FROM agent_projects WHERE project_id=?1 AND local_slug=?2 AND agent_id<>?3").bind(project.id,slug,aid).first();
  if(holder) throw new HttpError(409,"LOCAL_SLUG_TAKEN","this project slug is already assigned");
  const now=nowIso(); const harness=body.harness.trim().toLowerCase().replace(/[\s_-]*(cli|agent)$/g,"").replace(/\s+/g,"-");
  const version=body.harness_version.trim().slice(0,64); const name=body.name?.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g,"").trim().slice(0,64) || slug;
  const capabilities=JSON.stringify(body.card ?? {}); const concurrency=body.card?.max_concurrency ?? existing.max_concurrency ?? 1;
  const header=c.req.header("X-Agent-Authorization");
  if(!header) {
    if(body.rotate_token) throw new HttpError(403,"FORBIDDEN","current project agent credential is required to rotate");
    return response(db,aid,project.id,slug);
  }
  const raw=/^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? null;
  const proof=await authenticateAgentToken(db,raw,c.env.TOKEN_PEPPER);
  // The presenting credential must already be bound to this agent and project.
  if(proof.agent.id!==aid || proof.projectId!==project.id) throw new HttpError(403,"CREDENTIAL_SCOPE_MISMATCH","proof must belong to this agent and project");
  const gate=combine(proofGate(proof),enrollmentGate(token));
  const changed=body.rotate_token || body.name!==undefined || existing.harness!==harness || existing.harness_version!==version || existing.harness_raw!==body.harness || existing.self_reported_name!==name || existing.capabilities_json!==capabilities || existing.max_concurrency!==concurrency;
  if(!changed) return response(db,aid,project.id,slug);
  const statements=[gated(db,`UPDATE agents SET harness=?1,harness_version=?2,harness_raw=?3,self_reported_name=?4,capabilities_json=?5,max_concurrency=?6,updated_at=?7 WHERE id=?8 AND /* gate */`,[harness,version,body.harness,name,capabilities,concurrency,now,aid],gate)];
  let material: Awaited<ReturnType<typeof tokenMaterial>> | null=null;
  if(body.rotate_token) {
    material=await tokenMaterial(aid,project.id,slug,proof.version+1,c.env.TOKEN_PEPPER);
    statements.push(gated(db,"UPDATE agent_projects SET token_version=token_version+1,updated_at=?1 WHERE agent_id=?2 AND project_id=?3 AND token_version=?4 AND /* gate */",[now,aid,project.id,proof.version],gate),insertToken(db,material,now),revokeOthers(db,material,now));
  }
  const writeGate=material ? issuedGate(material.id) : gate;
  statements.push(history(db,aid,project.id,harness,version,name,body,now,writeGate),trimHistory(db,aid,project.id));
  const results=await db.batch(statements);
  if(results[0].meta.changes!==1) throw new HttpError(409,"CONFLICT","agent credentials changed; retry with current proof");
  return response(db,aid,project.id,slug,material?.token ?? null);
}

/** First registration in a project creates the global identity and a pending membership. */
async function createAgent(c: Context<AppEnv>, body: RegistrationInput,
  project: ProjectRow, token: Enrollment, slug: string) {
  const db=c.env.DB;
  const aid=newId("ag");
  const now=nowIso(); const harness=body.harness.trim().toLowerCase().replace(/[\s_-]*(cli|agent)$/g,"").replace(/\s+/g,"-");
  const version=body.harness_version.trim().slice(0,64); const name=body.name?.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g,"").trim().slice(0,64) || slug;
  const capabilities=JSON.stringify(body.card ?? {}); const concurrency=body.card?.max_concurrency ?? 1;
  const material=await tokenMaterial(aid,project.id,slug,1,c.env.TOKEN_PEPPER);
  // Quota predicate params are bound separately from the column values.
  const gate=combine(
    { sql: quotaPredicate(1,2,3), values: [aid,project.id,token.max_agents] },
    enrollmentGate(token),
  );
  try {
    await db.batch([
      gated(db,`INSERT INTO agents(id,slug,harness,harness_version,harness_raw,self_reported_name,capabilities_json,max_concurrency,created_at,updated_at)
        SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?9 WHERE /* gate */`,[aid,slug,harness,version,body.harness,name,capabilities,concurrency,now],gate),
      db.prepare(`INSERT INTO agent_projects(agent_id,project_id,status,local_slug,display_name,token_version,assigned_at,updated_at)
        SELECT ?1,?2,'pending',?3,?4,1,?5,?5 WHERE changes()=1`).bind(aid,project.id,slug,name,now),
      insertToken(db,material,now),
      history(db,aid,project.id,harness,version,name,body,now,issuedGate(material.id)), trimHistory(db,aid,project.id),
    ]);
  } catch { throw new HttpError(409,"CONFLICT","registration changed; retry with the current identity"); }
  const issued=await db.prepare("SELECT id FROM agent_tokens WHERE id=?1").bind(material.id).first();
  if(issued) return response(db,aid,project.id,slug,material.token);
  if(!await getAgentProject(db,aid,project.id)) throw new HttpError(403,"QUOTA_EXCEEDED","enrollment is no longer valid or project quota is exhausted");
  return response(db,aid,project.id,slug);
}

export async function joinAgentProject(c: Context<AppEnv>, body: {enrollment_token:string}) {
  const db=c.env.DB; const source=await authenticateAgentToken(db,bearerToken(c.req.raw),c.env.TOKEN_PEPPER);
  const {project,token}=await enrollment(c,body.enrollment_token); const agent=source.agent; const now=nowIso();
  const existing=await getAgentProject(db,agent.id,project.id);
  if(existing?.status==="disabled") throw new HttpError(403,"FORBIDDEN","agent is disabled in this project");
  const slug=existing?.local_slug ?? allocateLocalSlug(agent.slug,await listLocalSlugs(db,project.id));
  const live=await db.prepare("SELECT id FROM agent_tokens WHERE agent_id=?1 AND project_id=?2 AND revoked_at IS NULL AND expires_at>?3 AND version=?4").bind(agent.id,project.id,now,existing?.token_version ?? 1).first();
  if(!live) {
    const version=existing ? existing.token_version+1 : 1;
    const material=await tokenMaterial(agent.id,project.id,slug,version,c.env.TOKEN_PEPPER);
    const gate=combine(proofGate(source),enrollmentGate(token));
    const membershipRow=existing
      ? gated(db,"UPDATE agent_projects SET token_version=?1,local_slug=?2,updated_at=?3 WHERE agent_id=?4 AND project_id=?5 AND token_version=?6 AND status<>'disabled' AND /* gate */",[version,slug,now,agent.id,project.id,existing.token_version],gate)
      : gated(db,`INSERT INTO agent_projects(agent_id,project_id,status,local_slug,token_version,assigned_at,updated_at)
          SELECT ?1,?2,'pending',?3,1,?4,?4 WHERE ${quotaPredicate(1,2,5)} AND /* gate */`,[agent.id,project.id,slug,now,token.max_agents],gate);
    let writes;
    try { writes=await db.batch([membershipRow,insertToken(db,material,now),revokeOthers(db,material,now),history(db,agent.id,project.id,agent.harness,agent.harness_version,agent.self_reported_name,{via:"agent/projects"},now,issuedGate(material.id)),trimHistory(db,agent.id,project.id)]); }
    catch { throw new HttpError(409,"CONFLICT","membership changed; retry joining the project"); }
    if(writes[0].meta.changes!==1) throw new HttpError(existing?409:403,existing?"CONFLICT":"QUOTA_EXCEEDED","source credential, enrollment or project quota changed");
    const membership=await getAgentProject(db,agent.id,project.id);
    return {status:(existing?200:201) as 200|201,body:{project:{id:project.id,slug:project.slug,name:project.name},membership:{status:membership!.status,local_slug:slug,agent_id:formatScopedAgentRef(project.id,slug),assigned_at:membership!.assigned_at,updated_at:membership!.updated_at},agent_token:material.token,token_expires_at:material.expires,token_unchanged:false}};
  }
  const unchanged=await response(db,agent.id,project.id,slug);
  return {status:200 as const,body:{project:{id:project.id,slug:project.slug,name:project.name},membership:{status:existing!.status,local_slug:slug,agent_id:formatScopedAgentRef(project.id,slug),assigned_at:existing!.assigned_at,updated_at:existing!.updated_at},agent_token:null,token_expires_at:unchanged.token_expires_at,token_unchanged:true}};
}
