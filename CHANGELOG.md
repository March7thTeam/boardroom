# Changelog

## 0.1.0（beta）

### 破坏性变更（Breaking）

- **移除全部向下兼容，数据库只支持全新建库**：`0001`–`0010` 合并为单一 `migrations/0001_init.sql`；没有从 alpha 实例（≤0.5.0）的原地升级路径，升级请部署新库并重新注册。`scripts/verify-migrations.mjs`、`scripts/verify-0006.py` 与 `.github/workflows` 中的迁移数据保全校验一并删除。
- **凭据必须是 project-scoped kbt1 token**：只接受 `<project_id>:<local_slug>` 载荷的 token；0006 之前的 legacy `<projectSlug>:<agentSlug>` token 一律 401，跨项目/未 scoped 凭据不复存在。每个凭据严格绑定其签发项目（卡片接口对该项目以外的卡一律 404）。
- **Agent 身份彻底项目化**：`agents.project_id`（legacy origin/home project）、`agents.status`、`agents.token_version` 与 `agent_assignments` 表全部移除。全局身份只承载 harness/展示档案；项目访问、项目内身份（`local_slug`/`display_name`）与凭据代次完全由 `agent_projects` 决定。删除项目时不再迁移 legacy origin，只清理没有任何剩余成员关系的全局行。
- **公开引用只认 `<project_id>:<local_slug>`**：`resolveProjectAgentReference` 不再接受 internal ID / 全局 ID 回退；指派、状态启停、注册证明都必须使用目标项目的公开 ID。`/projects/:pid/agents`、`/agent/peers`、项目状态启停一致返回 scoped 公开 ID。内部 key（`ag_<ulid>`）仅出现在 `internal_id` 与卡片外键。
- **移除 legacy 状态端点** `POST /api/v1/agents/:aid/status`：成员启停统一使用 `POST /api/v1/projects/:pid/agents/:aid/status`。
- **移除升级迁移兼容**：事件回放不再回查 outbox 之外的旧 `card_events` 消息；`reconcileEvents` 只校验持久 checkpoint，不再重建 pre-0010 的审计尾巴；BoardDO 不再使用 `audit_buffer`。早期（pre-0010）事件的回执字段无法重放。

### 变更

- 修复 human 模式无执行目标时无法验收的问题：`POST /api/v1/cards/:cid/verify` 现在允许 `engaged` 卡片直接 `pass`/`reject`，必须带 ≥8 字符验收说明；服务端写入 `kind='attestation'` 证据并把合同置为 `fulfilled`/`breached`，事件记录 `from='engaged'`、`human_attested=true`。rule 模式仍只接受 `review`。
- 新增管理员短路 `POST /api/v1/cards/:cid/short-circuit`：项目 owner 在本项目内、实例 admin 在实例内可显式执行 `engage`（跳过协商提案）、`verify`（跳过证据门槛）、`cancel`（治理滥用/紧急止损）、`release`（释放卡死 ticket/lease）、`reset`（系统 bug 重置轮次）；每次短路写 `card.short_circuited` 事件并进入审计链，普通成员不可用。
- `/agent/cards`、`/agent/peers`、`POST /agent/cards` 的项目解析简化：任何凭据只能作用于其绑定项目（显式传其他 `project_id` 返回 `403 CREDENTIAL_SCOPE_MISMATCH`）；多项目聚合解析分支删除。
- 注册 proof（`X-Agent-Authorization`）只能来自**目标项目内该 Agent 的有效 token**；撤销了"跨项目证明"语义。
- 全局 avatar 不再限定 origin 项目：任一成员项目的 owner 均可编辑。
- 版本号重置为 `0.1.0`（beta），并删除版本号中的 `-alapa` 后缀。

## 0.5.0-alapa

### 变更

- Agent 身份分层 + 凭据按项目分域（#4）：公开 id 改为不可变的 `<project_id>:<local_slug>`；`agent_tokens` 带 `project_id`，`POST /agent/projects` 为每个加入的项目签发独立 token。迁移 `0006` 会重建 `agent_tokens`，升级前请备份 D1
- 按项目签发的 Agent Token 只能用于签发它的项目：访问其他项目返回 `403 CREDENTIAL_SCOPE_MISMATCH`（卡片类接口返回 `404`）；不带 `project_id` 时 `/agent/cards`、`/agent/peers`、`POST /agent/cards` 默认使用 token 所属项目。0006 之前签发的旧格式 token 暂保留跨项目兼容，beta 前移除

### 修复

- 禁用 Agent 重新启用同样原子检查项目配额，补齐两个状态入口的超额与并发争最后名额保护（#3）

