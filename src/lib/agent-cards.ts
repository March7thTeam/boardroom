import { z } from "zod";
import type { CardRow } from "../types";
import { parseLimit } from "./http";
import { HttpError } from "./http-error";

const statusSchema = z.enum(["open", "engaged", "running", "review", "closed"]);
const cursorSchema = z.object({
  updated_at: z.string().datetime(), id: z.string().min(1).max(200),
  projects: z.array(z.string().min(1)),
  since: z.string().datetime().nullable(), status: statusSchema.nullable(), order: z.literal("updated"),
}).strict();

export async function listAgentCards(db: D1Database, projectIds: string[], query: {
  status?: string; since?: string; limit?: string; cursor?: string; order?: string;
}) {
  const status = query.status === undefined ? null : statusSchema.safeParse(query.status);
  if (status && !status.success) throw new HttpError(400, "INVALID_ARGUMENT", "invalid card status");
  const filterStatus = status?.data ?? null;
  const sinceValue = query.since === undefined ? null : z.string().datetime().safeParse(query.since);
  if (sinceValue && !sinceValue.success) throw new HttpError(400, "INVALID_ARGUMENT", "invalid since timestamp");
  const since = sinceValue?.data ? new Date(sinceValue.data).toISOString() : null;
  if (query.order !== undefined && query.order !== "updated") throw new HttpError(400, "INVALID_ARGUMENT", "invalid card order");
  const updatedOrder = query.order === "updated" || query.since !== undefined || query.cursor !== undefined;
  const limit = parseLimit(query.limit, 100, 200);
  const projects = [...new Set(projectIds)].sort();
  const filters = [`project_id IN (${projects.map((_, i) => `?${i + 1}`).join(",")})`];
  const bindings: unknown[] = [...projects];
  if (filterStatus) { filters.push(`status = ?${bindings.length + 1}`); bindings.push(filterStatus); }
  if (since) { filters.push(`updated_at > ?${bindings.length + 1}`); bindings.push(since); }
  if (query.cursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]{1,2048}$/.test(query.cursor)) throw new Error("invalid encoding");
      const base64 = query.cursor.replace(/-/g, "+").replace(/_/g, "/");
      const cursor = cursorSchema.parse(JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))));
      if (cursor.since !== since || cursor.status !== filterStatus || JSON.stringify(cursor.projects) !== JSON.stringify(projects)) throw new Error("cursor filters differ");
      filters.push(`(updated_at > ?${bindings.length + 1} OR (updated_at = ?${bindings.length + 1} AND id > ?${bindings.length + 2}))`);
      bindings.push(new Date(cursor.updated_at).toISOString(), cursor.id);
    } catch { throw new HttpError(400, "INVALID_ARGUMENT", "invalid cursor or cursor filters"); }
  }
  bindings.push(limit + 1);
  const rows = await db.prepare(`SELECT * FROM cards WHERE ${filters.join(" AND ")}
    ORDER BY ${updatedOrder ? "updated_at ASC, id ASC" : "priority DESC, updated_at DESC, id DESC"}
    LIMIT ?${bindings.length}`).bind(...bindings).all<CardRow>();
  const hasMore = rows.results.length > limit;
  const cards = rows.results.slice(0, limit);
  const last = cards.at(-1);
  const cursor = hasMore && updatedOrder && last ? btoa(JSON.stringify({
    updated_at: last.updated_at, id: last.id, projects, since, status: filterStatus, order: "updated",
  })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : null;
  return { cards, next_cursor: cursor, has_more: hasMore };
}
