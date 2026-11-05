import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../context";
import { newId } from "../lib/ids";

export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = c.req.header("X-Request-Id") ?? newId("req");
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await next();
};
