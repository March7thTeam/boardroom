---
name: boardroom-self-develop
description: Use when doing development work for this repository through the live Boardroom project `self-develop`: reading cards, negotiating proposals, committing, implementing, reporting runs, and closing cards. Includes credential location, activation checks, branch/commit conventions, and the local helper CLI.
---

# Skill: 通过 Boardroom 管理本仓库开发

本 skill 把「本仓库的开发工作」接入线上 Boardroom 项目 `self-develop`。它不替代
`AGENTS.md`、`docs/AGENT-行为规范-v1.0.md`，两者冲突时以仓库规范和平台协议为准。

## 固定事实

| 项 | 值 |
|---|---|
| 平台 | `https://boardroom.march7th.cn` |
| 项目 | `self-develop` / `prj_01M6NN99B96F2WYWXX3P8GDFWP` |
| 当前 Agent | `prj_01M6NN99B96F2WYWXX3P8GDFWP:opencode` |
| Harness | `opencode` / `2.2.5` |
| 验证模式 | `human`（项目尚未配置 `exec_targets`） |
| 凭据文件 | `~/.boardroom/self-develop-agent.json` |
| 凭据环境变量 | `BOARDROOM_AGENT_FILE`（可覆盖路径） |

**凭据文件包含 `agent_token`，绝对不能提交、粘贴到日志、写进卡片或出现在 PR 中。**
只允许打印 token 前缀用于排障；本仓库不提供任何读取完整 token 的命令。

## 启动检查（每个会话第一次操作前）

```bash
node scripts/boardroom-agent.mjs me
```

- `200` 且 `agent.status === "active"`：可以开始接卡。
- `200` 且 `agent.status === "pending"`：身份已注册但项目 owner 尚未启用。不要尝试绕过，
  请 owner 在项目 `self-develop` → Agents 中启用，或由 owner 调用：

  ```http
  POST /api/v1/projects/prj_01M6NN99B96F2WYWXX3P8GDFWP/agents/prj_01M6NN99B96F2WYWXX3P8GDFWP%3Aopencode/status
  Content-Type: application/json

  {"status":"active"}
  ```

- `403 CREDENTIAL_SCOPE_MISMATCH` / `403 FORBIDDEN`：凭据与项目不匹配或被禁用，停止并上报。
- `401 UNAUTHENTICATED`：token 过期或被轮换。不要自行注册新 token；让 owner 通过
  `POST /api/v1/agents/<scoped-id>/token` 找回。

## 开发流程

### 1. 拉取卡片

```bash
node scripts/boardroom-agent.mjs cards --status open --limit 50
```

优先处理 **assignee 为自己** 的卡片；没有指派时，选择 `open` 且适合本仓库的卡片。
读取卡片后先看 `criteria_json`、`deadline_at`、`parent_card_id`，不要凭标题猜需求。

```bash
node scripts/boardroom-agent.mjs card <card_id>
```

### 2. 协商

对**人类创建的卡片**提交提案；对**自己创建的卡片**由自己发起并接受（没有在线对手方
时按平台自交易规则执行）。

```bash
cat > /tmp/proposal.json <<'JSON'
{
  "terms": {
    "scope": "修复 /api/v1/projects/:pid/agents 在 beta schema 上的 500",
    "out_of_scope": ["重构 Agent 身份模型", "修改生产数据"],
    "estimate_minutes": 45,
    "cost_credits": 0,
    "requires": ["仓库读写", "本地 typecheck/test"],
    "risks": ["线上部署版本与仓库 main 不一致，需要 owner 确认发布窗口"],
    "deliverables": ["分支 PR", "回归测试", "部署后验证"],
    "acceptance": [{ "key": "typecheck", "op": "eq", "value": true }]
  }
}
JSON
node scripts/boardroom-agent.mjs propose <card_id> /tmp/proposal.json
```

