# 管理员短路（项目级 / 实例级）

> 短路是**治理例外**，不是第二条常规流程。它只用于「协商或验收的前置条件让卡片无法继续推进」的场景：发起方缺席、无人提案、证据缺失、验收人冲突。每次短路都必须带理由，并作为 `card.short_circuited` 事件进入现有审计哈希链；不允许直接改库、改状态或补写结论。

## 1. 角色与作用域

| 名称 | 判定来源 | 作用域 | 说明 |
|---|---|---|---|
| 项目级管理员 | `project_members.role = 'owner'` | 仅该卡片所属项目 | 每个项目只有一个 owner（`uq_project_single_owner`）；等价于现有「项目所有者」 |
| 实例级管理员 | `users.role = 'admin'` | 实例内全部未归档项目 | 与 `requireProjectMember` 的隐式 owner 兜底一致；非成员项目也可短路 |
| 普通项目成员 | `project_members.role = 'member'` | 无 | 不能短路，只能走常规协商/验收/干预 |

判定顺序：**实例级优先于项目级**。实例管理员即使在某项目里是显式 `member`，仍按实例级处理；响应里的 `level` 会标明实际生效的层级。

## 2. 动作矩阵

| action | 状态迁移 | 绕过的前置条件 | 必须满足 |
|---|---|---|---|
| `engage` | `open → engaged` | ① 必须有人提交 proposal；② 必须由提案方/发起方完成接受 | 卡片未暂停；当前轮次没有 open session；没有 active contract；目标 Agent 是本项目 active 成员；目标不是卡片创建者（防自派） |
| `verify` | `review → closed(done\|rejected)` | ① `pass` 必须有 evidence；② 提案方不能验收 | 卡片未暂停；`verdict` 只能是 `pass` / `reject` |

不允许的短路：

- `open → closed(done)`：不能跳过执行直接宣布完成；先 `engage`，再走正常票据/run/验收，或由 `verify` 在 `review` 收口。
- `running → closed`：执行中的卡片只能走 `needs_more` / `reject` / `close` 等既有出口。
- 任意字段改写、批量改卡、删除卡片、伪造 evidence 行。
- 普通成员以「项目成员」身份短路。

`engage` 会生成一条**直接缔约**记录，使后续 `tickets` / `lease` 继续可用：

```text
negotiation_sessions: initiator_user_id = 管理员, responder_agent_id = 目标 Agent, state = committed
proposals:            from_agent_id = 目标 Agent, status = accepted, terms.kind = direct_engage
contracts:            proposer_agent_id = 目标 Agent, acceptor_user_id = 管理员, state = active
```

这是**合成**的协商记录：没有真实的 agent 提案往返。`terms_json.short_circuit.synthetic = true` 与事件里的 `synthetic: true` 是区分「真实协商」与「管理员直接缔约」的唯一依据。

## 3. API

```http
POST /api/v1/cards/:cid/short-circuit
Content-Type: application/json
Cookie: <session>
```

请求体：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | `"engage" \| "verify"` | 是 | 选择短路动作 |
| `reason` | string (8–2000) | 是 | 治理理由；写入事件与审计 |
| `message_id` | string (8–80) | 否 | 幂等键；重复提交返回同一结果 |
| `assignee_agent_id` | string | `engage` 必填 | 项目内公开 ID `<project_id>:<local_slug>`；省略时回退到卡片已有 assignee |
| `verdict` | `"pass" \| "reject"` | `verify` 必填 | 短路验收结论；不接受 `needs_more` |
| `reasons` | array | 否 | 验收理由，格式同 `/verify` |
| `score` | number (0–1) | 否 | 验收分数 |
| `rule_version` | string | 否 | 规则版本 |

成功响应：

```json
{
  "card": { "...": "更新后的卡片" },
  "level": "project_owner",
  "action": "engage",
  "short_circuit": {
    "level": "project_owner",
    "action": "engage",
    "reason": "唯一在线 Agent 离线，项目需要继续推进",
    "bypassed": ["proposal", "agent_acceptance"]
  },
  "session_id": "ns_...",
  "proposal_id": "p_...",
  "contract_id": "ct_...",
  "seq": 42,
  "event_id": "e_...",
  "event_pending": false
}
```

`verify` 的响应不含 `session_id` / `proposal_id` / `contract_id`（合同可能不存在），但一定包含 `level`、`action`、`short_circuit.bypassed`、`seq`。

