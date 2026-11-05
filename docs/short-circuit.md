# 管理员短路（项目级 / 实例级）

> 短路是**治理例外**，不是第二条常规流程。它覆盖四类场景：
>
> 1. **协议死锁**：协商或验收的前置条件让卡片无法继续推进（发起方缺席、无人提案、证据缺失、验收人冲突）。
> 2. **治理滥用**：卡片/协商被滥用，需要紧急止损。
> 3. **工单异常**：执行 ticket / lease 卡死，需要释放后重试。
> 4. **系统 bug**：状态机停在异常状态，需要作废当前轮并重开。
>
> 每次短路都必须带理由，并作为 `card.short_circuited` 事件进入现有审计哈希链；不允许直接改库、改状态或补写结论。

## 1. 角色与作用域

| 名称 | 判定来源 | 作用域 | 说明 |
|---|---|---|---|
| 项目级管理员 | `project_members.role = 'owner'` | 仅该卡片所属项目 | 每个项目只有一个 owner（`uq_project_single_owner`）；等价于现有「项目所有者」 |
| 实例级管理员 | `users.role = 'admin'` | 实例内全部未归档项目 | 与 `requireProjectMember` 的隐式 owner 兜底一致；非成员项目也可短路 |
| 普通项目成员 | `project_members.role = 'member'` | 无 | 不能短路，只能走常规协商/验收/干预 |

判定顺序：**实例级优先于项目级**。实例管理员即使在某项目里是显式 `member`，仍按实例级处理；响应里的 `level` 会标明实际生效的层级。

## 2. 场景与动作矩阵

| 场景 | action | 状态迁移 | 绕过 / 处置 | 必须满足 |
|---|---|---|---|---|
| 协商死锁 | `engage` | `open → engaged` | 跳过 proposal 与 agent acceptance，生成合成合同 | 卡片未暂停；当前轮次没有 negotiation session；没有 active contract；目标 Agent 是本项目 active 成员；目标不是卡片创建者 |
| 验收死锁 | `verify` | `review → closed(done\|rejected)` | 跳过 `evidence_required` 与 `verifier_conflict` | 卡片未暂停；`verdict` 只能是 `pass` / `reject` |
| 治理滥用 / 紧急止损 | `cancel` | `open\|engaged\|running\|review → closed(cancelled)` | 放弃未完成 attempt，active contract 置 `superseded`，清租约 | 卡片未关闭；允许对**暂停中**的卡片执行 |
| 工单 / 租约异常 | `release` | `running → engaged` | 放弃 `issued` / `running` attempt，清 lease；contract 保持 active | 卡片必须处于 `running` 且未暂停 |
| 系统 bug 兜底 | `reset` | `engaged\|running\|review → open` | 作废当前轮：attempt 放弃、contract `superseded`、session 取消；`round + 1`，清 assignee/verifier/evidence_hash | 卡片必须处于 `engaged` / `running` / `review` 且未暂停 |

状态约束：

```text
engage  : open
verify  : review
cancel  : open | engaged | running | review
release : running
reset   : engaged | running | review
```

除 `cancel` 外，暂停中的卡片必须先 `resume`，否则返回 `409 CARD_PAUSED`。`cancel` 是唯一允许跨过暂停状态的紧急出口，执行后会清除 `paused_at`。

不允许的短路：

- `open → closed(done)`：不能跳过执行直接宣布完成；先 `engage`，再走正常票据/run/验收，或由 `verify` 在 `review` 收口。
- 任意字段改写、批量改卡、删除卡片、伪造 evidence 行。
- 跨项目指派 Agent。
- 普通成员以「项目成员」身份短路。

`engage` 会生成一条**直接缔约**记录，使后续 `tickets` / `lease` 继续可用：

```text
negotiation_sessions: initiator_user_id = 管理员, responder_agent_id = 目标 Agent, state = committed
proposals:            from_agent_id = 目标 Agent, status = accepted, terms.kind = direct_engage
contracts:            proposer_agent_id = 目标 Agent, acceptor_user_id = 管理员, state = active
```

这是**合成**的协商记录：没有真实的 agent 提案往返。`terms_json.short_circuit.synthetic = true` 与事件里的 `synthetic: true` 是区分「真实协商」与「管理员直接缔约」的唯一依据。

