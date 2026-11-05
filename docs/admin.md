# 管理员模块与 SMTP 邮件

管理员接口统一要求 `requireUser + requireAdmin`。规范路径是 `/api/v1/users`，同时提供 `/api/v1/admin/users` 别名，方便管理端按模块挂载。

## 用户管理

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/users?status=&role=&q=` | 用户列表，支持启停状态、角色、邮箱/显示名模糊搜索 |
| `GET` | `/users/:uid` | 用户详情 + 活跃会话数 + 最近 20 条认证事件 |
| `GET` | `/users/:uid/auth-events` | 最近 200 条登录/登出/改密/重置事件 |
| `POST` | `/users` | 直接创建用户（管理员指定密码） |
| `POST` | `/users/invite` | 创建用户并生成临时密码，可选发送邀请邮件 |
| `POST` | `/users/:uid/invite` | 重发邀请：重置临时密码、撤销旧会话、发送邮件 |
| `PATCH` | `/users/:uid` | 改显示名、角色、启停状态 |
| `DELETE` | `/users/:uid` | 软删除：禁用用户并撤销会话（不物理删除） |
| `POST` | `/users/:uid/revoke-sessions` | 撤销该用户全部会话 |
| `POST` | `/users/:uid/password` | 管理员重置密码，可选发送邮件 |

约束：

- 不能禁用/降级最后一个 `active admin`。
- 不能通过 `DELETE` 禁用自己。
- 项目 owner 只能把已存在用户加入项目；新账号仍需管理员在本模块创建（见 `docs/auth.md`）。
- 邀请/重置生成的临时密码只返回一次，且 `must_change_password=1`；用户登录后前端强制改密。
- 邮件发送失败不会回滚用户创建/密码重置，响应里会带 `email.ok=false`，管理员可复制临时密码手动交付。
- 认证事件记录在 `user_auth_events`；会话只存 token 哈希。

## SMTP 配置

在 `.dev.vars` / 生产 secret 中配置：

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_USER=boardroom
SMTP_PASSWORD=...
SMTP_FROM=Boardroom <no-reply@example.com>   # 可选，默认回退到 SMTP_USER
SMTP_SECURE=on            # on | starttls | off
SMTP_REPLY_TO=
APP_BASE_URL=https://boardroom.example.com
```

Provider 选择：

| 条件 | Provider | 行为 |
|---|---|---|
| `SMTP_HOST` + (`SMTP_FROM` 或 `SMTP_USER`) | `smtp` | 通过 `cloudflare:sockets` 走 SMTP；支持 `on` / `starttls` / `off` |
| 无 SMTP 且 `ENVIRONMENT=development` | `console` | 只记录投递元数据，不记录邮件正文，返回 `status=skipped` |
| 无 SMTP 且非 development | `disabled` | 返回 `status=failed`，不静默丢弃 |

SMTP 实现细节：

- 支持 `AUTH LOGIN`（用户名 + 密码）、`EHLO`、`MAIL FROM`、`RCPT TO`、`DATA`、`QUIT`。
- 15 秒超时；不自动重试（避免重复发信）。
- 正文使用 UTF-8 + base64，主题非 ASCII 时使用 RFC 2047 编码。
- `SMTP_FROM` 可以是 `Name <address>`；信封地址会自动提取尖括号内容。
- 未设置 `SMTP_FROM` 时使用 `SMTP_USER` 作为发件人（很多服务商允许认证账号以自身地址发信）。
- 发送结果写入 `email_log`（`sent` / `failed` / `skipped`），不保存正文、临时密码或原始 provider 错误。

## 邮件接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v1/admin/email/status` | `{ configured, provider, from, host, port, secure }` |
| `POST` | `/api/v1/admin/email/test` | `{ to? }`，默认发给当前管理员；结果同时写日志 |
| `GET` | `/api/v1/admin/email/log?status=&limit=` | 最近邮件发送记录 |
| `GET` | `/api/v1/admin/overview` | 用户/项目/卡片/活跃会话计数 |

## 邮件模板

- 邀请：`<实例名> 邀请你加入`，包含登录地址、邮箱、临时密码、首次登录改密提示。
- 密码重置：`<实例名> 密码已重置`，包含新临时密码。
- SMTP 测试：固定英文测试正文 + 实例地址 + 时间。

模板目前在 `src/routes/users.ts` 内生成；后续多语言/品牌化可迁移到 `src/lib/email-templates.ts`。

## 相关表

- `users` / `user_sessions` / `user_auth_events`
- `email_log`（新增，记录每次发送的 provider/status/error）
- `instance_settings`（实例名，用于邮件标题与正文）

0010 清除当前库历史邮件正文并脱敏历史 provider 错误。密码重置成功与邮件投递成功分开报告；投递失败不回滚已保存的密码，前端明确展示失败。用户列表/最后 active admin 保护在同一条件写路径内完成，并发不能降级或禁用全部管理员。
