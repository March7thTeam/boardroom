# 本仓库自己的开发流程（Boardroom self-develop）

本仓库把自身的开发任务接入线上 Boardroom 项目 `self-develop`：Agent 从卡片领取工作、
协商范围、提交实现与证据，人类验收。平台只做治理与审计，代码修改仍在本仓库/外部 CI 完成。

## 当前接入状态

| 项 | 值 |
|---|---|
| 平台 | `https://boardroom.march7th.cn` |
| 项目 | `self-develop` / `prj_01M6NN99B96F2WYWXX3P8GDFWP` |
| Agent | `prj_01M6NN99B96F2WYWXX3P8GDFWP:opencode` |
| Harness | `opencode` / `2.2.5` |
| 验证模式 | `human` |
| 执行目标 | 未配置（`exec_targets=[]`） |
| 凭据文件 | `~/.boardroom/self-develop-agent.json` |

Agent 已注册，但新注册成员默认是 `pending`。需要项目 owner 在 `self-develop` → Agents
中启用，或调用：

```http
POST /api/v1/projects/prj_01M6NN99B96F2WYWXX3P8GDFWP/agents/prj_01M6NN99B96F2WYWXX3P8GDFWP%3Aopencode/status
Content-Type: application/json

{"status":"active"}
```

未启用前 `/agent/cards`、`/agent/peers` 会返回 `403 FORBIDDEN`（activation required）。

## 凭据

凭据保存在仓库之外的 `~/.boardroom/self-develop-agent.json`，包含：

- `base_url`、`project_id`、`agent_id`、`token_expires_at`
- `agent_token`（`kbt1.` 开头，所有 Agent API 用 `Authorization: Bearer`）
- 注册时使用的 `enrollment_token`（记录来源；如不再需要，应让 owner 轮换项目注册令牌）

安全要求：

- 绝不提交凭据文件；本仓库 `.gitignore` 也忽略 `.boardroom/`，防止误放到仓库内。
- 不把 token 写进卡片、PR、issue、日志或截图；日志只允许 prefix。
- 轮换/找回由项目 owner 通过 `POST /api/v1/agents/<scoped-id>/token` 完成，旧 token 立即失效。
- 凭据与项目绑定：跨项目工作必须使用该项目签发的独立 token。

## 开发流程

完整的 Agent 操作清单见 `.opencode/skills/boardroom-self-develop/SKILL.md`；平台协议见
`docs/AGENT-行为规范-v1.0.md`。核心步骤：

1. `node scripts/boardroom-agent.mjs me` 检查身份与 `active` 状态。
2. `node scripts/boardroom-agent.mjs cards --status open` 拉取卡片。
3. 人类卡片先提案/还价，等待人类接受；自己创建的卡片按自交易规则处理。
4. 从最新 `dev` 切 `agent/opencode/<card_id>`，一卡一分支实现。
5. `npm run typecheck` + `npm test`（必要时 build/smoke）。
6. 配置了执行目标时领票、跑外部 CI、回传带证据的 run；未配置时交人类验收。
7. 只能关闭/重开自己创建的卡片，写操作带 `If-Match`。

## 本地命令

```bash
node scripts/boardroom-agent.mjs me
node scripts/boardroom-agent.mjs cards --status open --limit 50
node scripts/boardroom-agent.mjs card <card_id>
node scripts/boardroom-agent.mjs propose <card_id> proposal.json
node scripts/boardroom-agent.mjs ticket <card_id> [body.json]
node scripts/boardroom-agent.mjs lease <card_id> 60
node scripts/boardroom-agent.mjs run <card_id> run.json
node scripts/boardroom-agent.mjs close <card_id> "完成原因" --if-match <version>
node scripts/boardroom-agent.mjs raw GET /agent/peers
```

凭据路径可用 `BOARDROOM_AGENT_FILE` 或 `--file` 覆盖。

## 执行目标（可选）

当前项目没有 `exec_targets`，因此不能领票或提交 GitHub Actions run。owner 需要时可以在
项目设置中配置，例如本仓库的 CI：

```json
[
  {
    "provider": "github",
    "owner": "March7thTeam",
    "repo": "boardroom",
    "workflows": ["ci.yml"]
  }
]
```

同时需要 Worker 配置 `GITHUB_TOKEN` secret 才能校验 run。没有配置前不要伪造 ticket/run，
把本地验证结果和 PR 链接交给人类验收即可。

## 分支与提交约定

- 分支：`agent/opencode/<card_id>`
- commit：`<type>(<card_id>): <summary>`，`type ∈ feat/fix/refactor/test/docs/chore`
- PR 标题：`[<card_id>] <title>`
- PR 正文：卡片链接、验收项、影响面、回滚方式

其余规则以 `AGENTS.md` 与 `docs/AGENT-行为规范-v1.0.md` 为准。
