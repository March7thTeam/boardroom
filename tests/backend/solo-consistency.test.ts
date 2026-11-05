import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../src/context";
import type { CardRow, Env } from "../../src/types";
import { agentApiRoutes } from "../../src/routes/agent-api";
import { projectRoutes } from "../../src/routes/projects";
import { tokenHash, hmacSha256Base64Url } from "../../src/lib/crypto";
import { formatAgentToken } from "../../src/lib/tokens";
import { HttpError } from "../../src/lib/http-error";
import { publishOutboxEvent, reconcileEvents, type OutboxRow } from "../../src/lib/event-store";
import { surveyCounterparties } from "../../src/domain/solo";
import { builtin, SqliteD1 } from "../helpers/sqlite-d1";

const A="prj_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const B="prj_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const SOLO=A+":solo", PEER=A+":peer";
const fs=builtin<{readFileSync(path:URL,encoding:string):string;readdirSync(path:URL):string[]}>("node:fs");
const databases:SqliteD1[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const db of databases.splice(0)) db.sqlite.close();});
interface Payload {
 card?:CardRow; error?:{code:string}; session_id?:string; proposal_id?:string; terms_hash?:string;
 event_id?:string; seq?:number|null; event_pending?:boolean; duplicate?:boolean; self_deal?:boolean;
 self_deal_basis?:Record<string,unknown>; agent?:{status:string}; peers?:Array<{id:string;online:boolean}>;
}
type Offer=Required<Pick<Payload,"session_id"|"proposal_id"|"terms_hash">>;
async function fixture(peerStatus:"active"|"pending"="active") {
 const db=new SqliteD1();databases.push(db);
 const migrations=new URL("../../migrations/",import.meta.url);
 for(const name of fs.readdirSync(migrations).filter(n=>n.endsWith('.sql')).sort()) db.sqlite.exec(fs.readFileSync(new URL(name,migrations),'utf8'));
 db.sqlite.exec(`INSERT INTO users(id,email,role) VALUES('u','solo-owner@example.test','admin');
  INSERT INTO projects(id,slug,name,created_by) VALUES('${A}','solo-fixture','Solo fixture','u'),('${B}','other-fixture','Other fixture','u');
  INSERT INTO project_members(project_id,user_id,role,added_by) VALUES('${A}','u','owner','u'),('${B}','u','owner','u');
  INSERT INTO agents(id,slug) VALUES('${SOLO}','solo'),('${PEER}','peer');
  INSERT INTO agent_projects(agent_id,project_id,status,local_slug) VALUES('${SOLO}','${A}','active','solo'),('${PEER}','${A}','${peerStatus}','peer');`);
 const secrets={solo:"fixture-solo-secret",peer:"fixture-peer-secret"};
 const tokens={solo:formatAgentToken(SOLO,secrets.solo),peer:formatAgentToken(PEER,secrets.peer)};
 async function credential(aid:string,pid:string,slug:string,secret:string) {
  db.sqlite.prepare("INSERT INTO agent_tokens(id,agent_id,project_id,prefix,hash,version,expires_at) VALUES(?,?,?,?,?,1,'2099-01-01T00:00:00.000Z')")
   .run(`token-${pid}-${slug}`,aid,pid,"test",await tokenHash(secret,"test-pepper"));
  return formatAgentToken(pid+":"+slug,secret);
 }
 await credential(SOLO,A,"solo",secrets.solo);await credential(PEER,A,"peer",secrets.peer);
 let enabled=true;let publication:Promise<unknown>=Promise.resolve();
 const board={publish(eventId:string):Promise<{seq:number}>{
  const operation=publication.then(async()=>{
   if(!enabled) throw new Error("injected publisher outage");
   const row=await db.prepare("SELECT * FROM event_outbox WHERE event_id=?1").bind(eventId).first<OutboxRow>();
   if(!row) throw new Error("missing outbox event");
   if(row.published_seq!==null) return {seq:row.published_seq};
   let head=await reconcileEvents(db.asD1(),row.project_id);
   const pending=await db.prepare("SELECT * FROM event_outbox WHERE project_id=?1 AND published_seq IS NULL AND order_id<=?2 ORDER BY order_id").bind(row.project_id,row.order_id).all<OutboxRow>();
   for(const entry of pending.results) head=await publishOutboxEvent(db.asD1(),entry,head);
   return {seq:head.seq};
  });publication=operation.catch(()=>undefined);return operation;
 }};
 const env={DB:db.asD1(),TOKEN_PEPPER:"test-pepper",ENVIRONMENT:"development",ADMIN_EMAILS:"solo-owner@example.test",BOARD_DO:{getByName:()=>board}} as unknown as Env;
 const app=new Hono<AppEnv>();
 app.onError((error,c)=>c.json({error:{code:error instanceof HttpError?error.code:"INTERNAL"}},(error instanceof HttpError?error.status:500) as 500));
 app.route("/agent",agentApiRoutes);app.route("/api/v1",projectRoutes);
 async function call(path:string,body?:unknown,actor:"solo"|"peer"|"owner"="solo",token?:string) {
  const response=await app.fetch(new Request("http://local"+path,{method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json",...(actor==="owner"?{"X-Dev-Email":"solo-owner@example.test"}:{Authorization:"Bearer "+(token??tokens[actor])})},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{waitUntil(){},passThroughOnException(){}} as unknown as ExecutionContext);
  return {status:response.status,body:await response.json() as Payload};
 }
 let message=0;
 const proposalBody=(cid:string)=>({message_id:`solo-proposal-${++message}`,type:"proposal",card_id:cid,terms:{scope:"fixture work"}});
 async function card(old=false) {
  const result=await call(`/agent/cards?project_id=${A}`,{title:"Self-deal fixture"});expect(result.status).toBe(201);
  const cid=result.body.card!.id;
  if(old) db.sqlite.prepare("UPDATE cards SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(cid);
  return cid;
 }
 async function offer(cid:string,actor:"solo"|"peer"="solo") {
  const result=await call(`/agent/cards/${cid}/negotiate`,proposalBody(cid),actor);expect(result.status).toBe(201);return result.body as Offer;
 }
 async function commitBody(cid:string,offer:Offer) {
  return {message_id:`solo-commit-${++message}`,type:"commit",card_id:cid,session_id:offer.session_id,terms_hash:offer.terms_hash,
   proof:{by:SOLO,alg:"HMAC-SHA256",value:await hmacSha256Base64Url(secrets.solo,offer.terms_hash)}};
 }
 const activatePeer=()=>call(`/api/v1/projects/${A}/agents/${encodeURIComponent(PEER)}/status`,{status:"active"},"owner");
 function snapshot(cid:string) {
  return {card:db.sqlite.prepare("SELECT * FROM cards WHERE id=?").get(cid),sessions:db.sqlite.prepare("SELECT * FROM negotiation_sessions WHERE card_id=? ORDER BY id").all(cid),
   proposals:db.sqlite.prepare("SELECT p.* FROM proposals p JOIN negotiation_sessions s ON s.id=p.session_id WHERE s.card_id=? ORDER BY p.id").all(cid),
   contracts:db.sqlite.prepare("SELECT * FROM contracts WHERE card_id=? ORDER BY id").all(cid),outbox:db.sqlite.prepare("SELECT * FROM event_outbox WHERE card_id=? ORDER BY order_id").all(cid)};
 }
 return {db,call,card,offer,proposalBody,commitBody,activatePeer,snapshot,credential,setPublication(value:boolean){enabled=value;}};
}

describe("presence authority and lease consistency",()=>{
 it("blocks self-dealing for an online active peer",async()=>{
  const f=await fixture();
  const authenticated=await f.call('/agent/me',undefined,'peer');expect(authenticated.status).toBe(200);expect(authenticated.body.agent?.status).toBe('active');
  const cid=await f.card();const result=await f.call(`/agent/cards/${cid}/negotiate`,f.proposalBody(cid));
  expect(result.status).toBe(409);expect(result.body.error?.code).toBe('NOT_RESPONDER');
 });
 it.each([{project:A,expires:'2099-01-01T00:00:00.000Z',online:true},{project:A,expires:'2000-01-01T00:00:00.000Z',online:false},{project:B,expires:'2099-01-01T00:00:00.000Z',online:false}])("reports the same lease availability in peers and survey: %j",async({project,expires,online})=>{
  const f=await fixture();
  if(project===B) f.db.sqlite.prepare("INSERT INTO agent_projects(agent_id,project_id,status,local_slug) VALUES(?,?,'active','peer')").run(PEER,B);
  f.db.sqlite.prepare("UPDATE agents SET last_seen_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(PEER);
  f.db.sqlite.prepare("INSERT INTO cards(id,project_id,title,status,assignee_agent_id,lease_owner,lease_expires_at,created_by_type,created_by_id) VALUES('lease-card',?,'Lease','running',?,?,?,'agent',?)").run(project,PEER,PEER,expires,PEER);
  const peers=await f.call('/agent/peers');expect(peers.status).toBe(200);
  expect(peers.body.peers!.find(p=>p.id===PEER)?.online).toBe(online);
  expect((await surveyCounterparties(f.db.asD1(),A,SOLO)).available).toBe(online?1:0);
 });
 it("intentionally shares a global heartbeat across project memberships",async()=>{
  const f=await fixture();f.db.sqlite.prepare("INSERT INTO agent_projects(agent_id,project_id,status,local_slug) VALUES(?,?,'active','peer')").run(PEER,B);
  const token=await f.credential(PEER,B,'peer','other-project-peer-secret');
  expect((await f.call('/agent/me',undefined,'peer',token)).status).toBe(200);
  const peers=await f.call('/agent/peers');expect(peers.body.peers!.find(p=>p.id===PEER)?.online).toBe(true);
  expect((await surveyCounterparties(f.db.asD1(),A,SOLO)).available).toBe(1);
 });
});

describe("self-deal eligibility is atomic with the S2 mutation",()=>{
 it.each(['proposal','commit'] as const)('rejects a peer heartbeat after the %s survey without residual writes',async(phase)=>{
  const f=await fixture();const cid=await f.card(true);
  const body=phase==='proposal'?f.proposalBody(cid):await f.commitBody(cid,await f.offer(cid));
  const before=f.snapshot(cid);
  f.db.beforeBatch=async()=>{f.db.beforeBatch=undefined;expect((await f.call('/agent/me',undefined,'peer')).status).toBe(200);};
  const result=await f.call(`/agent/cards/${cid}/negotiate`,body);
  expect(result.status).toBe(409);expect(f.snapshot(cid)).toEqual(before);
 });
 it.each(['proposal','commit'] as const)('rejects owner activation after the %s survey without residual writes',async(phase)=>{
  const f=await fixture('pending');expect((await f.call('/agent/me',undefined,'peer')).status).toBe(200);
  const cid=await f.card();const body=phase==='proposal'?f.proposalBody(cid):await f.commitBody(cid,await f.offer(cid));
  const before=f.snapshot(cid);
  f.db.beforeBatch=async()=>{f.db.beforeBatch=undefined;expect((await f.activatePeer()).status).toBe(200);};
  const result=await f.call(`/agent/cards/${cid}/negotiate`,body);
  expect(result.status).toBe(409);expect(f.snapshot(cid)).toEqual(before);
 });
 it.each(['proposal','commit'] as const)('rejects a changed but still eligible active snapshot before %s',async(phase)=>{
  const f=await fixture();const cid=await f.card(true);const body=phase==='proposal'?f.proposalBody(cid):await f.commitBody(cid,await f.offer(cid));
  const before=f.snapshot(cid);
  f.db.beforeBatch=async()=>{f.db.beforeBatch=undefined;const result=await f.call(`/api/v1/projects/${A}/agents/${encodeURIComponent(PEER)}/status`,{status:'disabled'},'owner');expect(result.status).toBe(200);};
  const result=await f.call(`/agent/cards/${cid}/negotiate`,body);
  expect(result.status).toBe(409);expect(result.body.error?.code).toBe('CONFLICT');expect(f.snapshot(cid)).toEqual(before);
 });
});

describe("self-deal receipts preserve the accepted basis",()=>{
 it.each(['proposal','commit'] as const)("replays the original complete %s basis after an opponent becomes available while publication is pending",async(phase)=>{
  const f=await fixture('pending');const cid=await f.card();
  const body=phase==='proposal'?f.proposalBody(cid):await f.commitBody(cid,await f.offer(cid));
  f.setPublication(false);vi.spyOn(console,'error').mockImplementation(()=>{});
  const first=await f.call(`/agent/cards/${cid}/negotiate`,body);expect(first.status).toBe(202);
  if(phase==='commit') expect(first.body.self_deal).toBe(true);
  const basis=first.body.self_deal_basis;
  expect(basis).toMatchObject({policy_version:'global-presence-self-deal-v1',presence_scope:'global',reason:'no_counterparty',active_counterparties:0,available_counterparties:0,online_ttl_minutes:20,cooldown_minutes:10,cooldown_required:false,cooldown_ends_at:null});
  expect(typeof basis?.card_created_at).toBe('string');expect(typeof basis?.evaluated_at).toBe('string');
  const snapshot=f.snapshot(cid);
  expect((await f.activatePeer()).status).toBe(200);expect((await f.call('/agent/me',undefined,'peer')).status).toBe(200);
  const retry=await f.call(`/agent/cards/${cid}/negotiate`,body);expect(retry.status).toBe(202);expect(retry.body.duplicate).toBe(true);expect(retry.body.self_deal_basis).toEqual(basis);
  f.setPublication(true);const published=await f.call(`/agent/cards/${cid}/negotiate`,body);expect(published.status).toBe(200);expect(published.body.self_deal_basis).toEqual(basis);
  const outbox=f.db.sqlite.prepare("SELECT payload_json,receipt_json FROM event_outbox WHERE event_id=?").get(first.body.event_id!)!;
  expect(JSON.parse(String(outbox.payload_json)).self_deal_basis).toEqual(basis);expect(JSON.parse(String(outbox.receipt_json)).self_deal_basis).toEqual(basis);
  const after=f.snapshot(cid);expect(after.card).toEqual(snapshot.card);expect(after.contracts).toEqual(snapshot.contracts);
  expect(after.sessions).toEqual(snapshot.sessions);expect(after.proposals).toEqual(snapshot.proposals);
 });
 it("keeps normal two-party negotiation available while an opponent is online",async()=>{
  const f=await fixture();expect((await f.call('/agent/me',undefined,'peer')).status).toBe(200);
  const cid=await f.card();const offer=await f.offer(cid,'peer');const result=await f.call(`/agent/cards/${cid}/negotiate`,await f.commitBody(cid,offer));
  expect(result.status).toBe(201);expect(result.body.self_deal).toBe(false);
 });
 it("retains the offline-counterparty cooldown before allowing an old card to self-deal",async()=>{
  const f=await fixture();const cid=await f.card();const blocked=await f.call(`/agent/cards/${cid}/negotiate`,f.proposalBody(cid));
  expect(blocked.status).toBe(409);expect(blocked.body.error?.code).toBe('SELF_DEAL_COOLDOWN');
  f.db.sqlite.prepare("UPDATE cards SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(cid);
  const offer=await f.offer(cid);expect((await f.call(`/agent/cards/${cid}/negotiate`,await f.commitBody(cid,offer))).status).toBe(201);
 });
});
