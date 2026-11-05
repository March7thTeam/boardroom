import { Hono } from "hono";
import type { AppEnv } from "../context";
import { requireUser } from "../middleware/identity";
import { requireProjectMember } from "../middleware/project";

export const eventRoutes = new Hono<AppEnv>();

eventRoutes.get(
  "/projects/:pid/events",
  requireUser,
  requireProjectMember,
  async (c) => {
    const project = c.get("project");
    const since = Number(c.req.header("Last-Event-ID") ?? c.req.query("since") ?? "0") || 0;
    const url = new URL("https://board.internal/events");
    url.searchParams.set("since", String(since));

    const response = await c.env.BOARD_DO.getByName(project.id).fetch(
      new Request(url, {
        headers: { accept: "text/event-stream", "X-Boardroom-Principal": JSON.stringify(c.get("principal")) },
        signal: c.req.raw.signal,
      }),
    );
    return response;
  },
);
