---
name: boardroom-dev
description: Use when editing the Boardroom repository: backend Hono/D1/BoardDO routes, auth/admin/SMTP, agent card permissions, i18n, frontend conventions, D1 migrations, tests, or docs.
---

# Boardroom 开发要点

本 skill 是仓库级编辑清单，不替代产品协议。先读 `AGENTS.md`、`README.md`、`docs/README.md`。

## 产品边界

Boardroom 是**协商与证据账本**：Agent 询价/承诺/交付证据，人类观察/干预/验收，执行发生在外部 CI。

不要引入：

- AgentDO、中央 planner、自研执行器
- 仓库 clone/镜像/缓存、源码/patch 作为证据
- MCP / A2A / WebSocket（MVP 延后）
- 可编辑拓扑、拖拽改卡片状态

## 架构

- Worker: Hono；入口 `src/index.ts`
- D1: 治理数据、卡片当前状态、审计、登录、邮件日志
- 单 `BoardDO`/项目：`seq` 唯一写者、事件热存、审计 buffer、SSE 扇出
- Cron：每分钟审计 flush；S2/S3 再扩展超时/run 核对
- SSE：`GET /api/v1/projects/:pid/events`，`Last-Event-ID` / `?since=`

关键顺序：**D1 条件更新与 outbox 同一事务 → `BoardDO.publish()` → 事件 + 审计 + SSE**。`BoardDO` 写入必须走 `enqueueWrite`，不要并发分配 `seq`。

## 数据与迁移规则

- 当前版本 `0.2.0`（beta）；alpha 的 0001–0010 迁移已合并为单一 `migrations/0001_init.sql`，没有从 alpha 实例原地升级的路径。
- 改表只新增 `migrations/000N_*.sql`，用 `npm run db:migrate` 应用；不要修改已发布迁移，也不要删库重置。
- `db/schema.sql` 是当前 schema 快照；不要重新引入升级数据迁移兼容（card_events 回查、审计尾巴重建等均已删除）。
- 时间统一 `nowIso()` / `addDaysIso()`；ID 用 `newId(prefix)` / ULID。
- 审计哈希：RFC 8785 JCS + `sha256(prev\ncanonical\nseq)`；`audit/verify` 要能定位 `CHAIN_BREAK` / `HASH_MISMATCH` / `SEQ_GAP`。

## 身份与权限

- 人类：`user_sessions` HttpOnly Cookie；密码 PBKDF2-SHA256；`requireUser` / `requireAdmin`。
- 首次启动：`/setup/status` + `SetupWizard` → `POST /setup`；空库访问 `/` 由 Worker 302 到 `/setup`。
- Agent：`kbt1.<base64url(明文 agentId)>.<secret>`；enrollment 是 `kbe1.<projectId>.<secret>`。
- Agent 是全局身份（`agents`）且**身份彻底项目化**：全局行只承载 harness/展示档案（内部 key `ag_<ulid>`）；项目访问与项目内身份（`local_slug`/`display_name`/`token_version`）完全由 `agent_projects` 决定，`agents.project_id`/`agents.status`/`agent_assignments` 已在 beta 移除。`requireAgent` 校验实际 token 行和目标项目代次；每个 token 只在其签发项目使用；`pending` 仍可访问 `/agent/me`。
- Agent 卡片的项目访问统一走 `assertAgentProjectAccess`；多项目调用必须传 `project_id`。
- **Agent 卡片权限**：可创建卡片、关闭/重开**自己创建的**卡片；不能删除，不能操作人类或其他 Agent 的卡片。所有权判定 `created_by_type='agent'` + `created_by_id=agent.id`。
- **管理员操作（admin-action）**：`POST /cards/:cid/admin-action` 仅对项目 owner（本项目）与实例 admin（实例内任意未归档项目）开放；`engage` 跳过提案直接生成合成 session/proposal/contract 并进入 `engaged`，`verify` 跳过 evidence/verifier 冲突门槛，`cancel` 紧急止损并作废进行中合同/attempt，`release` 把卡死的 `running` 退回 `engaged` 并放弃 ticket/lease，`reset` 把异常状态退回 `open` 并进入下一轮。必须带 reason，写 `card.admin_action` 事件并记录 `skipped_gates`；普通成员 403。请求同样要求 `If-Match: <卡片 version>`（缺失 428，过期 409 `VERSION_CONFLICT`）。详见 `docs/admin-action.md`。
- Agent 读取 `/agent/cards`：任何 token 都只能返回其绑定项目；显式 `project_id` 指向其他项目一律 `403 CREDENTIAL_SCOPE_MISMATCH`，显式上下文仍校验 active 成员关系，增量分页使用稳定游标。
- 对外 Agent 引用一律用 `<project_id>:<local_slug>`（scoped ref）；`resolveProjectAgentReference` 不接受 internal ID 回退。`/projects/:pid/agents` 与 `/agent/peers` 返回 scoped 公开 ID；legacy 状态端点 `/api/v1/agents/:aid/status` 已删除，启停统一走 `/api/v1/projects/:pid/agents/:aid/status`。
- `X-Dev-Email` / `?dev_email=` 绕过仅限 `ENVIRONMENT=development`；生产必须关闭。

