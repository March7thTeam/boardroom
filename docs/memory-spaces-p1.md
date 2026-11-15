# P1 规格 v1：项目记忆空间 + 双方确认的跨项目链接

范围：记忆条目、跨项目链接、审计与幂等。**不含** paste 导入导出、发布任务状态机、前端 UI。
验收口径以本文为准；下面的差异清单说明当前 PR #22 的代码需要改哪些地方。

## 决策记录

| 日期 | 决策 | 来源 |
|---|---|---|
| 2026-11-15 | 快照归属：**方案 (a)，快照归目标项目**，读取只校验目标项目成员关系 | 需求方确认；维护者倾向 (a) |
| 2026-11-15 | 删除语义：默认保留快照；额外提供原子 `revoke_links`（维护者给出的最低要求） | 需求方要求「删除后仍可读」；维护者要求「至少提供删除并撤销」 |
| 2026-11-15 | `shareable` 仅人类可改，agent 只能申请链接 | 维护者 |
| 2026-11-15 | 外键 `SET NULL` 保住快照；`frozen_version` 去掉；tags 随正文不可变 | 维护者 |

## 1. 不变量

1. **记忆内容不可变**：条目创建后 title/body/tags 不再变化，只有「创建」与「删除」。
2. **空间与项目 1:1**：一个项目一个空间，空间随项目存在。
3. **跨项目需要三方动作**：作者打开 `shareable` → 源项目人类确认 → 目标项目人类确认。
4. **链接生效即冻结**：`state='active'` 的链接必须持有完整快照（DB CHECK 兜底）。
5. **删除不等于撤销**：源条目删除后，已生效链接照旧可读，只加标记；要收回访问必须显式撤销。

## 2. 数据模型

```
memory_spaces(id, project_id UNIQUE → projects ON DELETE CASCADE, slug UNIQUE, name, created_at, archived_at)

memory_entries(
  id, space_id → memory_spaces ON DELETE CASCADE,
  project_id → projects ON DELETE CASCADE,
  title, body, body_hash, tags_json,
  status ('active'|'deleted'), version,       -- version 只用于删除时的 CAS
  shareable (0|1, default 0),
  source_card_id → cards ON DELETE SET NULL,
  created_by_type/id, created_at, updated_at
)

memory_entry_links(
  id,
  entry_id → memory_entries ON DELETE SET NULL,        -- 见 5.2
  from_project_id → projects ON DELETE SET NULL,       -- 见 5.2
  to_project_id → projects ON DELETE CASCADE,
  state ('pending_source'|'pending_target'|'active'|'rejected'|'revoked'),
  requested_by_type/id, requested_at,
  source_approved_by/at, target_approved_by/at,
  rejected_by/at/reason, revoked_by/at,
  frozen_title, frozen_body, frozen_body_hash, frozen_at,
  CHECK (from_project_id <> to_project_id)
  CHECK (state <> 'active' OR (frozen_body IS NOT NULL AND frozen_body_hash IS NOT NULL))
)
uq_memory_link_open(entry_id, to_project_id) WHERE state IN ('pending_source','pending_target','active')
```

删除 `frozen_version`：内容不可变后它恒为 1，没有语义；保留 `frozen_body_hash` 作为内容指纹。

## 3. 权限矩阵

| 动作 | 谁 | 说明 |
|---|---|---|
| 创建/删除条目 | 项目成员（人）；项目内 active agent | 只能删自己创建的 |
| 打开/关闭 `shareable` | **仅人类**：条目作者 或 项目 owner/admin | **agent 不能改**（现行代码有误，见差异 4） |
| 申请链接 | 目标项目的成员（人）或 active agent | 源条目必须 `shareable=1` |
| 确认链接 | 源项目 owner/admin；目标项目 owner/admin | 各确认一次，顺序固定 |
| 拒绝链接 | 任一侧 owner/admin | 只在 pending 状态 |
| 撤销链接 | 源项目 owner/admin | active 或 pending_target |
| 读取链接内容 | 目标项目 active 成员（人 + agent） | **不再校验源项目**（见 4） |

## 4. 读取：快照归目标项目

采纳方案 (a)。链接生效时冻结的内容属于目标项目：

- 读取只校验「读者是目标项目的 active 成员」+「链接属于该目标项目」+「链接 state=active」。
- **不再检查读者是否在源项目**。这同时意味着：源项目删除该条目后，源项目自己的成员也只能经目标项目的链接读到快照——这是有意的，因为删除只是「源项目下线这份知识」，不是「从平台抹除」。
- 「同时参与两个项目」不再是访问控制条件，只保留为申请时的便利（谁的 agent 两边都在，谁更容易发现该申请哪条）；链接本身由两侧人类确认，不依赖成员重叠。

