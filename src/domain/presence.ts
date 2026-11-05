/**
 * Agent 在线语义（presence）。
 *
 * 判定"在线"的两个约束必须写在一处，避免路由各写一套：
 * - TTL 与 docs/AGENT-行为规范 的"超过 20 min 无心跳，租约可被回收"对齐；
 * - 心跳写入节流，避免每个 Agent 请求都产生一次 D1 写。
 *
 * last_seen_at 是全局认证心跳，任一项目的认证请求都会刷新；租约则只在
 * 被查询项目内生效。在线表示观察到的活动，不表示执行容量或工作承诺。
 */
export const AGENT_ONLINE_TTL_MINUTES = 20;

/** 同一 Agent 最多每 60 秒写一次心跳。 */
export const PRESENCE_TOUCH_SECONDS = 60;

const ONLINE_WINDOW_MS = AGENT_ONLINE_TTL_MINUTES * 60_000;

/** last_seen_at 是否仍在在线窗口内；NULL / 非法时间一律视为离线。 */
export function isAgentOnline(lastSeenAt: string | null | undefined, nowMs = Date.now()): boolean {
  if (!lastSeenAt) return false;
  const seen = Date.parse(lastSeenAt);
  if (Number.isNaN(seen)) return false;
  return nowMs - seen <= ONLINE_WINDOW_MS;
}

/** 是否值得写一次心跳（从未写过，或已超过节流窗口）。 */
export function shouldTouchPresence(
  lastSeenAt: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!lastSeenAt) return true;
  const seen = Date.parse(lastSeenAt);
  if (Number.isNaN(seen)) return true;
  return nowMs - seen >= PRESENCE_TOUCH_SECONDS * 1000;
}

/** 在线窗口的 ISO 下界，用于 SQL 比较（时间统一 ISO-8601 UTC，可直接字典序比较）。 */
export function onlineSinceIso(nowMs = Date.now()): string {
  return new Date(nowMs - ONLINE_WINDOW_MS).toISOString();
}

/**
 * Shared SQL predicate for a global heartbeat or a live lease in this project.
 * Callers provide internal SQL parameter references and use aliases a / ap.
 */
export function onlinePresenceSql(project: string, since: string, now: string): string {
  return `((a.last_seen_at IS NOT NULL AND a.last_seen_at >= ${since})
    OR EXISTS (SELECT 1 FROM cards presence_lease
      WHERE presence_lease.project_id = ${project}
        AND presence_lease.lease_owner = ap.agent_id
        AND presence_lease.lease_expires_at IS NOT NULL
        AND presence_lease.lease_expires_at > ${now}))`;
}