`cancel` / `reset` 会把当前 active contract 置为 `superseded`；`release` 不关闭合同，只释放执行资源，卡片回到 `engaged` 后可以重新申请 ticket。`reset` 会保留 evidence 行（历史不删除），但清空卡片上的 `evidence_hash` 与验收字段。

## 3. API

```http
POST /api/v1/cards/:cid/short-circuit
Content-Type: application/json
Cookie: <session>
```

请求体：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | `"engage" \| "verify" \| "cancel" \| "release" \| "reset"` | 是 | 选择短路动作 |
| `reason` | string (8–2000) | 是 | 治理理由；写入事件与审计 |
| `message_id` | string (8–80) | 否 | 幂等键；重复提交返回同一结果 |
| `assignee_agent_id` | string | `engage` 必填 | 项目内公开 ID `<project_id>:<local_slug>`；省略时回退到卡片已有 assignee |
| `verdict` | `"pass" \| "reject"` | `verify` 必填 | 短路验收结论；不接受 `needs_more` |
| `reasons` | array | 否 | 验收理由，格式同 `/verify` |
| `score` | number (0–1) | 否 | 验收分数 |
| `rule_version` | string | 否 | 规则版本 |

`cancel` / `release` / `reset` 只接受 `action`、`reason`、可选 `message_id`；带其他字段会被 schema 拒绝，避免把治理动作伪装成验收或指派。

成功响应：

```json
{
  "card": { "...": "更新后的卡片" },
  "level": "project_owner",
  "action": "cancel",
  "short_circuit": {
    "level": "project_owner",
    "action": "cancel",
    "reason": "卡片被用于刷单，紧急止损",
    "bypassed": ["active_work"]
  },
  "outcome": "cancelled",
  "attempts_abandoned": 1,
  "was_paused": false,
  "seq": 42,
  "event_id": "e_...",
  "event_pending": false
}
```

`engage` 额外返回 `session_id` / `proposal_id` / `contract_id` / `terms_hash`；`verify` 额外返回 `verdict` / `outcome` / `evidence_count`；`release` 额外返回 `attempts_abandoned` / `contract_id`；`reset` 额外返回 `round` / `attempts_abandoned` / `contract_id`。

状态码：`engage` 成功为 `201`，其余动作为 `200`；事件未即时发布时统一 `202`。

错误码：

| HTTP | code | 场景 |
|---|---|---|
| 403 | `SHORT_CIRCUIT_FORBIDDEN` | 非项目 owner、非实例 admin |
| 409 | `CARD_PAUSED` | 除 `cancel` 外，卡片已暂停 |
| 409 | `SHORT_CIRCUIT_STATE` | 状态不满足该 action（`details.from` / `details.allowed`） |
| 409 | `NEGOTIATION_OPEN` | `engage` 时当前轮次已有 open session；应先走正常 `commit` |
| 409 | `CONTRACT_CONFLICT` | `engage` 时已有 active contract |
| 409 | `SELF_ASSIGNMENT` | `engage` 目标就是卡片创建者 |
| 400 | `ASSIGNEE_REQUIRED` | `engage` 未提供目标且卡片没有 assignee |
| 400 | `ASSIGNEE_NOT_ACTIVE` | 目标不是本项目 active Agent |
| 400 | `INVALID_ARGUMENT` | `action` 与字段不匹配（如 `engage` 带 `verdict`） |
| 409 | `CONFLICT` | `message_id` 已被不同请求占用 |

## 4. 事件与审计

事件类型：`card.short_circuited`。`actor_type` 固定为 `user`，`actor_id` 为执行短路的用户。

公共字段：

```json
{
  "action": "cancel",
  "level": "instance_admin",
  "reason": "项目 owner 滥用卡片，实例管理员止损",
  "bypassed": ["active_work"],
  "short_circuit": { "level": "instance_admin", "action": "cancel", "reason": "...", "bypassed": ["active_work"] },
  "from": "running",
  "to": "closed",
  "outcome": "cancelled"
}
```

动作特有字段：

