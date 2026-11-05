import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody } from "../lib/http";
import { nowIso } from "../lib/time";
import { requireAdmin, requireUser } from "../middleware/identity";
import { appBaseUrl, emailStatus, sendAndLogEmail } from "../providers/email";

export const adminRoutes = new Hono<AppEnv>();

const testEmailSchema = z.object({
  to: z.string().email().optional(),
});

adminRoutes.get("/admin/overview", requireUser, requireAdmin, async (c) => {
  const [users, activeUsers, projects, cards, sessions] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE status = 'active'").first<{
      count: number;
    }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM projects WHERE archived_at IS NULL").first<{
      count: number;
    }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM cards").first<{ count: number }>(),
    c.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM user_sessions WHERE revoked_at IS NULL AND expires_at > ?1",
    )
      .bind(nowIso())
      .first<{ count: number }>(),
  ]);

  return c.json({
    users: users?.count ?? 0,
    active_users: activeUsers?.count ?? 0,
    projects: projects?.count ?? 0,
    cards: cards?.count ?? 0,
    active_sessions: sessions?.count ?? 0,
  });
});

adminRoutes.get("/admin/email/status", requireUser, requireAdmin, async (c) => {
  return c.json(emailStatus(c.env));
});

adminRoutes.post("/admin/email/test", requireUser, requireAdmin, async (c) => {
  const actor = c.get("user");
  const body = await parseBody(c, testEmailSchema);
  const to = body.to ?? actor.email;
  const result = await sendAndLogEmail(
    c.env,
    {
      to,
      subject: "Boardroom SMTP test",
      text: [
        "This is a test email from Boardroom.",
        "",
        `Instance: ${appBaseUrl(c.env, c.req.url)}`,
        `Time: ${nowIso()}`,
      ].join("\n"),
    },
    actor.id,
  );
  return c.json({ to, ...result });
});

adminRoutes.get("/admin/email/log", requireUser, requireAdmin, async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 500);
  const status = c.req.query("status");
  const filters: string[] = [];
  const bindings: unknown[] = [];
  if (status === "sent" || status === "failed" || status === "skipped") {
    filters.push(`status = ?${bindings.length + 1}`);
    bindings.push(status);
  }
  bindings.push(limit);
  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = await c.env.DB.prepare(
    `SELECT id, user_id, to_email, subject, provider, status, error, created_at, sent_at
       FROM email_log ${where}
      ORDER BY created_at DESC
      LIMIT ?${bindings.length}`,
  )
    .bind(...bindings)
    .all();
  return c.json({ emails: rows.results });
});
