import { AGENT_ONLINE_TTL_MINUTES, onlinePresenceSql, onlineSinceIso } from "./presence";
import { guardedCardWrite } from "./execution";
import type { CardRow } from "../types";

/**
 * 自交易（self-deal）判定的唯一入口。
 *
 * 两方不变量（requester != responder、proposer != acceptor）的目的是防止
 * "既投标又中标"：当项目里还有其他 Agent 能接下这张卡时，自己接自己的单
 * 会破坏对等协商与验收分离。
 *
 * 判定分两层，缺一不可：
 *
 * 1. **在线对手方**。只要有其他 Agent 在线，就必须协商（409 NOT_RESPONDER /
 *    SELF_COMMIT）。"在线"= 成员关系 active，且 20 分钟内有全局
 *    认证请求或正持有未过期租约。
 * 2. **冷静期**。仅当"项目里存在其他 active 成员、但当前全部离线"时生效：
 *    卡片创建后 SELF_DEAL_COOLDOWN_MINUTES 分钟内不允许自接
 *    （409 SELF_DEAL_COOLDOWN，details 带 retry_after_seconds）。
 *
 *    没有这一层会出现真实的抢单：对手方刚上线准备提案，而在线的判定窗口
 *    是分钟级的，发起者可以在他动手之前抢先自接。冷静期给对手方留出一个
 *    可见窗口，也让"自接"只发生在确实无人接单的时候。
 *
 *    真正只有一个成员的 solo 项目不受冷静期约束——那里没有人可等，加等待
 *    只是把传统看板的行为人为拖慢。
 *
 * 例外必须在账本里留痕：contracts 的 proposer 与 acceptor 为同一 Agent，
 * `card.committed` 事件带 self_deal 与判定依据。对手方重新上线后，已成立的
 * 自交易合同不回滚，但新的自交易会立即重新被 409 拦住。
 */
export const SELF_DEAL_COOLDOWN_MINUTES = 10;

export type SelfDealDecision =
  /** 发起者不是自己，正常两方协商，与本例外无关。 */
  | { kind: "counterparty" }
  /** 允许自接。 */
  | { kind: "allowed"; reason: "no_counterparty" | "counterparties_offline" }
  /** 有在线对手方，必须协商。 */
  | { kind: "blocked_online"; available: number }
  /** 对手方存在但都离线，卡片冷静期未满。 */
  | { kind: "blocked_cooldown"; retry_after_seconds: number; cooldown_minutes: number };

export interface CounterpartySurvey {
  /** 项目内除自己外、成员关系 active 的 Agent 数。 */
  active: number;
  /** 上述 Agent 中当前在线的数量。 */
  available: number;
}

export function classifySelfDeal(input: {
  initiatorAgentId: string | null;
  actorId: string;
  survey: CounterpartySurvey;
  cardCreatedAt: string;
  nowMs?: number;
}): SelfDealDecision {
  const { initiatorAgentId, actorId, survey, cardCreatedAt } = input;
  const nowMs = input.nowMs ?? Date.now();

  if (initiatorAgentId !== actorId) return { kind: "counterparty" };
  if (survey.available > 0) return { kind: "blocked_online", available: survey.available };
  if (survey.active === 0) return { kind: "allowed", reason: "no_counterparty" };

  const remainingMs = cooldownRemainingMs(cardCreatedAt, nowMs);
  if (remainingMs > 0) {
    return {
      kind: "blocked_cooldown",
      retry_after_seconds: Math.ceil(remainingMs / 1000),
      cooldown_minutes: SELF_DEAL_COOLDOWN_MINUTES,
    };
  }
  return { kind: "allowed", reason: "counterparties_offline" };
}

/**
 * 冷静期剩余毫秒。时间戳无法解析时按"未满期"处理：宁可让调用方等，
 * 也不要在数据异常时提前放行一条不可撤销的自交易合同。
 */
export function cooldownRemainingMs(cardCreatedAt: string, nowMs = Date.now()): number {
  const created = Date.parse(cardCreatedAt);
  if (Number.isNaN(created)) return SELF_DEAL_COOLDOWN_MINUTES * 60_000;
  return Math.max(0, created + SELF_DEAL_COOLDOWN_MINUTES * 60_000 - nowMs);
}

