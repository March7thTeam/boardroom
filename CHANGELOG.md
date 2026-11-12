# Changelog

## 0.2.0（beta）

### 破坏性变更（Breaking）

- **管理员操作命名统一**：接口统一为 `POST /api/v1/cards/:cid/admin-action`，事件统一为 `card.admin_action`，响应与合同字段统一为 `admin_action`；被跳过的前置门槛字段改为 `skipped_gates`，轮次超限标记改为 `round_limit_skipped`。不保留旧命名别名；0.1.0 为未上线预发布版本，开发期数据库直接重建，不提供数据迁移。

### 变更

- 新增管理员操作 `POST /api/v1/cards/:cid/admin-action`：项目 owner 在本项目内、实例 admin 在实例内可显式执行 `engage`（跳过协商提案）、`verify`（跳过证据门槛）、`cancel`（治理滥用/紧急止损）、`release`（释放卡死的 ticket/lease）、`reset`（平台 bug 重置轮次）；每次操作写 `card.admin_action` 事件与 `skipped_gates` 并进入审计链，普通成员不可用。
- 新增项目级管理员角色 `project_members.role = 'admin'`：owner 可在「项目参与者」面板通过「修改权限」下拉授予/撤销；项目管理员可使用管理员操作，但不能管理成员或转让所有权。项目角色现为 `owner` / `admin` / `member`，新增迁移 `0002_project_admin_role.sql`。
- 修复 human 模式无执行目标时无法验收的问题：`POST /api/v1/cards/:cid/verify` 现在允许 `engaged` 卡片直接 `pass`/`reject`，必须带 ≥8 字符验收说明；服务端写入 `kind='attestation'` 证据并把合同置为 `fulfilled`/`breached`，事件记录 `from='engaged'`、`human_attested=true`。rule 模式仍只接受 `review`。
- **行为变更**：`admin-action` 现在必须带 `If-Match`（缺失 428 `PRECONDITION_REQUIRED`，过期 409 `VERSION_CONFLICT`），与其他卡片写路径一致；`message_id` 幂等查重仍在版本校验之前，已接受命令的重放返回原回执。前端 `adminActionCard` 改为传卡片当前 `version`。
- 新增迁移 `0003_round_ceiling_for_governance_reset.sql`：把 `cards.round` / `negotiation_sessions.round` 的 DB CHECK 上限从 5 放宽到 100，使 `reset` 的治理兜底（`round_limit_skipped: true` 后仍可 `engage` 推进）不再撞 `CHECK constraint failed`。普通协商的 5 轮上限不变，仍由路由层强制（409 `ROUND_LIMIT`）。
- 版本号升级为 `0.2.0`（beta）。

## 0.1.0（beta）

### 破坏性变更（Breaking）

- **移除全部向下兼容，数据库只支持全新建库**：`0001`–`0010` 合并为单一 `migrations/0001_init.sql`；没有从 alpha 实例（≤0.5.0）的原地升级路径，升级请部署新库并重新注册。`scripts/verify-migrations.mjs`、`scripts/verify-0006.py` 与 `.github/workflows` 中的迁移数据保全校验一并删除。
- **凭据必须是 project-scoped kbt1 token**：只接受 `<project_id>:<local_slug>` 载荷的 token；0006 之前的 legacy `<projectSlug>:<agentSlug>` token 一律 401，跨项目/未 scoped 凭据不复存在。每个凭据严格绑定其签发项目（卡片接口对该项目以外的卡一律 404）。
- **Agent 身份彻底项目化**：`agents.project_id`（legacy origin/home project）、`agents.status`、`agents.token_version` 与 `agent_assignments` 表全部移除。全局身份只承载 harness/展示档案；项目访问、项目内身份（`local_slug`/`display_name`）与凭据代次完全由 `agent_projects` 决定。删除项目时不再迁移 legacy origin，只清理没有任何剩余成员关系的全局行。
- **公开引用只认 `<project_id>:<local_slug>`**：`resolveProjectAgentReference` 不再接受 internal ID / 全局 ID 回退；指派、状态启停、注册证明都必须使用目标项目的公开 ID。`/projects/:pid/agents`、`/agent/peers`、项目状态启停一致返回 scoped 公开 ID。内部 key（`ag_<ulid>`）仅出现在 `internal_id` 与卡片外键。
- **移除 legacy 状态端点** `POST /api/v1/agents/:aid/status`：成员启停统一使用 `POST /api/v1/projects/:pid/agents/:aid/status`。
- **移除升级迁移兼容**：事件回放不再回查 outbox 之外的旧 `card_events` 消息；`reconcileEvents` 只校验持久 checkpoint，不再重建 pre-0010 的审计尾巴；BoardDO 不再使用 `audit_buffer`。早期（pre-0010）事件的回执字段无法重放。

### 变更

- `/agent/cards`、`/agent/peers`、`POST /agent/cards` 的项目解析简化：任何凭据只能作用于其绑定项目（显式传其他 `project_id` 返回 `403 CREDENTIAL_SCOPE_MISMATCH`）；多项目聚合解析分支删除。
- 注册 proof（`X-Agent-Authorization`）只能来自**目标项目内该 Agent 的有效 token**；撤销了"跨项目证明"语义。
- 全局 avatar 不再限定 origin 项目：任一成员项目的 owner 均可编辑。
- 版本号重置为 `0.1.0`（beta），并删除版本号中的 `-alapa` 后缀。
