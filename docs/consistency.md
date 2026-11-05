# 持久事件、回执与升级

## 写入与发表

卡片及其关联合同、票据、证据、干预、租约的写入先在同一个 D1 `batch()` 中提交，并插入 `event_outbox`。多语句写入先以同一卡片快照保护关联行，最后的卡片 CAS 决定是否插入回执；失败不得留下部分关联状态。

`BoardDO.publish()` 串行分配项目 `seq`，在同一 D1 batch 中写入 `card_events`、`audit_log`、outbox 发表标记和 `project_event_heads`。DO 的本地水位仅为缓存；D1 提交后丢失响应时，按完整不可变命令/事件和哈希链链接核对恢复，不能只凭 `event_id` 判定成功。

所有写入响应保留动作本来的字段，并携带：

| 字段 | 已发表 | 已接受、待发表 |
|---|---|---|
| HTTP 状态 | 动作原有的 200 / 201 | 202 |
| `seq` | 项目序号 | `null` |
| `event_id` | 已接受事件 ID | 已接受事件 ID |
| `event_pending` | `false` | `true` |

202 表示业务写入已接受，不应重新提交新请求。客户端可读取卡片状态，或对带 `message_id` 的同一请求重放原消息。卡片级消息在 outbox 中具有唯一约束；相同主体、路径、方法和规范化请求体重放返回原回执及 `duplicate: true`，不同请求复用同一消息 ID 返回 409。鉴权 header 只参与验证，不写入请求指纹或历史。

失败 run 若已经把票据标为 failed、卡片退回 engaged，但事件发表仍待恢复，也返回 202；必须检查 `status` / `verify_result`，不能把“已保存回执”解释为“执行成功”。

Cron 对项目清理待发表事件；已归档项目仍可排空历史 outbox，但不继续执行卡片超时扫描。项目永久删除会一并删除 outbox 和持久水位。

## 审计与 SSE

`GET /api/v1/projects/:pid/audit/verify` 固定 `as_of_seq` 与 `as_of_outbox_order` 后分页验证完整链，检查事件序列、对应事件内容、审计哈希与持久水位。`ok` 只说明已发表边界的校验结果；只有 `complete: true` 且 `pending: 0` 才表示该边界的已接受事件全部发表。

`npm run verify-audit -- <project_id>` 为只读检查：完整返回退出码 0，数据损坏/响应错误返回 1，尚有待发表事件返回 2。需要主动恢复时由项目 owner 调用 `POST /projects/:pid/audit/flush`。

SSE 的主体由 Worker 从实际登录上下文构造。重放、广播和心跳都按去重后的主体分批检查用户状态、凭据版本、会话有效性和项目成员关系；撤销会话或移除成员后不再推送新事件。项目归档或删除也会关闭连接。

## 一致性恢复

数据模型的一致性由同一批次保证：卡片写入 / outbox / 审计 / 持久水位位于同一个 D1 批次内原子提交；`BoardDO` 通过 `reconcileEvents` 校验 `audit_log` 头与 `project_event_heads` 持久水位，出现不一致会直接抛错而不是静默修复；审计尾部重建（alpha 时代的升级路径）在 beta 中已移除，`reconcileEvents` 只做校验。历史 `audit_buffer`、pre-0010 的消息回放等升级兼容机制均不再存在。

代码回滚仍需先停止新写入、排空并核对水位。
