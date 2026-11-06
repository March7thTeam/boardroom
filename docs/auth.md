# 用户登录与会话

S1 使用**应用内账号 + HttpOnly 会话 Cookie**。Cloudflare Access 仍可作为可选上游，但不是登录系统的前提。

## 数据模型

`db/schema.sql` 新增：

- `users.password_hash`：`pbkdf2$<iterations>$<salt>$<hash>`，PBKDF2-SHA256 100k 次（Cloudflare Workers WebCrypto 的迭代上限），16 字节随机 salt。
  - **部署层（#2）**：上限由 workerd 运行时强制，免费层与付费层（Workers Paid）都按 100k 处理——付费层是否更高 Cloudflare 未给出权威说明，因此代码不区分层级，两者行为一致。`wrangler dev` 本地不应用该上限，验证必须在实际部署的 Worker 上跑通 `POST /api/v1/setup` 与一次登录。
  - **强度影响**：100k 低于 OWASP 对 PBKDF2-SHA256 的建议值（600k），这是平台约束下的折中；更强的算法（scrypt / argon2）属独立重构。
  - **旧哈希**：`verifyPassword` 拒绝 `>100k` 的哈希。210k 常量在线上运行时生成哈希即抛错，因此线上实例不会存在这类哈希；只有曾在本地 `wrangler dev` 下创建的账号可能是 210k，处理方式是由实例管理员重置密码（`POST /api/v1/users/:uid/password`）。