## 5. 删除语义

### 5.1 默认：删除保留快照

- `DELETE` 把 `status` 置为 `deleted`、`version+1`（CAS），条目行与冻结快照都保留。
- 已 `active` 的链接继续可读，返回 `source_deleted=true`。
- `shareable` 允许对已删除条目继续切换（关闭即批量撤销未结束链接），**修正现行代码的 409**。

### 5.2 显式：删除并撤销（止血）

- `DELETE` 接受 `{"revoke_links": true}`：同一事务里删除条目 + 把该条目所有未结束链接置为 `revoked`。
- 用于「误写进凭据」这类必须立刻切断的场景——内容不可变，删除是唯一补救，此时默认保留快照反而是风险。
- 物理删除与源项目删除：`entry_id` / `from_project_id` 改为 `ON DELETE SET NULL`，快照与链接行保留，读取返回 `source_missing=true`。触发器改为「`from_project_id` 非空时必须等于条目所属项目」。
- 彻底清除快照正文（purge）与上面「删除仍可读」不变量冲突，**P1 不做**，单独设计。

## 6. 状态机

条目：`(none) → active → deleted`。无其它转移。

链接：`pending_source → pending_target → active`；`pending_* → rejected`；`pending_target|active → revoked`。
顺序不可颠倒；目标侧确认时才写 `frozen_*`。

## 7. 事件与审计

- 事件类型：`memory.entry_created`、`memory.entry_deleted`、`memory.entry_share_toggled`、
  `memory.link_requested`、`memory.link_source_approved`、`memory.link_activated`、
  `memory.link_rejected`、`memory.link_revoked`。
- 一律写入**发起动作所在项目**的事件链；`payload` 只放 id 与 `body_hash`，**不放正文**。
- 指针是派生查询，不产生事件。

## 8. 幂等与原子性

- 写路径一律走 `commitCardEvent`（`card_id = NULL`）+ `uq_outbox_project_message(project_id, message_id) WHERE card_id IS NULL`。
- 相同 `message_id` 重放返回原 receipt（200 + `duplicate:true`），不新增事件、不改版本。
- 相同 `message_id` 携带不同请求体 → `409 CONFLICT`。
- 条目/链接状态变更与 outbox 写入同批原子（D1 batch）。

## 9. 内容安全

- 写入（人 + agent）都过密钥扫描，命中 `422 SECRET_DETECTED`；`shareable` 打开与链接激活时不再重复扫描。
- 扫描是启发式，**不作为「内容可公开」的证明**；对外可见仍由两侧人类确认决定。
- 单条 body ≤ 8KB、每空间 ≤ 2000 条。

## 10. 验收项

| 项 | 判定 |
|---|---|
| 不可变 | PATCH 条目返回 404；DB 无 UPDATE 正文路径 |
| 删除默认保留 | 源删除后目标读取 200，`source_deleted=true`，正文与哈希不变 |
| 删除并撤销 | `revoke_links:true` 后链接 `revoked`，读取 410 |
| 物理删除 | 源行与源项目删除后，链接仍可读，`source_missing=true` |
| 顺序 | 目标项目先确认 → 409 `LINK_STATE_INVALID` |
| 权限 | 普通成员确认 → 403；agent 改 `shareable` → 403 |
| 目标项目可见 | 只在目标项目 active、不在源项目的 agent 也能读 |
| 撤销 | `revoke` 后读取 410 `LINK_REVOKED`，可重新申请 |
| 幂等 | 同 `message_id` 重放 200 duplicate；不同 body → 409 |
| 扫描 | 含 `kbt1.`/`ghp_` 等特征 → 422 |
| 配额 | 超 2000 条 → 409 `QUOTA_EXCEEDED` |
| 隔离 | 无链接时跨项目读取一律 404 |

## 11. 差异清单（已按本规格改完，PR #22 仍为 draft）

1. `readPointer` / `listPointers` 去掉源项目成员校验，改为目标项目成员校验。
2. `entry_id`、`from_project_id` 改 `SET NULL`，放宽非空约束，改触发器，补物理删除测试。
3. `DELETE` 增加 `revoke_links` 选项；`shareable` 允许作用于已删除条目。
4. `setShareable` 拒绝 agent（当前允许 agent 改自己创建的条目）。
5. 迁移去掉 `frozen_version`。

以上 5 项已在 `feat/memory-spaces-p1` 上落地，PR 保持 draft，等待规格确认后再请求 review。
