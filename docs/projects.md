# 项目生命周期、归档与永久删除

项目采用「在用 → 已归档 → 永久删除」三级模型。归档是软删除，永久删除只能由实例管理员对已归档项目执行。

| 操作 | 权限 | 行为 |
|---|---|---|
| 归档 | 项目 owner / 实例 admin | 设置 `archived_at`、`archived_by`、`archive_reason`；隐藏项目并阻断访问；保留卡片、事件、审计与证据 |
| 恢复 | 项目 owner / 实例 admin | 清除归档字段；优先取回原 slug |
| 永久删除 | 仅实例 admin | 物理删除项目及关联 D1 数据，并清空 `BoardDO` 热存储 |

## 访问控制

- `loadProject` 默认拒绝已归档项目，返回 `404`；看板、卡片、成员、审计、SSE、加入申请等接口自动阻断。
- Agent 访问已归档项目返回 `403 PROJECT_ARCHIVED`（Agent 已经知道自己属于该项目）。
- `GET /projects`、`GET /me` 只返回未归档项目。
- Cron 只扫描未归档项目。
- 归档不撤销 Agent Token；恢复后原 Token 继续可用。
- 归档会把该项目 `pending` 的加入申请标记为 `rejected`。
- 归档会关闭该项目现有 SSE 连接。

## slug 规则

- 归档时把 slug 改为 `archived-<原 slug>-<8 位后缀>`，立即释放原 slug。
- 原 slug 可被新项目复用。
- 恢复时先解析原 slug：若未被占用则取回；若已被占用则生成 `<原 slug>-<6 位后缀>`。
- 已归档项目继续占用其归档后的 slug，避免审计与外部引用歧义。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/v1/projects/:pid/archive` | body `{ confirm_slug, reason? }`；已归档返回 `409 ALREADY_ARCHIVED` |
| `POST` | `/api/v1/projects/:pid/restore` | 未归档返回 `409 PROJECT_NOT_ARCHIVED` |
| `GET` | `/api/v1/projects/archived` | admin 返回全部；普通用户只返回自己仍是 owner 的归档项目 |
| `DELETE` | `/api/v1/projects/:pid` | 仅 admin；项目必须已归档；body `{ confirm_slug }` |

`confirm_slug` 接受当前 slug；归档后的项目也接受归档前的原 slug。

## 永久删除的数据清理顺序

通过 `DB.batch()` 在固定顺序下删除，避免非级联外键冲突：

```text
interventions → evidence → attempts → contracts → proposals
→ negotiation_sessions → card_deps → card_events → cards
→ agent_registrations → agent_tokens
→ agent_projects → agents → project_tokens → project_members
→ project_join_requests → audit_log → projects
```

- `cards` 在一个语句中整体删除，避免 `parent_card_id` 自引用外键冲突。
- `agents` 是全局身份行（只承载 harness/展示档案）：删除项目时按 `agents.id NOT IN (SELECT agent_id FROM agent_projects)` 清掉没有任何剩余成员关系的全局行；仍属于其他项目（含归档项目、pending/disabled 成员关系）的身份保留，便于以后恢复；归档不等于永久删除。
- D1 删除完成后调用 `BoardDO.purgeProject()`：关闭 SSE、清空 DO 中的事件/审计 buffer/meta。
- 若 DO 清理失败，D1 删除不回滚，接口返回 `{ ok: true, events_purged: false }` 并记录 Worker 日志。

## 前端

- 项目设置窗口底部有「危险操作区」，归档需要输入项目 slug 并可选填原因。
- 项目设置入口位于左侧齿轮面板的「当前项目」分组，仅项目 owner 可见；默认以编辑器标签页打开，也可拖出为浮动窗口。
- 左侧项目面板提供「已归档」入口：owner/admin 可恢复；仅 admin 可永久删除，永久删除需要再次输入 slug。
- 新增文案使用 `projectArchive.*` 中英文 key，不硬编码。