- `users.status`：`active | disabled`。
- `users.must_change_password`：管理员创建/重置后的临时密码标记。
- `user_sessions`：会话 token 的 SHA-256 哈希、过期时间、撤销时间、UA/IP 哈希。
- `user_auth_events`：bootstrap / 登录成功/失败 / 登出 / 改密 / 重置密码。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v1/setup/status` | `{ needs_setup, instance_name, auth_mode }`，公开 |
| `POST` | `/api/v1/setup` | 首次配置：实例名 + 管理员 + 可选首个项目 |
| `GET` | `/api/v1/instance` | 实例名称，公开 |
| `GET` | `/api/v1/auth/status` | `{ needs_bootstrap, auth_mode }`，公开 |
| `POST` | `/api/v1/auth/bootstrap` | 仅当没有任何用户时创建第一个 admin |
| `POST` | `/api/v1/auth/login` | `{ email, password }`，成功写会话 Cookie |
| `POST` | `/api/v1/auth/logout` | 撤销当前会话并清 Cookie |
| `GET` | `/api/v1/auth/me` | 当前登录用户 |
| `POST` | `/api/v1/auth/password` | `{ current_password, new_password }`，改密后撤销全部会话 |
| `GET` | `/api/v1/users?status=&role=&q=` | admin：用户搜索 |
| `GET` | `/api/v1/users/:uid` | admin：详情 + 活跃会话 + 认证事件 |
| `POST` | `/api/v1/users` | admin：直接创建用户（指定密码） |
| `POST` | `/api/v1/users/invite` | admin：创建用户 + 临时密码 + 邀请邮件 |
| `POST` | `/api/v1/users/:uid/invite` | admin：重发邀请 |
| `PATCH` | `/api/v1/users/:uid` | admin：改显示名/角色/启停 |
| `DELETE` | `/api/v1/users/:uid` | admin：软删除（禁用） |
| `POST` | `/api/v1/users/:uid/revoke-sessions` | admin：撤销全部会话 |
| `POST` | `/api/v1/users/:uid/password` | admin：重置密码，可选邮件 |
| `GET/POST` | `/api/v1/projects/:pid/members` | 成员：成员列表；owner：添加已存在用户（`member` 或 `admin`） |
| `PATCH/DELETE` | `/api/v1/projects/:pid/members/:uid` | owner：修改项目角色（`member`/`admin`，不能提升为 owner）/ 移除成员（不能移除 owner） |
| `POST` | `/api/v1/projects/:pid/owner` | owner：把所有权转让给现有成员 `{ user_id }`，原 owner 保留为 member |
| `POST` | `/api/v1/projects/:pid/join-requests` | 登录用户：提交加入项目申请 |
| `GET` | `/api/v1/join-requests` | 登录用户：我的待审批/已拒绝申请 |
| `GET` | `/api/v1/projects/:pid/join-requests` | owner：待审批申请列表 |
| `PATCH` | `/api/v1/projects/:pid/join-requests/:uid` | owner：批准或拒绝申请 |
| `POST` | `/api/v1/projects/:pid/archive` | owner / admin：归档项目（需确认当前 slug） |
| `POST` | `/api/v1/projects/:pid/restore` | owner / admin：恢复已归档项目 |
| `GET` | `/api/v1/projects/archived` | admin：全部；普通用户：自己仍是 owner 的已归档项目 |
| `DELETE` | `/api/v1/projects/:pid` | **仅实例 admin**：永久删除已归档项目 |
| `POST` | `/api/v1/projects/:pid/agents/:aid/status` | 项目 owner：按项目启停 Agent |
| `GET/POST` | `/api/v1/admin/email/*` | admin：SMTP 状态、测试、日志 |

> 用户管理与邮件细节见 `docs/admin.md`。

## 会话

- Cookie 名：`boardroom_session`；`HttpOnly`、`SameSite=Lax`、`Path=/`；HTTPS 下自动 `Secure`。
- 有效期 7 天，活跃时滑动续期（最多每小时写一次 `last_seen_at`）。数据库续期成功后，在响应中重发同一个会话 token 的 Cookie，同步刷新浏览器的 7 天有效期；续期失败或会话已撤销时不延长 Cookie。
- 数据库只存 `SHA-256(token + TOKEN_PEPPER)`；明文 token 只出现在 Cookie。
- 改密、管理员重置、禁用用户都会撤销会话。
- 登录失败按邮箱统计：15 分钟内 5 次失败后返回 `429 RATE_LIMITED`。

## 首次启动

1. 打开根目录 `/`；Worker 检测到空库会 **302 跳转 `/setup`**（已初始化时访问 `/setup` 会 302 回 `/`）。
2. `GET /api/v1/setup/status` 返回 `needs_setup: true`。
2. 进入 4 步配置向导：
   - 实例信息（实例名称）
   - 管理员账号（邮箱、显示名、密码 ≥10 位）
   - 首个项目（可选：名称、slug、验收模式）
   - 确认并提交
3. 提交 `POST /api/v1/setup`：创建 admin、写入 `instance_settings`、可选创建首个项目并返回 enrollment token。
4. 自动登录并进入看板；`needs_setup` 变为 false。

之后新增用户由管理员在 `POST /api/v1/users` 创建。项目 owner 只能把**已存在用户**加入项目（`POST /api/v1/projects/:pid/members`）；用户不存在时返回 `404 USER_NOT_FOUND`，需先由管理员创建账号。**每个项目只有一个 owner（#14）**：添加成员或修改角色时设为 `owner` 返回 `409 SINGLE_OWNER`；变更 owner 由当前 owner 或实例管理员通过 `POST /api/v1/projects/:pid/owner` 转让，转让在同一批次内完成，原 owner 降为 member。owner 不能被降级或移除（`409 LAST_OWNER`），因此不会再出现「A 邀请 B 成为 owner 后被 B 反向移除」。数据库层由 `uq_project_single_owner` 部分唯一索引兜底。

### 项目角色

项目级角色是 `project_members.role`，取值 `owner` / `admin` / `member`：

- `owner`：每个项目唯一；管理成员、转让所有权、归档项目。
- `admin`：由 owner 在「项目参与者」面板授予或撤销；可执行卡片的管理员操作，但不能管理成员、转让所有权或归档项目。
- `member`：普通项目成员；不能使用管理员操作。

owner 在参与者面板通过每位成员的「修改权限」下拉切换 `member` / `admin`；添加成员时也可以直接选择 `admin`。项目管理员不能修改其他成员的角色。

### 实例管理员

实例级角色是 `users.role`（前端显示为「实例管理员 / 普通用户」），与项目级角色使用不同的名称与徽标。实例管理员对**非成员**项目拥有隐式 owner 权限（`requireProjectMember` 兜底）：`GET /api/v1/projects` 与 `GET /api/v1/me` 返回全部未归档项目，非成员项目标注 `role: "owner"`、`access: "admin"`。实例管理员若在项目中**有**显式成员关系，以该成员角色为准。

无项目用户可以在空状态面板输入项目 ID 提交加入申请（`POST /api/v1/projects/:pid/join-requests`）。申请进入 `pending`，项目 owner 在参与者面板批准后才写入 `project_members`；拒绝时只更新申请状态，不影响成员表。待审批申请列表仅 owner 可见。

项目归档是软删除：项目 owner 或实例 admin 可归档；归档会隐藏项目、阻断成员/Agent/SSE 访问、把待审批加入申请标记为 `rejected`，并把 slug 改名为 `archived-<原 slug>-<后缀>` 以释放原 slug。恢复时优先取回原 slug；若原 slug 已被复用，则生成带后缀的新 slug。永久删除只允许实例 admin 对**已归档**项目执行，会按依赖顺序清理 D1 数据并调用 `BoardDO.purgeProject()` 清空热存储。

`POST /api/v1/auth/bootstrap` 仍保留给脚本/API 客户端使用，但前端首次启动走 `/setup` 向导。

## 身份解析顺序

后端 `requireUser`：

1. **仅 development**：`X-Dev-Email` 或 `?dev_email=`（脚本/curl 便利）。
2. 会话 Cookie → `user_sessions` + `users.status='active'`。
3. `AUTH_MODE=access` 时：`ctx.access.getIdentity()` 自动 JIT 用户。
4. 否则 `401 UNAUTHENTICATED`。

生产环境必须保证 `ENVIRONMENT != "development"`，并设置 `AUTH_MODE=session` 或 `access`。

## 前端

- `App` 先请求 `/setup/status` 与 `/me`；`needs_setup=true` 时渲染 `SetupWizard`。
- 已完成初始化但 `/me` 返回 401 时渲染 `LoginPage`（仅登录表单）。
- 登录后如果 `must_change_password=true`，`ChangePasswordPage` 会强制改密；改密成功会撤销会话并要求重新登录。
- 登录/登出成功后清空 Query 缓存并刷新页面，避免残留旧会话数据。
- 顶栏显示当前用户、角色和退出按钮。
- 语言选择器、登录页、配置向导共用 `I18nProvider`。

## 安全边界

- 密码只存 PBKDF2 哈希，比较使用恒定时间函数。
- 会话 token 32 字节 CSPRNG，数据库不存明文。
- 不提供公开注册；账号由 bootstrap 或管理员创建。
- Cookie `SameSite=Lax` + 同源 SPA 降低 CSRF 面；MVP 未额外实现 CSRF token。
- `TOKEN_PEPPER` 轮换会使所有 Agent 令牌与会话失效，仅在泄漏时使用。

## 凭据与身份更新

- `users.auth_version` 与 `user_sessions.auth_version` 绑定。改密码、重置、撤销会话、角色/启停改变均使用条件写入并撤销旧会话；密码校验期间发生重置时不会签发旧版本会话。滑动 Cookie 续期仍在数据库成功后执行。
- `/setup` 与 `/auth/bootstrap` 共用永久 `bootstrap_claim` 原子门闩；并发只能有一个首次安装获胜。已有实例即使后来没有用户行，也不能重新认领为全新实例。
- `must_change_password=1` 在服务端强制：仅允许读取 `/me`、`/auth/me`，改密与登出；其他受保护接口返回 `403 PASSWORD_CHANGE_REQUIRED`。不依赖前端跳转保护。
- **所有 Agent Token 都是 scoped 的**：`kbt1` 载荷必须是 `<project_id>:<local_slug>`，且只在其签发项目内有效；legacy 跨项目格式（beta 前的 alpha token）一律 `401`。凭据修改/轮换证明始终核对实际 token 行的项目，其他项目的凭据不能作为本项目证明。
- 注册的 Authorization 仍为目标 Enrollment Token，且 `id` 必须是目标项目的 `<project_id>:<local_slug>`。已有身份要修改元数据或轮换凭据时另带 `X-Agent-Authorization: Bearer <目标项目 Agent Token>`；无证明的已有注册重试只读，不修改身份/历史。
- `POST /agents/:aid/token` 为项目 owner 的找回路径：仅轮换目标项目凭据并回到 pending，不能隐式复活 disabled 关系；disabled 必须先通过显式启用动作恢复。`token_version` CAS 防止旧激活或并发轮换覆盖新凭据。
- `aid` 与卡片 assignee、`proof.by` 只接受目标项目 `<project_id>:<local_slug>`；internal ID（`ag_<ulid>`）不再作为公开引用。项目的成员显示名按项目保存，全局 avatar 可由任一成员项目的 owner 编辑；历史按 `(agent, project)` 保留最近 50 条。
- 重新生成 Enrollment Token 会撤销旧注册令牌，不改变已注册 Agent 的项目凭据。前端一次性令牌由上层状态持有，必须明确确认后关闭；编辑草稿固定开始时的版本，远端更新不会静默改为新版本覆盖保存。

禁用关系不占 Agent 名额；重新启用时两个状态入口都在条件 UPDATE 内检查实时非 disabled 数量，满额返回 `403 QUOTA_EXCEEDED`。pending 转 active 已占名额，不重复计数；禁用仍允许。项目限额优先采用当前未撤销的最近注册令牌配置，否则保留最近记录；令牌过期不会让容量无限，没有记录时默认 50。