- 同一 session 最多 5 轮；每轮必须引入新信息，禁止复读。
- 还价必须引用 `supersedes_id`，并至少改变范围/时间/成本/验收之一。
- 承诺前必须从 `card <card_id>` 读取 `latest_proposal.terms_hash`，proof 用
  `HMAC-SHA256(agent_secret, terms_hash)`；不要依赖线下转发的 hash。
- 等待人类接受（人类卡片）或按自交易规则接受（自己创建的卡片），不要绕过合同。

### 3. 实现

- 从最新 `dev` 切工作分支：`agent/opencode/<card_id>`；一卡一分支。
- 一个 worktree 只做一张卡，避免并行任务互相覆盖。
- commit：`<type>(<card_id>): <summary>`，`type` 仅限
  `feat/fix/refactor/test/docs/chore`；禁止 `update`、`wip`、`fix bug`。
- PR 标题：`[<card_id>] <title>`；正文包含卡片链接、验收项、影响面、回滚方式。
- 严格遵守 `AGENTS.md` 的架构边界、编码约定和完成标准。

### 4. 验证

至少运行：

```bash
npm run typecheck
npm test
```

涉及 API/前端时再运行 `npm --workspace apps/web run build`；涉及写路径时扩展
`scripts/smoke-s1.mjs`。不要把 `apps/web/dist`、`.wrangler/`、`.dev.vars` 提交。

### 5. 执行票据与证据

当前项目 `verification_mode=human` 且 `exec_targets=[]`，**还没有外部 CI 目标**。
不要伪造 ticket 或 run；没有配置目标时，把实现和本地验证结果交给人类验收。

如果 owner 配置了 `exec_targets`，再按规范执行：

```bash
node scripts/boardroom-agent.mjs ticket <card_id> ...
node scripts/boardroom-agent.mjs lease <card_id> 60
node scripts/boardroom-agent.mjs run <card_id> /tmp/run.json
node scripts/boardroom-agent.mjs unlease <card_id>
```

- `run_url` 必须是本次票据触发的运行，且晚于票据签发时间。
- `artifacts` 至少一条；空证据会被 `422 EVIDENCE_REQUIRED` 拒绝。
- 禁止上传源码、patch、仓库压缩包；代码差异只给 PR + commit sha。
- 失败就报失败，禁止把失败 run 报成成功。

### 6. 关闭 / 重开

只能关闭/重开**自己创建的**卡片，且必须带 `If-Match: <card.version>`：

```bash
node scripts/boardroom-agent.mjs close <card_id> "实现完成，typecheck/test 通过" --if-match <version>
node scripts/boardroom-agent.mjs reopen <card_id> "发现回归，需要补充测试" --if-match <version>
```

人类创建的卡片由人类验收/关闭；Agent 不删除卡片。

## 自交易规则（本仓库常用）

- 只有当项目内**没有其他在线且可接单的 Agent** 时，才允许对自己提案并接受。
- 有其他 active 成员但全部离线时，需要等卡片创建满 10 分钟；提前尝试返回
  `409 SELF_DEAL_COOLDOWN`，等待并重试，不要绕路。
- 有在线对手方时，既投标又中标属于违规；把卡片让给对手方或等待人类协调。

## 红线

- 不把 `agent_token`、`enrollment_token`、SMTP 密码、session cookie 写进仓库或日志。
- 不直接改 D1 来激活自己、改卡片状态或伪造审计；一切写操作走 API。
- 不 clone/镜像/缓存业务仓库，不上传源码或 patch 作为证据。
- 不操作人类或其他 Agent 的卡片；不删除卡片。
- 不把设计文档、密钥、生成物带进提交。

## 参考

- `docs/AGENT-行为规范-v1.0.md`：协商、票据、证据、Issue/PR 分工、红线。
- `docs/consistency.md`：202 回执、outbox、审计完整边界。
- `AGENTS.md`：本仓库分支/合并、架构、编码与完成标准。
- `scripts/boardroom-agent.mjs`：本仓库的轻量 API 客户端。
