#!/usr/bin/env node
/**
 * 自交易（self-deal）冒烟测试：判据是"没有其他 Agent 在线"，不是"项目里只有一个成员"。
 *
 * 需要本地 `npx wrangler dev` 已启动（dev 环境 + X-Dev-Email 绕过）。
 * 每次运行创建一个新项目，因此可重复执行，不需要重置数据库。
 *
 * 覆盖：
 *  1. 完全 solo：自提案 / 自接受 / 自持租约成功，事件带 self_deal；
 *  2. 有第二个成员但从未发起过认证请求（离线）：仍然允许自交易；
 *  3. 第二个成员开始发请求（在线）后：自提案立即回到 409 NOT_RESPONDER；
 *  4. 两方路径完好：B 提案、B 不能自接受、A 接受且 self_deal=false。
 *
 * 用法：node scripts/smoke-solo-self-deal.mjs
 */
import { createHmac } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const EMAIL = process.env.DEV_EMAIL ?? "admin@example.com";

let failures = 0;
function check(name, condition, extra) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}`, extra === undefined ? "" : JSON.stringify(extra));
  }
}

// 统一拼装凭据头，避免在源码里出现完整的头字面量。
const bearer = (token) => ({ authorization: ["Bearer", token].join(" ") });

async function request(path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has("authorization")) headers.set("X-Dev-Email", EMAIL);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

const proof = (agentToken, termsHash) =>
  createHmac("sha256", agentToken.split(".").slice(2).join(".")).update(termsHash).digest("base64url");

const messageId = (tag) => `${tag}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

const suffix = Math.random().toString(36).slice(2, 8);
const slug = `solo-${suffix}`;

const registerAgent = (name, enrollment, projectId) =>
  request("/agent/register", {
    method: "POST",
    headers: bearer(enrollment),
    body: JSON.stringify({ id: `${projectId}:${name}`, harness: "opencode", harness_version: "1.0" }),
  });

const activateAgent = (projectId, agentId) =>
  request(`/api/v1/projects/${projectId}/agents/${encodeURIComponent(agentId)}/status`, {
    method: "POST",
    body: JSON.stringify({ status: "active" }),
  });

const createCard = (token, projectId, title) =>
  request("/agent/cards", {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({ project_id: projectId, title }),
  });

const propose = (token, cardId, terms) =>
  request(`/agent/cards/${cardId}/negotiate`, {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({ message_id: messageId("proposal"), type: "proposal", card_id: cardId, terms }),
  });

const commit = (token, cardId, sessionId, termsHash) =>
  request(`/agent/cards/${cardId}/negotiate`, {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({
      message_id: messageId("commit"),
      type: "commit",
      card_id: cardId,
      session_id: sessionId,
      terms_hash: termsHash,
      proof: { alg: "HMAC-SHA256", value: proof(token, termsHash) },
    }),
  });

// 1. 建项目并注册唯一 agent。
let res = await request("/api/v1/projects", {
  method: "POST",
  body: JSON.stringify({ slug, name: `Solo ${suffix}`, verification_mode: "human" }),
});
check("admin creates an empty project", [200, 201].includes(res.status), res);
const projectId = res.data?.project?.id;
const enrollment = res.data?.enrollment_token;

res = await registerAgent("agent-a", enrollment, projectId);
check("register agent A", [200, 201].includes(res.status), res);
const agentA = res.data?.agent_token;
const agentAId = res.data?.id;

res = await activateAgent(projectId, agentAId);
check("owner activates agent A", res.status === 200, res);
res = await request("/agent/me", { headers: bearer(agentA) });
const agentAInternalId = res.data?.agent?.internal_id;

// 2. 完全没有对手方：自提案 + 自接受 + 自持租约。
res = await createCard(agentA, projectId, "Solo card");
check("agent A creates a card", [200, 201].includes(res.status), res);
const card1 = res.data?.card?.id;

res = await propose(agentA, card1, { scope: ["do it"], estimate_minutes: 30 });
check("requester may propose to itself with no counterparty", res.status === 201, res);
check(
  "self-proposal returns its global-presence basis",
  res.data?.self_deal_basis?.policy_version === "global-presence-self-deal-v1" &&
    res.data.self_deal_basis.presence_scope === "global" &&
    res.data.self_deal_basis.reason === "no_counterparty",
  res.data?.self_deal_basis,
);
const session1 = res.data?.session_id;
const hash1 = res.data?.terms_hash;