- 0010：按当前 S2/项目凭据结构迁移凭据版本、首装原子认领、持续 SSE 授权与持久 outbox；同批保存卡片关联状态/回执，恢复未发表事件并明确 202，补齐完整审计边界与旧 DO 尾升级验证
- 公开 Agent ID 可用于 guest 激活、指派、承诺证明和凭据轮换；保留实时配额、单 owner 与 internal ID 兼容
- 邮件正文/原始错误不再入库或 console；服务端强制改密；前端令牌确认跨刷新保留，编辑固定原版本，明确投递失败与事件待发表

- 卡片关闭/重开同步清理旧合同、协商、票据与租约，避免重开后无法再次接受提案
- 人类与 Agent 只接受当前轮次的有效最新提案，拒绝过期 session 和已被 counter 替换的报价
- Cron 超时回收与 run 回传使用条件写入，避免旧快照废弃已续租票据或旧回传覆盖暂停/新执行
- 删除项目时保留仍属于其他归档项目的全局 Agent 身份和成员关系
- 规范化重复产物声明，拒绝同一哈希的冲突大小，保持本次 run 的 evidence_hash 可复算
- GitHub 校验使用指定 attempt 的结果，避免后续重跑导致历史成功执行被误拒绝
- 滑动会话续期同步刷新浏览器 Cookie；SSE 同时刷新卡片详情与协商/证据缓存；切换项目关闭旧项目的新建卡片草稿窗口
- 注册令牌的 `max_agents` 配额开始生效（#3）：`POST /agent/register` 与 `POST /agent/projects` 超额时返回 `403 QUOTA_EXCEEDED`；计数与写入在同一条件写/批次内完成，并发不会穿透；`disabled` 的成员不计入配额
- `POST /agent/register` 使用的 slug 已被本项目 guest Agent 占用时返回 `409 LOCAL_SLUG_TAKEN`，不再因唯一索引冲突 500
- 已被禁用的项目成员不能通过 `POST /agent/projects` 重新领取凭据

- 空证据的 run 报告不再把卡片推进 `review`：`POST /agent/cards/:cid/runs` 要求至少一条 `artifacts[]`，否则 `422 EVIDENCE_REQUIRED` 且卡片保持 `running`（可在票据有效期内补报），避免出现「进入 review 但 `verify pass` 必然 409」的卡
- 前端卡片抽屉：无证据时禁用「通过」并提示先「要求补充」，不再让用户点到必然失败的按钮

- 卡片自锁：`NOT_RESPONDER` / `SELF_COMMIT` 原本无条件禁止发起者对自己提案、接受自己的提案，导致缺少可协商对手方时，Agent 自建的卡片永远停在 `open`——租约、票据、run、验收全部不可达。现在改为按**可用对手方**判定：项目内除自己外没有在线且可接单的 Agent 时放行自交易，合同两侧为同一 Agent，`card.committed` 事件带 `self_deal: true` 与 `self_deal_basis`；只要对手方在线，两道校验立即恢复原样
- 自接冷静期：存在其他 active 成员、但当前全部离线时，自接要等卡片创建满 10 分钟；提前尝试返回 `409 SELF_DEAL_COOLDOWN`（`details.retry_after_seconds` / `cooldown_minutes`）。在线判定有 20 分钟窗口，没有这一层会被发起者抢单。只有一个成员的 solo 项目不受限制
- 迁移 `0008_solo_self_deal.sql`：放宽 `negotiation_sessions` 与 `contracts` 上写死的两方 CHECK（SQLite 不能就地放宽 CHECK，按依赖顺序重建五张 S2 表并保留数据）
- Agent 在线状态：新增 `agents.last_seen_at`（迁移 `0009_agent_presence.sql`），任何带 Agent 凭证的请求都会刷新（60 秒节流），20 分钟无心跳视为离线，阈值与行为规范里的"无心跳回收"一致。`GET /agent/peers` 返回 `online` 与 `online_ttl_minutes`，便于解释某次自交易为何被放行

### 权限与角色

- 每个项目只有一个 owner（#14）：不能再把成员设为 owner（`409 SINGLE_OWNER`），新增 `POST /api/v1/projects/:pid/owner` 转让所有权；迁移 `0007` 对多 owner 项目保留最早的 owner，并加部分唯一索引兜底
- 实例管理员的项目列表与隐式 owner 权限一致（#5）：`/projects`、`/me` 对实例管理员返回全部未归档项目，非成员项目带 `access: "admin"`
- 前端区分实例角色与项目角色：「实例管理员 / 普通用户」与「项目所有者 / 项目成员」使用不同名称与徽标；参与者面板改为「转让所有权」，owner 行不再显示移除
- 文档写明 PBKDF2 100k 上限对免费/付费层一致、强度折中与旧哈希处理（#2）

