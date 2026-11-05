# Database

当前版本 `0.1.0`（beta）起，数据库使用**单一初始迁移**：

```bash
npm run db:migrate          # 本地
npm run db:migrate:remote   # 远程
```

## 文件

- `migrations/0001_init.sql`：beta 起唯一迁移（合并了 alpha 的 0001–0010）；全新建库只运行它。
- `db/schema.sql`：当前 schema 快照，便于阅读；**迁移以 `migrations/` 为准**。

## 改表规则

1. 不要修改 `0001_init.sql`（已发布）。
2. 新增 `migrations/000N_xxx.sql`，只增不改。
3. 本地先 `npm run db:migrate`，再跑 `npm run smoke`。
4. 远程部署用 `database_name` 自动绑定，确保目标账号存在同名库 `boardroom_local`，再 `npm run db:migrate:remote`。

## 注意

- beta 不承担从 alpha（≤0.5.0）原地升级的义务；alpha 实例要继续使用时，部署新库并重新注册。迁移数据保全校验（`verify-migrations` / `verify-0006`）已在 beta 中删除。
- `db/schema.sql` 应与顺序应用全部 migrations 的最终结构一致；不要反过来修改已发布迁移。