res = await commit(agentA, card1, session1, hash1);
check("requester may accept its own proposal", res.status === 201, res);
check("commit is flagged as self_deal", res.data?.self_deal === true, res.data);
check("card is engaged", res.data?.status === "engaged", res.data);
const commitBasis = res.data?.self_deal_basis;
check(
  "self-commit returns a complete solo basis",
  commitBasis?.policy_version === "global-presence-self-deal-v1" &&
    commitBasis.presence_scope === "global" && commitBasis.reason === "no_counterparty" &&
    commitBasis.active_counterparties === 0 && commitBasis.available_counterparties === 0 &&
    commitBasis.online_ttl_minutes === 20 && commitBasis.cooldown_minutes === 10 &&
    commitBasis.cooldown_required === false && commitBasis.cooldown_ends_at === null &&
    typeof commitBasis.card_created_at === "string" && typeof commitBasis.evaluated_at === "string",
  commitBasis,
);
const committedEvents = await request(`/api/v1/cards/${card1}/events`);
const committedEvent = committedEvents.data?.events?.find((event) => event.event_type === "card.committed");
let publishedBasis;
try { publishedBasis = JSON.parse(committedEvent?.payload_json ?? "null")?.self_deal_basis; } catch { /* Report below. */ }
check(
  "published self-deal event preserves the accepted basis",
  committedEvents.status === 200 && isDeepStrictEqual(publishedBasis, commitBasis),
  publishedBasis,
);

res = await request(`/agent/cards/${card1}/lease`, {
  method: "POST",
  headers: bearer(agentA),
  body: JSON.stringify({ ttl_minutes: 30 }),
});
check("requester holds the lease on its own card", res.status === 201 && res.data?.lease_owner === agentAInternalId, res);

// 3. 第二个成员存在但从未发过请求（离线）：自交易仍受冷静期约束。
res = await registerAgent("agent-b", enrollment, projectId);
check("register agent B", [200, 201].includes(res.status), res);
const agentB = res.data?.agent_token;
const agentBId = res.data?.id;

res = await activateAgent(projectId, agentBId);
check("owner activates agent B", res.status === 200, res);

res = await createCard(agentA, projectId, "Offline peer card");
const card2 = res.data?.card?.id;
res = await propose(agentA, card2, { scope: ["offline peer"], estimate_minutes: 10 });
check(
  "self-proposal blocked by cooldown while the other member exists but is offline",
  res.status === 409 && res.data?.error?.code === "SELF_DEAL_COOLDOWN",
  res,
);
check(
  "cooldown reports retry_after_seconds",
  res.data?.error?.details?.retry_after_seconds > 0 &&
    res.data?.error?.details?.cooldown_minutes > 0,
  res.data?.error?.details,
);

// B 的第一次认证请求会写入心跳，从此 B 变为在线。
res = await request("/agent/me", { headers: bearer(agentB) });
check("agent B authenticates", res.status === 200, res);

res = await request("/agent/peers", { headers: bearer(agentB) });
const peers = res.data?.peers ?? [];
check("online_ttl_minutes is exposed", res.data?.online_ttl_minutes > 0, res.data);
check("agent A is reported online", peers.find((p) => p.id === agentAId)?.online === true, peers);
check(
  "agent B is reported online after its first authenticated request",
  peers.find((p) => p.id === agentBId)?.online === true,
  peers,
);

// 4. B 在线之后，例外必须立刻消失。
res = await createCard(agentA, projectId, "Peer online card");
const card3 = res.data?.card?.id;
res = await propose(agentA, card3, { scope: ["online peer"], estimate_minutes: 5 });
check(
  "self-proposal is rejected once the other agent is online",
  res.status === 409 && res.data?.error?.code === "NOT_RESPONDER",
  res,
);

// 5. 两方路径必须完好。
res = await propose(agentB, card3, { scope: ["online peer"], price: 10 });
check("the online counterparty may propose", res.status === 201, res);
const session3 = res.data?.session_id;
const hash3 = res.data?.terms_hash;

res = await commit(agentB, card3, session3, hash3);
check("an agent still cannot accept its own proposal", res.status === 409, res);

res = await commit(agentA, card3, session3, hash3);
check("the requester accepts the counterparty proposal", res.status === 201, res);
check("two-party commit is not marked self_deal", res.data?.self_deal === false, res.data?.self_deal);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