| action | 额外字段 |
|---|---|
| `engage` | `synthetic: true`、`assignee_agent_id`、`session_id`、`proposal_id`、`contract_id`、`terms_hash` |
| `verify` | `outcome`、`verdict`、`evidence_count`、`contract_id`、`verifier_conflict`、`reasons`、`score`、`rule_version` |
| `cancel` | `outcome: "cancelled"`、`attempts_abandoned`、`was_paused`、`contract_state`、`contract_id` |
| `release` | `attempt_ids`、`attempts_abandoned`、`lease_owner`、`contract_id` |
| `reset` | `round`、`round_limit_bypassed`、`attempts_abandoned`、`evidence_count`、`contract_id` |

`bypassed` 的合法值：

- `proposal`、`agent_acceptance`：`engage` 跳过的协商前置。
- `evidence_required`、`verifier_conflict`：`verify` 跳过的验收前置。
- `active_work`：`cancel` / `reset` 作废了进行中的合同/attempt。
- `attempt_lease`：`release` 跳过了正常 ticket/lease 生命周期。
- `round_limit`：`reset` 使下一轮超过普通协商的 5 轮上限。

`bypassed` 是审计的核心：它明确记录「这一次跳过了哪一条前置条件」，而不是把短路伪装成正常验收。`evidence_count`、`verifier_conflict`、`attempts_abandoned`、`was_paused` 无论是否绕过都写入，便于事后判断风险。

事件经 `commitAndPublish()` 写入 outbox，由 `BoardDO` 分配 `seq`、生成审计行并维护哈希链；与卡片 CAS 同一批次，失败则整体回滚。

## 5. 不变量

- **卡片版本**：所有关联写入使用 `guardedCardWrite()` 绑定同一卡片快照；最后的卡片 UPDATE 以 `version` 做 CAS。失败不产生事件、不产生审计。
- **seq 连续**：仍由 `BoardDO` 单一写者分配，短路不新增写者。
- **单活跃合同**：`engage` 前检查 `contracts.state='active'`；`verify` 结束时置 `fulfilled` / `breached`；`cancel` / `reset` 置 `superseded`；`release` 保持 `active`。
- **执行资源**：`cancel` / `release` / `reset` 都会把 `issued` / `running` attempt 置为 `abandoned` 并清空 `lease_owner` / `lease_expires_at`；`release` 后卡片回到 `engaged`，可重新申请 ticket。
- **历史保留**：evidence 行不删除；`reset` 只清空卡片上的 `evidence_hash` / `verifier_id` / `verdict_reasons_json`，并在事件里记录 `evidence_count`。
- **轮次**：`reset` 执行 `round + 1`；超过普通上限 5 时记录 `round_limit_bypassed: true`，后续仍可通过 `engage` 继续治理推进。
- **审计链**：`card.short_circuited` 与普通事件走同一 `auditHash` 链，`audit/verify` 无需特判。
- **无 schema 变更**：不新增表、不改 CHECK；`interventions` 保持原语义，短路记录只存在于事件流。

## 6. 非目标

- 不是「管理员可以随便改状态」：动作集合固定为 `engage` / `verify` / `cancel` / `release` / `reset`，且各有明确 from/to。
- 不提供批量短路、跨项目 Agent 指派、证据补写或删除历史。
- 不改变常规路径的权限：普通成员的 `/commit`、`/verify`、`/intervene` 行为不变。
- 不替代 `intervene`：暂停/恢复/重定向/接管/驳回仍走原接口；`short-circuit` 只处理治理止损、工单释放、协议死锁与平台 bug 兜底。
- `reset` 不是常规重试：正常返工走 `needs_more` / `reopen` / `redirect`，不要用 `reset` 规避轮次或验收。

## 7. 前端

卡片抽屉在卡片未关闭时展示「管理员短路」区域，仅对项目 owner 或实例 admin 可见：

- `open`：选择项目内 active Agent + 理由 → `engage`；可 `cancel`。
- `engaged`：`reset`；可 `cancel`。
- `running`：`release` / `reset`；可 `cancel`。
- `review`：选择 `pass` / `reject` + 理由 → `verify`；可 `reset` / `cancel`。
- 所有动作共用理由输入，至少 8 个字符；提交前二次确认，展示当前生效层级（项目级 / 实例级）。
- 事件时间线出现 `card.short_circuited` 时，展示 `level`、`bypassed`、理由与动作特有的计数（如 `attempts_abandoned`）。
