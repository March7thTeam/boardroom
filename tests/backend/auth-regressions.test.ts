import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../src/context";
import type { Env } from "../../src/types";
import { agentApiRoutes } from "../../src/routes/agent-api";
import { agentRoutes } from "../../src/routes/agents";
import { projectRoutes } from "../../src/routes/projects";
import { userRoutes } from "../../src/routes/users";
import { issueEnrollmentToken } from "../../src/lib/project-token";
import { createSession, principalCanReadProject, updatePassword } from "../../src/lib/session";
import type { UserRow } from "../../src/types";
import { authRoutes } from "../../src/routes/auth";
import { setupRoutes } from "../../src/routes/setup";
import { languageRoutes } from "../../src/routes/locale";
import { requireUser } from "../../src/middleware/identity";
import { hashPassword } from "../../src/lib/password";
import { sendAndLogEmail } from "../../src/providers/email";
import { HttpError } from "../../src/lib/http-error";
import { builtin, SqliteD1 } from "../helpers/sqlite-d1";
const fs = builtin<{readFileSync(path: URL, encoding: string): string; readdirSync(path: URL): string[]}>("node:fs");
const dbs: SqliteD1[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of dbs.splice(0)) db.sqlite.close(); });
async function fixture() {
 const db = new SqliteD1(); dbs.push(db);
 const root = new URL("../../migrations/", import.meta.url);
 for(const file of fs.readdirSync(root).filter(f=>f.endsWith(".sql")).sort()) db.sqlite.exec(fs.readFileSync(new URL(file,root),"utf8"));
 const env = {DB:db.asD1(), TOKEN_PEPPER:"test-pepper", ENVIRONMENT:"production", AUTH_MODE:"session"} as Env;
 const app = new Hono<AppEnv>();
 app.onError((e,c)=>c.json({error:{code:e instanceof HttpError?e.code:"INTERNAL"}},(e instanceof HttpError?e.status:500) as 500));
 app.route("/api/v1",projectRoutes); app.route("/agent",agentApiRoutes); app.route("/api/v1",agentRoutes); app.route("/api/v1",userRoutes); app.route("/api/v1",authRoutes); app.route("/api/v1",setupRoutes); app.route("/",languageRoutes);
 app.get("/protected",requireUser,c=>c.json({ok:true}));
 async function call(path:string,body?:unknown,cookie?:string,headers:Record<string,string>={},method=body===undefined?"GET":"POST") {
  return app.fetch(new Request("https://test.local"+path,{method,headers:{"Content-Type":"application/json",...(cookie?{Cookie:cookie}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{waitUntil(){},passThroughOnException(){}} as unknown as ExecutionContext);
 }
 return {db,env,call,app};
}
describe("auth security regressions",()=>{
 it("allows exactly one concurrent setup/bootstrap claim",async()=>{
  const f=await fixture();
  const responses=await Promise.all([f.call("/api/v1/auth/bootstrap",{email:"first@example.test",password:"secure-password-123"}),f.call("/api/v1/setup",{instance_name:"Test",admin:{email:"second@example.test",password:"secure-password-123"}})]);
  expect(responses.filter(r=>r.status===201)).toHaveLength(1);
  expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM users").get()?.n).toBe(1);
 });
 it("enforces temporary-password restrictions on the server",async()=>{
  const f=await fixture(); const password="temporary-password-123";
  f.db.sqlite.prepare("INSERT INTO users(id,email,role,password_hash,must_change_password) VALUES('u','user@example.test','member',?,1)").run(await hashPassword(password));
  const login=await f.call("/api/v1/auth/login",{email:"user@example.test",password});
  const cookie=login.headers.get("set-cookie")!.split(";")[0];
  expect((await f.call("/protected",undefined,cookie)).status).toBe(403);
  expect((await f.call("/api/v1/auth/me",undefined,cookie)).status).toBe(200);
 });
 it("does not persist email bodies or log temporary credentials",async()=>{
  const f=await fixture(); const log=vi.spyOn(console,"log").mockImplementation(()=>{});
  await sendAndLogEmail({...f.env,ENVIRONMENT:"development"},{to:"user@example.test",subject:"Invite",text:"temporary-credential-sentinel"});
  expect(f.db.sqlite.prepare("SELECT body_text FROM email_log").get()?.body_text).toBeNull();
  expect(JSON.stringify(log.mock.calls)).not.toContain("temporary-credential-sentinel");
 });
 it.each(["/\\external.test/path","/safe\npath"])("rejects unsafe redirect path %j",async(next)=>{
  const f=await fixture(); const result=await f.call("/language/en?next="+encodeURIComponent(next));
  expect(result.headers.get("location")).toBe("/");
 });
});

const PROJECT_A="prj_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROJECT_B="prj_01ARZ3NDEKTSV4RRFFQ69G5FAW";
async function seeded() {
 const f=await fixture();
 f.db.sqlite.exec(`INSERT INTO users(id,email,role) VALUES('owner','owner@example.test','admin');
 INSERT INTO projects(id,slug,name,created_by) VALUES('${PROJECT_A}','alpha','A','owner'),('${PROJECT_B}','bravo','B','owner');
 INSERT INTO project_members(project_id,user_id,role,added_by) VALUES('${PROJECT_A}','owner','owner','owner'),('${PROJECT_B}','owner','owner','owner');`);
 const enrollmentA=await issueEnrollmentToken(f.env.DB,PROJECT_A,'owner',f.env.TOKEN_PEPPER);
 const enrollmentB=await issueEnrollmentToken(f.env.DB,PROJECT_B,'owner',f.env.TOKEN_PEPPER);
 return {...f,enrollmentA,enrollmentB};
}
type RegistrationBody={agent_token:string|null;token_unchanged:boolean;id:string};
async function register(f:Awaited<ReturnType<typeof seeded>>,enrollment:string,pid=PROJECT_A,extra:Record<string,unknown>={},proof?:string) {
 const response=await f.call('/agent/register',{id:pid+':bot',harness:'codex',harness_version:'1',rotate_token:false,...extra},undefined,{Authorization:'Bearer '+enrollment,...(proof?{'X-Agent-Authorization':'Bearer '+proof}:{})});
 return {response,body:await response.json() as RegistrationBody};
}
function internalAgentId(f: Awaited<ReturnType<typeof seeded>>, pid: string, slug = "bot") {
  return (f.db.sqlite.prepare("SELECT agent_id FROM agent_projects WHERE project_id=? AND local_slug=?").get(pid, slug) as { agent_id: string }).agent_id;
}
describe('scoped credential security',()=>{
 it('keeps unproved enrollment retries read-only and refuses unproved rotation',async()=>{
  const f=await seeded(); const first=await register(f,f.enrollmentA);
  expect(first.response.status).toBe(200);
  const aid=internalAgentId(f,PROJECT_A);
  const before=f.db.sqlite.prepare('SELECT * FROM agents WHERE id=?').get(aid);
  const count=f.db.sqlite.prepare('SELECT COUNT(*) n FROM agent_registrations').get()?.n;
  const retry=await register(f,f.enrollmentA,PROJECT_A,{name:'unproved replacement',harness:'other'});
  expect(retry.response.status).toBe(200); expect(retry.body.token_unchanged).toBe(true); expect(retry.body.agent_token).toBeNull();
  expect(f.db.sqlite.prepare('SELECT * FROM agents WHERE id=?').get(aid)).toEqual(before);
  expect(f.db.sqlite.prepare('SELECT COUNT(*) n FROM agent_registrations').get()?.n).toBe(count);
  expect((await register(f,f.enrollmentA,PROJECT_A,{rotate_token:true})).response.status).toBe(403);
 });
 it('requires the registration proof to belong to the target project and agent',async()=>{
  const f=await seeded(); const first=await register(f,f.enrollmentA);
  expect(first.response.status).toBe(200);
  const aid=internalAgentId(f,PROJECT_A);
  expect(f.db.sqlite.prepare('SELECT * FROM agents WHERE id=?').get(aid)).not.toBeNull();
  // Membership rows in both projects for the same agent; the live token row is bound to PROJECT_A only.
  f.db.sqlite.exec(`INSERT INTO agent_projects(agent_id,project_id,status,local_slug) VALUES('${aid}','${PROJECT_B}','active','bot')`);
  const proof=first.body.agent_token!;
  const result=await register(f,f.enrollmentB,PROJECT_B,{rotate_token:true},proof);
  expect(result.response.status).toBe(403);
  expect(f.db.sqlite.prepare('SELECT token_version FROM agent_projects WHERE agent_id=? AND project_id=?').get(aid,PROJECT_B)?.token_version).toBe(1);
 });
 it('rotates with current proof and bounds proved registration history at fifty',async()=>{
  const f=await seeded(); const first=await register(f,f.enrollmentA); let proof=first.body.agent_token!;
  const rotated=await register(f,f.enrollmentA,PROJECT_A,{rotate_token:true},proof);
  expect(rotated.response.status).toBe(200); expect(typeof rotated.body.agent_token).toBe('string');
  expect((await f.call('/agent/me',undefined,undefined,{Authorization:'Bearer '+proof})).status).toBe(401);
  proof=rotated.body.agent_token!;
  for(let i=0;i<53;i++) expect((await register(f,f.enrollmentA,PROJECT_A,{name:'revision-'+i},proof)).response.status).toBe(200);
  expect(f.db.sqlite.prepare('SELECT COUNT(*) n FROM agent_registrations WHERE agent_id=?').get(internalAgentId(f,PROJECT_A))?.n).toBe(50);
 });
 it('joins and renews only the target project and never revives its disabled membership',async()=>{
  const f=await seeded(); const first=await register(f,f.enrollmentA); const source=first.body.agent_token!;
  const joined=await f.call('/agent/projects',{enrollment_token:f.enrollmentB},undefined,{Authorization:'Bearer '+source});
  expect(joined.status).toBe(201); const old=(await joined.json() as RegistrationBody).agent_token!;
  f.db.sqlite.prepare("UPDATE agent_tokens SET expires_at='2000-01-01T00:00:00.000Z' WHERE project_id=?").run(PROJECT_B);
  const renewed=await f.call('/agent/projects',{enrollment_token:f.enrollmentB},undefined,{Authorization:'Bearer '+source});
  expect(renewed.status).toBe(200);
  expect((await f.call('/agent/me',undefined,undefined,{Authorization:'Bearer '+source})).status).toBe(200);
  expect((await f.call('/agent/me',undefined,undefined,{Authorization:'Bearer '+old})).status).toBe(401);
  expect(f.db.sqlite.prepare('SELECT COUNT(*) n FROM agent_tokens WHERE project_id=? AND revoked_at IS NOT NULL').get(PROJECT_A)?.n).toBe(0);
  f.db.sqlite.prepare("UPDATE agent_projects SET status='disabled' WHERE project_id=?").run(PROJECT_B);
  expect((await f.call('/agent/projects',{enrollment_token:f.enrollmentB},undefined,{Authorization:'Bearer '+source})).status).toBe(403);
 });
 it('owner recovery retains disabled status and affects only the selected project',async()=>{
  const f=await seeded(); const first=await register(f,f.enrollmentA);
  f.env.ENVIRONMENT='development'; f.env.ADMIN_EMAILS='owner@example.test';
  f.db.sqlite.prepare("UPDATE agent_projects SET status='disabled' WHERE project_id=?").run(PROJECT_A);
  const response=await f.call('/api/v1/agents/'+encodeURIComponent(first.body.id)+'/token',{project_id:PROJECT_A},undefined,{'X-Dev-Email':'owner@example.test'});
  expect(response.status).toBe(201);
  expect(f.db.sqlite.prepare('SELECT status,token_version FROM agent_projects WHERE project_id=?').get(PROJECT_A)).toEqual({status:'disabled',token_version:2});
 });
 it('enrollment rotation revokes the previous enrollment token',async()=>{
  const f=await seeded(); await issueEnrollmentToken(f.env.DB,PROJECT_A,'owner',f.env.TOKEN_PEPPER,true);
  expect((await register(f,f.enrollmentA)).response.status).toBe(401);
 });
});

describe('authentication epochs and concurrent administration',()=>{
 it('rejects a stale password update and stale session issuance after credential reset',async()=>{
  const f=await seeded(); const stale=f.db.sqlite.prepare("SELECT * FROM users WHERE id='owner'").get() as unknown as UserRow;
  const next=await hashPassword('replacement-password-123');
  await updatePassword(f.env.DB,stale,next,false);
  await expect(updatePassword(f.env.DB,stale,await hashPassword('stale-replacement-123'),false)).rejects.toMatchObject({status:409});
  f.app.get('/stale-session',async c=>{await createSession(c,stale);return c.json({ok:true});});
  const response=await f.call('/stale-session'); expect(response.status).toBe(401); expect(response.headers.get('set-cookie')).toBeNull();
  expect(f.db.sqlite.prepare("SELECT password_hash FROM users WHERE id='owner'").get()?.password_hash===next).toBe(true);
 });
 it('atomically preserves one active administrator under simultaneous demotions',async()=>{
  const f=await fixture(); const password='administrator-password-123'; const hash=await hashPassword(password);
  f.db.sqlite.prepare("INSERT INTO users(id,email,role,password_hash) VALUES('a','a@example.test','admin',?),('b','b@example.test','admin',?)").run(hash,hash);
  const a=await f.call('/api/v1/auth/login',{email:'a@example.test',password}); const b=await f.call('/api/v1/auth/login',{email:'b@example.test',password});
  const cookies=[a,b].map(r=>r.headers.get('set-cookie')!.split(';')[0]);
  const results=await Promise.all([f.call('/api/v1/users/a',{role:'member'},cookies[0],{},'PATCH'),f.call('/api/v1/users/b',{role:'member'},cookies[1],{},'PATCH')]);
  expect(results.map(r=>r.status).sort()).toEqual([200,409]);
  expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND status='active'").get()?.n).toBe(1);
  expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE u.role='member' AND s.revoked_at IS NULL").get()?.n).toBe(0);
 });
 it('requires a live unarchived project and current user epoch for continuing access',async()=>{
  const f=await seeded(); const principal={userId:'owner',authVersion:1,sessionId:null,mode:'development' as const};
  expect(await principalCanReadProject(f.env.DB,principal,PROJECT_A)).toBe(true);
  expect(await principalCanReadProject(f.env.DB,principal,'missing-project')).toBe(false);
  f.db.sqlite.prepare("UPDATE projects SET archived_at='2026-01-01T00:00:00.000Z' WHERE id=?").run(PROJECT_A);
  expect(await principalCanReadProject(f.env.DB,principal,PROJECT_A)).toBe(false);
  f.db.sqlite.exec("UPDATE users SET auth_version=auth_version+1 WHERE id='owner'");
  expect(await principalCanReadProject(f.env.DB,principal,PROJECT_B)).toBe(false);
 });
 it('keeps the permanent bootstrap gate closed after all users are removed',async()=>{
  const f=await fixture(); expect((await f.call('/api/v1/auth/bootstrap',{email:'first@example.test',password:'bootstrap-password-123'})).status).toBe(201);
  f.db.sqlite.exec('DELETE FROM user_sessions; DELETE FROM user_auth_events; DELETE FROM users;');
  const status=await f.call('/api/v1/setup/status'); expect(await status.json()).toMatchObject({needs_setup:false});
  expect((await f.call('/api/v1/auth/bootstrap',{email:'second@example.test',password:'bootstrap-password-123'})).status).toBe(409);
 });
 it('only publishes one credential when the same identity is registered concurrently',async()=>{
  const f=await seeded(); const results=await Promise.all([register(f,f.enrollmentA),register(f,f.enrollmentA)]);
  expect(results.filter(r=>r.response.status===200 && typeof r.body.agent_token==='string')).toHaveLength(1);
  expect(f.db.sqlite.prepare('SELECT COUNT(*) n FROM agent_tokens WHERE agent_id=?').get(internalAgentId(f,PROJECT_A))?.n).toBe(1);
 });
});

describe('credential compare-and-swap boundaries',()=>{
 it('allows only one proved rotation when both requests verified the same token version',async()=>{
  const f=await seeded(); const initial=await register(f,f.enrollmentA); const proof=initial.body.agent_token!;
  let release!:()=>void; const gate=new Promise<void>(resolve=>{release=resolve;}); let count=0;
  f.db.beforeBatch=async()=>{if(++count===2){f.db.beforeBatch=undefined;release();} await gate;};
  const results=await Promise.all([register(f,f.enrollmentA,PROJECT_A,{rotate_token:true},proof),register(f,f.enrollmentA,PROJECT_A,{rotate_token:true},proof)]);
  expect(results.map(r=>r.response.status).sort()).toEqual([200,409]);
  expect(f.db.sqlite.prepare('SELECT COUNT(*) n FROM agent_tokens WHERE agent_id=? AND revoked_at IS NULL').get(internalAgentId(f,PROJECT_A))?.n).toBe(1);
  expect(f.db.sqlite.prepare('SELECT token_version FROM agent_projects WHERE agent_id=? AND project_id=?').get(internalAgentId(f,PROJECT_A),PROJECT_A)?.token_version).toBe(2);
  expect(f.db.sqlite.prepare('SELECT COUNT(*) n FROM agent_registrations WHERE agent_id=?').get(internalAgentId(f,PROJECT_A))?.n).toBe(2);
 });
 it('does not treat editing an already-disabled admin as losing the last active admin',async()=>{
  const f=await seeded(); f.env.ENVIRONMENT='development'; f.env.ADMIN_EMAILS='owner@example.test';
  f.db.sqlite.exec("INSERT INTO users(id,email,role,status) VALUES('disabled-admin','disabled@example.test','admin','disabled')");
  const result=await f.call('/api/v1/users/disabled-admin',{display_name:'Updated name'},undefined,{'X-Dev-Email':'owner@example.test'},'PATCH');
  expect(result.status).toBe(200);
  expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND status='active'").get()?.n).toBe(1);
 });
});

describe('project-local public agent references',()=>{
 it('rotates a joined project registration through its public ID without changing the source credential',async()=>{
  const f=await seeded(); const first=await register(f,f.enrollmentA); const source=first.body.agent_token!;
  const join=await f.call('/agent/projects',{enrollment_token:f.enrollmentB},undefined,{Authorization:'Bearer '+source});
  const joined=await join.json() as {agent_token:string;membership:{agent_id:string}};
  const rotated=await register(f,f.enrollmentB,PROJECT_B,{id:joined.membership.agent_id,rotate_token:true},joined.agent_token);
  expect(rotated.response.status).toBe(200); expect(typeof rotated.body.agent_token).toBe('string');
  expect((await f.call('/agent/me',undefined,undefined,{Authorization:'Bearer '+source})).status).toBe(200);
  expect((await f.call('/agent/me',undefined,undefined,{Authorization:'Bearer '+joined.agent_token})).status).toBe(401);
  expect(f.db.sqlite.prepare('SELECT token_version FROM agent_projects WHERE project_id=?').get(PROJECT_A)?.token_version).toBe(1);
  expect(f.db.sqlite.prepare('SELECT token_version FROM agent_projects WHERE project_id=?').get(PROJECT_B)?.token_version).toBe(2);
 });
 it('scopes public-ID profile/status/recovery routes to the guest project and its owner',async()=>{
  const f=await seeded(); const first=await register(f,f.enrollmentA); const source=first.body.agent_token!;
  const join=await f.call('/agent/projects',{enrollment_token:f.enrollmentB},undefined,{Authorization:'Bearer '+source});
  const joined=await join.json() as {membership:{agent_id:string}}; const publicB=joined.membership.agent_id;
  f.env.ENVIRONMENT='development'; f.env.ADMIN_EMAILS='owner@example.test';
  f.db.sqlite.exec(`INSERT INTO users(id,email,role) VALUES('guest-owner','guest@example.test','member');
    UPDATE project_members SET role='member' WHERE project_id='${PROJECT_B}';
    INSERT INTO project_members(project_id,user_id,role,added_by) VALUES('${PROJECT_B}','guest-owner','owner','owner');
    UPDATE agent_projects SET display_name=CASE WHEN project_id='${PROJECT_A}' THEN 'A label' ELSE 'B label' END;
    UPDATE agents SET display_name='A global label',avatar_key='A-avatar';`);
  const headers={'X-Dev-Email':'guest@example.test'}; const path='/api/v1/agents/'+encodeURIComponent(publicB);
  const detail=await f.call(path,undefined,undefined,headers); expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({agent:{project_id:PROJECT_B,display_name:'B label',avatar_key:'A-avatar'},projects:[{id:PROJECT_B}]});
  expect((await f.call(path+'/profile',{display_name:'B updated'},undefined,headers,'PATCH')).status).toBe(200);
  expect(f.db.sqlite.prepare('SELECT display_name FROM agent_projects WHERE project_id=?').get(PROJECT_A)?.display_name).toBe('A label');
  expect(f.db.sqlite.prepare('SELECT display_name FROM agent_projects WHERE project_id=?').get(PROJECT_B)?.display_name).toBe('B updated');
  expect((await f.call(path+'/profile',{avatar_key:'cross-project-avatar'},undefined,headers,'PATCH')).status).toBe(200);
  expect(f.db.sqlite.prepare('SELECT avatar_key FROM agents WHERE id=?').get(internalAgentId(f,PROJECT_B))?.avatar_key).toBe('cross-project-avatar');
  expect((await f.call(`/api/v1/projects/${PROJECT_B}/agents/${encodeURIComponent(publicB)}/status`,{status:'active'},undefined,headers)).status).toBe(200);
  expect((await f.call(path+'/token',{},undefined,headers)).status).toBe(201);
  expect((await f.call('/agent/me',undefined,undefined,{Authorization:'Bearer '+source})).status).toBe(200);
  expect((await f.call('/api/v1/agents/'+encodeURIComponent(first.body.id),undefined,undefined,headers)).status).toBe(404);
  expect([403,404]).toContain((await f.call(path+'/token',{project_id:PROJECT_A},undefined,headers)).status);
 });
});

describe('reenabling disabled agents preserves project capacity',()=>{
 const ownerHeaders={'X-Dev-Email':'owner@example.test'};
 const statusPath=(id:string)=>`/api/v1/projects/${PROJECT_A}/agents/${encodeURIComponent(id)}/status`;
 async function capacityFixture() {
  const f=await seeded(); f.env.ENVIRONMENT='development'; f.env.ADMIN_EMAILS='owner@example.test';
  f.db.sqlite.prepare('UPDATE project_tokens SET max_agents=1 WHERE project_id=?').run(PROJECT_A);
  const first=await register(f,f.enrollmentA); expect(first.response.status).toBe(200);
  return {...f,firstId:first.body.id};
 }
 it('denies reactivation at capacity but permits reserved pending activation and disabling',async()=>{
  const f=await capacityFixture();
  const set=(id:string,status:'active'|'disabled')=>f.call(statusPath(id),{status,project_id:PROJECT_A},undefined,ownerHeaders);
  expect((await set(f.firstId,'active')).status).toBe(200);
  expect((await set(f.firstId,'disabled')).status).toBe(200);
  const second=await register(f,f.enrollmentA,PROJECT_A,{id:PROJECT_A+':second'}); expect(second.response.status).toBe(200);
  // Expiry only limits enrollment; it must not erase the project's capacity.
  // A newer revoked record must not override the current enrollment's cap.
  f.db.sqlite.prepare("UPDATE project_tokens SET expires_at='2000-01-01T00:00:00.000Z' WHERE project_id=?").run(PROJECT_A);
  f.db.sqlite.prepare(`INSERT INTO project_tokens(id,project_id,prefix,hash,max_agents,expires_at,created_by,created_at,revoked_at)
    VALUES('revoked-capacity',?,'test','retired',99,'2099-01-01T00:00:00.000Z','owner','2099-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run(PROJECT_A);
  const rejected=await set(f.firstId,'active'); expect(rejected.status).toBe(403);
  expect(await rejected.json()).toMatchObject({error:{code:'QUOTA_EXCEEDED'}});
  expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM agent_projects WHERE project_id=? AND status<>'disabled'").get(PROJECT_A)?.n).toBe(1);
  expect((await set(second.body.id,'active')).status).toBe(200);
  expect((await set(second.body.id,'disabled')).status).toBe(200);
  expect((await set(f.firstId,'active')).status).toBe(200);
 });
 it('admits only one of two disabled agents racing for the last slot',async()=>{
  const f=await seeded(); f.env.ENVIRONMENT='development'; f.env.ADMIN_EMAILS='owner@example.test';
  const a=await register(f,f.enrollmentA); const b=await register(f,f.enrollmentA,PROJECT_A,{id:PROJECT_A+':second'});
  for(const id of [a.body.id,b.body.id]) expect((await f.call(statusPath(id),{status:'disabled'},undefined,ownerHeaders)).status).toBe(200);
  f.db.sqlite.prepare('UPDATE project_tokens SET max_agents=1 WHERE project_id=?').run(PROJECT_A);
  let release!:()=>void; const gate=new Promise<void>(resolve=>{release=resolve;}); let waiting=0;
  const prepare=f.db.prepare.bind(f.db);
  f.db.prepare=(sql:string)=>{const statement=prepare(sql); if(/^\s*UPDATE agent_projects SET status/i.test(sql)) {
    const run=statement.run.bind(statement); statement.run=async()=>{if(++waiting===2) release(); await gate; return run();};
   } return statement;};
  const results=await Promise.all([f.call(statusPath(a.body.id),{status:'active',project_id:PROJECT_A},undefined,ownerHeaders),f.call(statusPath(b.body.id),{status:'active',project_id:PROJECT_A},undefined,ownerHeaders)]);
  expect(results.map(r=>r.status).sort()).toEqual([200,403]);
  expect(await results.find(r=>r.status===403)!.json()).toMatchObject({error:{code:'QUOTA_EXCEEDED'}});
  expect(f.db.sqlite.prepare("SELECT COUNT(*) n FROM agent_projects WHERE project_id=? AND status<>'disabled'").get(PROJECT_A)?.n).toBe(1);
 });
 it('retains token-version conflicts even when capacity is full',async()=>{
  const f=await capacityFixture();
  expect((await f.call(statusPath(f.firstId),{status:'disabled',project_id:PROJECT_A},undefined,ownerHeaders)).status).toBe(200);
  expect((await register(f,f.enrollmentA,PROJECT_A,{id:PROJECT_A+':second'})).response.status).toBe(200);
  const prepare=f.db.prepare.bind(f.db); let injected=false;
  f.db.prepare=(sql:string)=>{const statement=prepare(sql); if(/^\s*UPDATE agent_projects SET status/i.test(sql)) {
    const run=statement.run.bind(statement); statement.run=async()=>{
      if(!injected) {injected=true; f.db.sqlite.prepare('UPDATE agent_projects SET token_version=token_version+1 WHERE agent_id=? AND project_id=?').run(internalAgentId(f,PROJECT_A),PROJECT_A);}
      return run();
    };
   } return statement;};
  const result=await f.call(statusPath(f.firstId),{status:'active',project_id:PROJECT_A},undefined,ownerHeaders);
  expect(result.status).toBe(409); expect(await result.json()).toMatchObject({error:{code:'CONFLICT'}});
  expect(f.db.sqlite.prepare('SELECT status FROM agent_projects WHERE agent_id=? AND project_id=?').get(internalAgentId(f,PROJECT_A),PROJECT_A)?.status).toBe('disabled');
 });
});