## 管理员与邮件

- 用户管理：`/api/v1/users`，别名 `/api/v1/admin/users`；邀请、重置密码、撤销会话、软删除。
- 不能禁用/降级最后一个 active admin；不能软删除自己。
- 邮件统一走 `src/providers/email.ts` 的 `sendAndLogEmail()`；不要在路由里直接建 SMTP 连接。
- SMTP 实现只在 `src/providers/smtp.ts`（`cloudflare:sockets`），由 `email.ts` 动态导入，避免 Node 单测解析该模块。
- 开发无 SMTP → console provider；生产无 SMTP → disabled，不静默丢弃。
- 发送记录写 `email_log`；配置项见 `.dev.vars.example` 与 `docs/admin.md`。

## 多语言

- 后端 `src/i18n/{en,zh}.ts`，`en` 是源字典；前端 `apps/web/src/i18n/`。
- 错误文案用 `error.<CODE>`；`translateErrorCode` 自动匹配。
- 前端 locale 存 `localStorage["boardroom.locale"]`；请求发 `Accept-Language`，SSE 用 `?lang=`。
- 新增用户可见文案不要硬编码中文；`en.ts` 加 key 后 `zh.ts` 必须同步（类型会强制）。

## 前端架构、设计风格与维护指南

### 1. 技术栈与基础约束
- **技术栈**：React 19 + Vite + TanStack Query + 普通 CSS（`apps/web/src/styles.css`）+ `lucide-react` 图标库。不要引入第三方 CSS 框架或状态管理库。
- **严禁使用 Emoji 或特殊符号做图标**：所有 UI 图标必须使用 `lucide-react` 矢量图标；业务状态/结果/优先级/连接状态统一通过 `apps/web/src/components/Icons.tsx`（`StatusIcon`、`OutcomeIcon`、`PriorityIcon`、`ConnectionIcon`、`AgentStatusIcon`）渲染。
- **启动鉴权流**：`/setup/status` → `SetupWizard`（未初始化时）或 `/me` → `LoginPage` / `ChangePasswordPage` / `BoardApp`。
- **只读状态展示**：卡片状态变化严格走后端动作/接口（带 `If-Match` 乐观锁），前端绝不提供拖拽改状态。

### 2. IDE / 编辑器工作台设计风格（Workbench Dock Layout）
整套主界面采用 `100vw × 100vh` 的现代编辑器外框（`.workbench-shell`），最大化中央画布可视面积，避免小屏幕下顶部横栏多层折行堆叠：
- **顶部标题栏（`.workbench-titlebar`，固定单行 `38px`）**：
  - 左侧：品牌标识 + 面包屑导航（`.crumb-btn`：当前项目 / 当前状态视图）。
  - **面包屑交互规则**：点击 `.crumb-btn` 时原位弹出下拉菜单（`.crumb-dropdown-menu`），**不要**触发左侧停靠侧边栏；支持点击外部或按 `Esc` 关闭。
  - 右侧：快捷刷新按钮与「新建卡片」触发按钮。
- **左侧活动栏与停靠面板（`.activity-rail-left` + `.dock-panel-left`）**：
  - 常驻极窄图标轨（桌面 `42px` / 小屏 `36px`），面板默认收起，点击图标才展开对应侧边面板，再次点击或点 `✕` 收起。
  - 上方图标组（`.rail-group`）：项目工作区（`projects`）、状态视图过滤（`views`）、项目协作 Agents（`agents`）、项目参与者统一视图（`participants`，人类成员 + Agents）。
  - 下方图标组（`.rail-group-bottom`）：管理员面板入口（仅 `user.role === "admin"` 可见，点击在主编辑器标签栏打开管理员标签页）+ 账户与外观设置（`settings`）。
- **右侧活动栏（`.activity-rail-right`）**：
  - 放置快捷工具触发器（如唤起「新建卡片」与「协作 Agents」浮动窗口）。
- **底部状态栏与诊断台（`.workbench-statusbar`，固定 `26px` + `.dock-panel-bottom`）**：
  - 常驻显示 SSE 连接状态与最新 `seq`、卡片总数、当前用户与主题切换；点击左侧状态项可向上展开底部诊断面板（`.dock-panel-bottom`）。