错误码：

| HTTP | code | 场景 |
|---|---|---|
| 403 | `SHORT_CIRCUIT_FORBIDDEN` | 非项目 owner、非实例 admin |
| 409 | `CARD_PAUSED` | 卡片已暂停 |
| 409 | `SHORT_CIRCUIT_STATE` | 状态不满足该 action（`details.from` / `details.action`） |
| 409 | `NEGOTIATION_OPEN` | `engage` 时当前轮次已有 open session；应先走正常 `commit` |
| 409 | `CONTRACT_CONFLICT` | `engage` 时已有 active contract |
| 409 | `SELF_ASSIGNMENT` | `engage` 目标就是卡片创建者 |
| 400 | `ASSIGNEE_REQUIRED` | `engage` 未提供目标且卡片没有 assignee |
| 400 | `ASSIGNEE_NOT_ACTIVE` | 目标不是本项目 active Agent |
| 400 | `INVALID_ARGUMENT` | `action` 与字段不匹配（如 `engage` 带 `verdict`） |
| 409 | `CONFLICT` | `message_id` 已被不同请求占用 |

## 4. 事件与审计

事件类型：`card.short_circuited`。`actor_type` 固定为 `user`，`actor_id` 为执行短路的用户。

`engage` 事件 payload：

```json
{
  "action": "engage",
  "level": "instance_admin",
  "reason": "项目 owner 已离职，实例管理员接管",
  "bypassed": ["proposal", "agent_acceptance"],
  "from": "open",
  "to": "engaged",
  "synthetic": true,
  "assignee_agent_id": "prj_...:worker",
  "session_id": "ns_...",
  "proposal_id": "p_...",
  "contract_id": "ct_...",
  "terms_hash": "sha256:..."
}
```

`verify` 事件 payload：

```json
{
  "action": "verify",
  "level": "project_owner",
  "reason": "CI 已绿，但 Agent 漏传 artifacts",
  "bypassed": ["evidence_required"],
  "from": "review",
  "to": "closed",
  "outcome": "done",
  "verdict": "pass",
  "evidence_count": 0,
  "contract_id": "ct_...",
  "verifier_conflict": null
}
```

`bypassed` 是审计的核心：它明确记录「这一次跳过了哪一条前置条件」，而不是把短路伪装成正常验收。`evidence_count` 与 `verifier_conflict` 无论是否绕过都写入，便于事后判断风险。

事件经 `commitAndPublish()` 写入 outbox，由 `BoardDO` 分配 `seq`、生成审计行并维护哈希链；与卡片 CAS 同一批次，失败则整体回滚。

## 5. 不变量

- **卡片版本**：所有关联写入使用 `guardedCardWrite()` 绑定同一卡片快照；最后的卡片 UPDATE 以 `version` 做 CAS。失败不产生事件、不产生审计。
- **seq 连续**：仍由 `BoardDO` 单一写者分配，短路不新增写者。
- **单活跃合同**：`engage` 前检查 `contracts.state='active'`；`verify` 结束时把 active 合同置为 `fulfilled` / `breached`。
- **审计链**：`card.short_circuited` 与普通事件走同一 `auditHash` 链，`audit/verify` 无需特判。
- **无 schema 变更**：不新增表、不改 CHECK；`interventions` 保持原语义，短路记录只存在于事件流。

## 6. 非目标

- 不是「管理员可以随便改状态」：动作集合固定为 `engage` / `verify`，且各有明确 from/to。
- 不提供批量短路、跨项目 Agent 指派、证据补写或删除历史。
- 不改变常规路径的权限：普通成员的 `/commit`、`/verify`、`/intervene` 行为不变。
- 不替代 `intervene`：暂停/恢复/重定向/接管/驳回仍走原接口；`short-circuit` 只处理「协商或验收前置条件卡死」。

## 7. 前端

卡片抽屉在 `review` 与 `open` 状态展示「管理员短路」区域，仅对项目 owner 或实例 admin 可见：

- `open`：选择项目内 active Agent + 理由 → `engage`。
- `review`：选择 `pass` / `reject` + 理由 → `verify`；即使没有 evidence，`pass` 也可提交，但界面明确提示「将记录 evidence_required 绕过」。
- 提交前二次确认，展示当前生效层级（项目级 / 实例级）。
- 事件时间线出现 `card.short_circuited` 时，展示 `level`、`bypassed` 与理由。
