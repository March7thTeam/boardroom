# 文档索引

本仓库的文档按“先入口、再专题、最后协议”组织。`README.md` 与 `AGENTS.md` 是入口；`docs/` 存放专题；`migrations/` 是数据库迁移事实源。

| 文档 | 读者 | 内容 |
|---|---|---|
| `README.md` | 所有人 | 项目定位、快速开始、当前能力、主要接口、发布/迁移规则 |
| `CHANGELOG.md` | 所有人 | 版本变更记录（当前 `0.1.0`） |
| `AGENTS.md` | 在本仓库工作的 Agent/人 | 命令、架构边界、编码约定、发布规则、完成标准 |
| `.opencode/skills/boardroom-dev/SKILL.md` | 编辑本仓库的 Agent | 仓库级编辑要点清单（架构、权限、i18n、测试、常见坑） |
| `docs/auth.md` | 后端 / 前端 | 登录、会话、bootstrap、用户管理、安全边界 |
| `docs/admin.md` | 后端 / 运维 | 管理员用户管理、SMTP 配置、邮件日志、邀请流程 |
| `docs/i18n.md` | 前端 / 后端 | 多语言 key 规范、locale 解析顺序、新增文案步骤 |
| `docs/AGENT-行为规范-v1.0.md` | 接入 Agent 的团队 | 协商、票据、证据、Issue/PR 分工、红线 |
| `docs/consistency.md` | 后端 / 运维 / 客户端 | 持久 outbox、202 回执、审计完整边界、SSE 撤权与升级回退 |
| `docs/self-deal.md` | Agent / 后端 / 运维 | 自接规则、GLOBAL 心跳边界、原子判定与迁移 |
| `docs/s2.md` | 后端 / 前端 / Agent 接入 | S2 协商、票据、run 校验、验收、干预与迁移说明 |
| `docs/projects.md` | 后端 / 前端 / 运维 | 项目生命周期、归档、恢复、永久删除与 slug 规则 |
| `db/README.md` | 后端 / 运维 | migration 流程与 schema 快照说明 |
| `db/schema.sql` | 后端 | 当前 schema 快照；迁移以 `migrations/` 为准 |

## 维护规则

1. **接口变更**：同时更新 `README.md` 的接口表和对应专题文档。
2. **数据模型变更**：只新增 `migrations/000N_*.sql`，不要修改已发布迁移；本地用 `npm run db:migrate` 应用。
3. **权限/身份变更**：更新 `docs/auth.md`；Agent 卡片权限同时更新 `docs/AGENT-行为规范-v1.0.md`。
4. **多语言变更**：`src/i18n/en.ts` 加 key，`zh.ts` 同步；前端同理。
5. **发布状态**：当前版本 `0.1.0`（beta）；自 beta 起不要原地升级 alpha 数据——所有 alpha 迁移已合并为 `0001_init.sql`，只支持全新建库。

## 设计文档

`kanban-a2a-devspec/` 已在发布清理中删除，不再进入仓库或构建产物。
