import { Hono } from "hono";
import type { AppEnv } from "../context";
import { verifyProjectAudit } from "../domain/audit";
import { parseLimit } from "../lib/http";
import { requireUser } from "../middleware/identity";
import { requireProjectMember, requireProjectOwner } from "../middleware/project";
import type { AuditRow } from "../types";

export const auditRoutes = new Hono<AppEnv>();

auditRoutes.get(
  "/projects/:pid/audit",
  requireUser,
  requireProjectMember,
  requireProjectOwner,
  async (c) => {
    const project = c.get("project");
    const limit = parseLimit(c.req.query("limit"), 100, 500);
    const filters = ["project_id = ?1"];
    const bindings: unknown[] = [project.id];

    const fromSeq = Number(c.req.query("from_seq") ?? "");
    if (Number.isInteger(fromSeq) && fromSeq > 0) {
      filters.push(`seq >= ?${bindings.length + 1}`);
      bindings.push(fromSeq);
    }
    const toSeq = Number(c.req.query("to_seq") ?? "");
    if (Number.isInteger(toSeq) && toSeq > 0) {
      filters.push(`seq <= ?${bindings.length + 1}`);
      bindings.push(toSeq);
    }
    const cardId = c.req.query("card_id");
    if (cardId) {
      filters.push(`card_id = ?${bindings.length + 1}`);
      bindings.push(cardId);
    }
    const actor = c.req.query("actor");
    if (actor) {
      filters.push(`actor_id = ?${bindings.length + 1}`);
      bindings.push(actor);
    }
    bindings.push(limit);

    const rows = await c.env.DB.prepare(
      `SELECT * FROM audit_log WHERE ${filters.join(" AND ")} ORDER BY seq ASC LIMIT ?${bindings.length}`,
    )
      .bind(...bindings)
      .all<AuditRow>();
    return c.json({ entries: rows.results });
  },
);

auditRoutes.get(
  "/projects/:pid/audit/verify",
  requireUser,
  requireProjectMember,
  requireProjectOwner,
  async (c) => {
    const project = c.get("project");
    const result = await verifyProjectAudit(c.env.DB, project.id);
    return c.json(result);
  },
);

auditRoutes.post(
  "/projects/:pid/audit/flush",
  requireUser,
  requireProjectMember,
  requireProjectOwner,
  async (c) => {
    const project = c.get("project");
    const flushed = await c.env.BOARD_DO.getByName(project.id).flushAudit();
    return c.json({ flushed });
  },
);