/**
 * 统计项目内其他 Agent：active 总数与其中在线的数量。
 * 两次判定（在线 / 冷静期）共用一次查询。
 */
export async function surveyCounterparties(
  db: D1Database,
  projectId: string,
  agentId: string,
  nowMs = Date.now(),
): Promise<CounterpartySurvey> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS active,
              COALESCE(SUM(CASE WHEN ${onlinePresenceSql("?1", "?3", "?4")}
                THEN 1 ELSE 0 END), 0) AS available
         FROM agent_projects ap
         JOIN agents a ON a.id = ap.agent_id
        WHERE ap.project_id = ?1
          AND ap.status = 'active'
          AND ap.agent_id <> ?2`,
    )
    .bind(projectId, agentId, onlineSinceIso(nowMs), new Date(nowMs).toISOString())
    .first<{ active: number; available: number }>();
  return { active: Number(row?.active ?? 0), available: Number(row?.available ?? 0) };
}

export interface SelfDealBasis {
  policy_version: "global-presence-self-deal-v1";
  presence_scope: "global";
  reason: "no_counterparty" | "counterparties_offline";
  active_counterparties: number;
  available_counterparties: 0;
  online_ttl_minutes: number;
  cooldown_minutes: number;
  cooldown_required: boolean;
  card_created_at: string;
  evaluated_at: string;
  cooldown_ends_at: string | null;
}

export function buildSelfDealBasis(
  cardCreatedAt: string,
  survey: CounterpartySurvey,
  decision: Extract<SelfDealDecision, { kind: "allowed" }>,
  nowMs: number,
): SelfDealBasis {
  return {
    policy_version: "global-presence-self-deal-v1",
    presence_scope: "global",
    reason: decision.reason,
    active_counterparties: survey.active,
    available_counterparties: 0,
    online_ttl_minutes: AGENT_ONLINE_TTL_MINUTES,
    cooldown_minutes: SELF_DEAL_COOLDOWN_MINUTES,
    cooldown_required: survey.active > 0,
    card_created_at: cardCreatedAt,
    evaluated_at: new Date(nowMs).toISOString(),
    cooldown_ends_at: survey.active > 0
      ? new Date(Date.parse(cardCreatedAt) + SELF_DEAL_COOLDOWN_MINUTES * 60_000).toISOString()
      : null,
  };
}

/**
 * The stored survey is accepted only if its active count and availability still
 * hold inside the mutation transaction. Apply this to the first insert and all
 * dependent inserts: a rejected first self proposal leaves no empty session.
 * The existing card-version guard and final aggregate CAS remain unchanged.
 */
export function guardedSelfDealWrite(
  db: D1Database, card: CardRow, actorId: string, basis: SelfDealBasis | null,
  sql: string, values: unknown[] = [],
): D1PreparedStatement {
  if (!basis) return guardedCardWrite(db, card, sql, values);
  const p = (index: number) => `?${values.length + index}`;
  const evaluatedAt = Date.parse(basis.evaluated_at);
  const gate = `EXISTS (SELECT 1 FROM cards self_card
    WHERE self_card.id = ${p(1)} AND self_card.created_at = ${p(2)}
      AND (SELECT COUNT(*) FROM agent_projects ap
        WHERE ap.project_id = ${p(3)} AND ap.agent_id <> ${p(4)} AND ap.status = 'active') = ${p(5)}
      AND NOT EXISTS (SELECT 1 FROM agent_projects ap JOIN agents a ON a.id = ap.agent_id
        WHERE ap.project_id = ${p(3)} AND ap.agent_id <> ${p(4)} AND ap.status = 'active'
          AND ${onlinePresenceSql(p(3), p(6), p(7))})
      AND (${p(5)} = 0 OR (julianday(self_card.created_at) IS NOT NULL
        AND julianday(self_card.created_at) <= julianday(${p(8)}))))`;
  return guardedCardWrite(db, card,
    sql.replaceAll("/* current_card */", `(/* current_card */ AND ${gate})`),
    [...values, card.id, basis.card_created_at, card.project_id, actorId,
      basis.active_counterparties, onlineSinceIso(evaluatedAt), basis.evaluated_at,
      new Date(evaluatedAt - basis.cooldown_minutes * 60_000).toISOString()],
  );
}