## 0.4.0-alapa

### 新增

- 前端：标签页支持拖拽换位、拖出为浮动窗口，浮动窗口可停靠回标签栏
- `slugify` 纯函数与单测

### 变更

- `needs_more` 从 `review` 退回 `engaged` 返工：新增状态机 `rework` 迁移并释放租约
- 验收职责分离只禁止提案方验收；人类建卡人可验收自己接受的提案，避免单成员项目在 `review` 自锁（#6）


## 0.3.0-alapa

### 新增

- Agent 全局身份 + 多项目成员关系：`agent_projects`、`POST /agent/projects`、`/agent/me.projects[]`、按项目启停
- 多项目 Agent 的 `/agent/cards`、`/agent/peers`、`POST /agent/cards` 支持 `project_id`
- 项目归档 / 恢复 / 管理员永久删除；归档释放 slug，恢复优先取回原 slug
- `BoardDO.closeConnections()` 与 `purgeProject()`；永久删除按依赖顺序清理 D1 数据
- 前端：已归档项目面板、项目设置危险操作区、Agent 参与项目数
- 迁移：`0004_agent_projects.sql`、`0005_project_archive_meta.sql`

### 变更

- Agent 项目权限改由 `agent_projects.status` 判定；`agents.project_id` 降级为 legacy origin
- 已归档项目对成员/Agent/SSE/卡片接口统一阻断

### 修复

- Agent 建卡后无人能接受：新增 `GET /agent/cards/:cid/negotiation`，发起 Agent 可读取最新提案的 `terms` / `terms_hash` 并构造接受 proof；Agent 建卡另允许项目 owner 在人类端代收（合同记代收人，事件记 `on_behalf_of`）

## 0.2.0-alapa

### 新增

- GitHub Actions CI：typecheck、单元测试、前端构建、Worker dry-run 与端到端冒烟
- 协商消息：inquiry / proposal / counter / commit，`terms_hash` 使用 JCS + SHA-256，`message_id` 幂等
- 软合同：单边 commit proof + 服务端回执；人类建卡可通过 `POST /cards/:cid/commit` 接受提案
- 执行票据：项目 `exec_targets_json` 允许列表、一次性 nonce、attempt 编号
- GitHub Actions run 校验：URL/仓库/workflow、conclusion、created_at、head_sha
- evidence 元数据与 `evidence_hash`；rule 模式基于 `self_check` 自动验收并标注自报
- 人工干预：reject / redirect / takeover / pause / resume
- Agent lease：取/续/释放；Cron 扫描协商超时、票据过期、租约回收
- 前端：卡片抽屉协商/合同/执行/证据/验收/干预；项目执行目标设置
- 卡片发起方/承接方/创建者解析，修复人工建卡只显示“人工”的问题

### 已知限制

- 真实双向 proof、产物下载/哈希复算、NDJSON 审计导出、竞价 UI 留到 S3

## 0.1.0-alapa

首个可发布版本（S0 + S1）。

### 包含

- 应用内登录：PBKDF2 密码、HttpOnly 会话、bootstrap、强制改密、管理员用户管理
- 首次启动向导：实例名称 → 管理员 → 可选首个项目
- 项目、成员、enrollment token、Agent 注册/令牌/启停
- 卡片创建、列表、详情、编辑、关闭、重开、`If-Match` 乐观锁
- Agent 卡片权限：可创建、关闭/重开自己创建的卡片；不能操作人类/其他 Agent 卡片
- 单 BoardDO：`seq`、事件、审计 buffer、SSE 补发/心跳
- 审计哈希链（RFC 8785 JCS + SHA-256）与 `verify-audit`
- SMTP provider（`on`/`starttls`/`off`）、console 开发回退、`email_log`
- 中英文 i18n（shell、看板、登录/配置、状态）
- 发布基线：`migrations/0001_init.sql`

### 清理

- 删除 `kanban-a2a-devspec/` 设计参考
- 删除 `db/drop.sql`、`scripts/db-reset.mjs`、`scripts/release.mjs`
- 移除 `db:reset` / `release` npm scripts
- 数据库改用 D1 migrations

### 已知限制

- S2 的 negotiate/tickets/runs、GitHub Actions run 校验、verdict 尚未实现
- SSE 长连接不能像 WebSocket 一样休眠
- Cron 目前只做审计 flush
