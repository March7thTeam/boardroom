import { Hono } from "hono";
import type { AppEnv } from "../context";

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get("/health", async (c) => {
  let d1 = "ok";
  try {
    await c.env.DB.prepare("SELECT 1 AS ok").first();
  } catch {
    d1 = "error";
  }
  return c.json({
    ok: d1 === "ok",
    d1,
    do: c.env.BOARD_DO ? "ok" : "missing",
    environment: c.env.ENVIRONMENT,
    version: "0.2.0",
  });
});