### 3. 文档标签栏（`editor-tab-strip`）与中央画布
- **多标签页机制**：
  - `.editor-tab-strip` 是**编辑器文档标签栏**（而非状态过滤条）。
  - 首项常驻「看板总览（`activeTabId === "board"`）」。
  - 点击画布中的任意卡片（`CardTile`）或点击左侧下方的「管理员面板」按钮时，在 `.editor-tab-strip` 中追加/激活对应的文档标签页，并在中央编辑区内**全屏展示**（`.editor-card-tab-viewport` / `.editor-card-fullview`），不再使用右侧抽屉遮挡画布。
- **卡片网格与空状态引导**：
  - 「看板总览」标签页下使用自适应卡片网格（`.cards-grid`）展示卡片；单张 `CardTile` 顶部带状态色条、状态徽章、优先级、轮次/版本、2 行正文摘要预览、承接/发起 Agent、验收规则数与截止时间。
  - 当无卡片时，`.cards-board-placeholder` 展示 3 步快速开始教程，其正下方放置 `.placeholder-actions-row`（`grid-template-columns: 1fr 1fr`），左半列为「复制提示词」按钮，右半列为「新建卡片」按钮，各占容器列宽的 50%。

### 4. 可移动、可缩放的浮动对话框系统（`FloatingWindow`）
- 弹窗类交互（新建协商卡片 `CreateCardModal`、新建项目 `CreateProjectView`、协作 Agents `AgentsModal`）统一使用 `apps/web/src/components/FloatingWindow.tsx` 承载。
- `FloatingWindow` 特性：按住标题栏自由拖拽移动（带视口防溢出边界）、8 方向边框/边角拖拽调整大小（`n/s/e/w/ne/nw/se/sw`）、双击标题栏或点按钮最大化/还原、多窗口点击自动置顶（动态 `zIndex` 队列）。
- 新增弹窗型功能时，优先为组件提供 `windowed` / `mode="window"` 属性并接入 `FloatingWindow`，避免使用全屏锁死遮罩的传统模态框。

### 5. 前端维护检查清单
1. **样式与主题**：所有颜色必须使用 `styles.css` 中的 CSS 变量（如 `--bg-surface`、`--bg-subtle`、`--border-color`、`--accent-primary`），确保 Light / Dark 主题同时正常显示。
2. **双语字典对齐**：新增 UI 文案先加 `apps/web/src/i18n/en.ts`，再同步 `apps/web/src/i18n/zh.ts`。
3. **验证命令**：修改前端后运行 `npm --workspace apps/web run typecheck` 与 `npm --workspace apps/web run build`（或仓库根 `npm run typecheck`），确认无类型错误再完成任务。
4. **并行协作礼仪**：其他 agent 可能正在编辑代码；改文件前先读取最新状态，避免意外覆盖他人改动。

## 配置

- `wrangler.jsonc` 的 `assets.run_worker_first` 必须包含 `/`、`/setup`、`/api/*`、`/agent/*`、`/language/*`；否则静态资源会抢在 Worker 前。
- `wrangler.jsonc` 设置 `"keep_vars": true`：`APP_BASE_URL`、`ADMIN_EMAILS`、`AUTH_MODE`、`ENVIRONMENT` 等实例变量在 Dashboard 配置，代码更新不会覆盖；Secrets 用 `wrangler secret put`，也不会被 deploy 覆盖。
- 本地 `.dev.vars` 覆盖 `ENVIRONMENT=development`；生产 D1 按 `database_name=boardroom_local` 自动绑定（需账号已建同名库）、配置 Access/SMTP secret。
- `.dev.vars`、`.wrangler/`、`node_modules/`、日志不要提交。

## 测试

```bash
npm run typecheck
npm run db:migrate     # 应用 migrations/
npm run typecheck
npx vitest run
npm run smoke          # 需要后端 dev server
npm run verify-audit -- <project_id>
```

- 写路径优先扩展 `scripts/smoke-s1.mjs`；覆盖权限拒绝、版本冲突、SSE 补发。
- 改 schema 后新增 `migrations/000N_*.sql` 并 `db:migrate`，再跑 smoke；不要改已发布迁移。
- skill 仓库 `boardroom-connect-skill` 独立维护，改 Agent client 后跑它自己的 typecheck/test/build。

## 文档

- `README.md`：入口、能力、接口
- `docs/auth.md`：登录/会话/bootstrap
- `docs/admin.md`：用户管理/SMTP
- `docs/i18n.md`：多语言
- `docs/AGENT-行为规范-v1.0.md`：接入 Agent 的行为与红线
- `migrations/`：数据库迁移事实源
- `db/schema.sql`：当前 schema 快照

新增/修改接口时同步更新 README 与对应 docs；不要只改代码。

- 0010 后卡片关联写入统一经 `commitAndPublish()` / `commitCardEvent()`：关联语句按同一卡片快照保护，最后的卡片 CAS 决定 outbox 插入。处理 `event_pending`，勿在已接受的 202 后重提新消息；审计须检查 `complete` 与 `pending`，见 `docs/consistency.md`。
