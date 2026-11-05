# AGENTS.md

本文件是**在本仓库内工作的 AI/人类协作者**的操作规范。它不替代产品协议。

## 先读什么

1. `README.md`：项目定位、启动方式、当前能力。
2. `docs/README.md`：文档索引与维护规则。
3. `.opencode/skills/boardroom-dev/SKILL.md`：本仓库的编辑要点清单（架构、权限、i18n、测试、常见坑）。
4. `docs/AGENT-行为规范-v1.0.md`：**接入本平台的 Agent** 必须遵守的行为规范（协商、票据、证据、红线）。它面向 Agent 使用者，不是本仓库的编码规范。
5. `docs/i18n.md`：多语言 key 规范、locale 解析顺序与新增文案步骤。
6. `docs/auth.md`：登录、会话、bootstrap 与管理员用户管理。
7. `docs/admin.md`：用户管理接口、SMTP 配置与邮件日志。
8. `db/schema.sql`：唯一数据模型事实源。
9. `src/domain/state-machine.ts`、`src/do/board.ts`、`src/routes/`：状态机、事件序列、API 实现。

产品决议（v1.1）优先于旧设计文档：纯对等协商、执行交给外部 CI、平台只做治理与审计、不做中央 planner / 自建执行器 / 仓库镜像。

## 常用命令

```bash
npm install
npm run db:migrate    # 应用 migrations/
npm run db:migrate:remote  # 远程 D1（按 database_name=boardroom_local 自动绑定，需生产账号已建同名库）
npm run dev           # 构建前端并启动 Worker（8787）
npm run dev:api       # 只启动 Worker
npm run dev:web       # Vite HMR（5173，代理 /api）
npm run typecheck
npm test
npm run smoke         # 需要 dev:api 已启动
npm run verify-audit -- <project_id>
```

## 架构边界（不要越界）

| 允许 | 禁止 |
|---|---|
| Worker (Hono) + D1 + 单 `BoardDO` + Cron | `AgentDO`、中央 planner、自建调度器 |
| SSE + `Last-Event-ID` | WebSocket（MVP 延后） |
| REST `/api/v1/*` 与 `/agent/*` | MCP / A2A JSON-RPC（MVP 延后） |
| 记录 run 引用 + 证据 hash | clone/镜像/缓存仓库、上传源码或 patch |
| GitHub Actions 票据校验 | 平台内跑容器/执行任务 |
| 5 状态机 + 乐观锁 | 可编辑拓扑、拖拽改状态 |

- 平台**零代码副本**：不出现 `git clone`、tarball、zipball 等代码路径。
- 状态以 D1 为准；事件 `seq` 只由 `BoardDO` 分配；审计链由 `BoardDO` 维护。
- 每条状态迁移必须产生事件 + 审计；写卡片必须 `If-Match`。

## 编码约定

- TypeScript strict；业务代码统一用 `nowIso()` / `addDaysIso()`，不要散落 `new Date()` 取当前时间。
- ID 使用 `newId(prefix)` / ULID；时间统一 ISO-8601 UTC 毫秒。
- 错误统一 `HttpError` → `{ error: { code, message, details?, request_id } }`。
- 令牌只存 `SHA-256(secret‖pepper)`，恒定时间比较；日志里只允许 prefix。
- 路由层只做鉴权/校验/编排；状态机与审计哈希放 `src/domain/`。
- 新增写路径必须考虑：D1 条件更新与 outbox 同一事务 → `BoardDO.publish()` → 事件/审计/SSE。
- 修改 `BoardDO` 的写入逻辑时保持串行（`enqueueWrite`），不要引入并发 `seq`。
- 前端在 `apps/web/`，当前是 React 19 + Vite + TanStack Query + 普通 CSS；不要引入新框架或重写样式体系。
- 多语言：`src/i18n/en.ts` 是源字典，`zh.ts` 必须与它键对齐；前端用 `useI18n()`，后端错误用 `error.<CODE>` key。新增用户可见文案不要硬编码中文。
- 登录：密码只存 PBKDF2 哈希，会话只存 token 哈希；受保护路由用 `requireUser`，管理员路由再加 `requireAdmin`。`X-Dev-Email` 绕过仅限 `ENVIRONMENT=development`。
- 首次启动：前端 `SetupWizard` 调用 `POST /setup`（实例名 + admin + 可选首个项目）；`/setup/status` 是唯一判断入口。
- Agent 卡片权限：Agent 可创建卡片、关闭/重开**自己创建的**卡片；不能删除，不能操作人类或其他 Agent 的卡片。所有权以 `created_by_type='agent'` + `created_by_id` 判定。
- 邮件：统一走 `src/providers/email.ts` 的 `sendAndLogEmail()`，不要在路由里直接建 SMTP 连接；SMTP 实现只在 `smtp.ts`（`cloudflare:sockets`）。
- 生成物 `apps/web/dist/` 不要手改。

## 发布规则（重要）

- 当前版本：`0.1.0`（beta）。自 beta 起所有 alpha 增量迁移合并为单一 `migrations/0001_init.sql`，没有从 alpha 实例原地升级的路径。
- `wrangler.jsonc` 默认 `ENVIRONMENT=production`；本地 `.dev.vars` 覆盖为 `development`，不要把 `.dev.vars` 提交。
- `wrangler.jsonc` 的 `"keep_vars": true` 保护 Dashboard 中的实例变量（`APP_BASE_URL`、`ADMIN_EMAILS`、`AUTH_MODE`、`ENVIRONMENT`）；Secrets 由 `wrangler secret put` 管理，不会被 deploy 覆盖。
- 数据库以 `migrations/0001_init.sql` 为起点；改表只新增 `000N_*.sql`，用 `npm run db:migrate` 应用。**不要再使用删库重置**。
- 发布前使用的 `db/drop.sql`、`scripts/db-reset.mjs`、`kanban-a2a-devspec/` 已删除；`db/schema.sql` 仅保留为当前 schema 快照。
- 不提交 `.dev.vars`、`.wrangler/`、`node_modules/`、日志文件。

## 完成标准

一个改动至少满足：

1. `npm run typecheck` 通过。
2. `npm test` 通过；涉及写路径时补测试或扩展 `scripts/smoke-s1.mjs`。
3. 涉及 API 时更新 `README.md` 的接口表。
4. 涉及状态/事件/审计时说明不变量是否仍成立（I1–I6、`seq` 连续、哈希链）。
5. 不把设计文档、密钥、生成物带进提交。

## 相关仓库

- Agent 接入 skill / 参考 client：独立仓库 `boardroom-connect-skill`（与本仓库并列，不在此仓库内修改）。

- 卡片关联写入统一经 `commitAndPublish()` / `commitCardEvent()`：关联语句按同一卡片快照保护，最后的卡片 CAS 决定 outbox 插入。处理 `event_pending`，勿在已接受的 202 后重提新消息；审计须检查 `complete` 与 `pending`，见 `docs/consistency.md`。
