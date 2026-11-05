import type { Context } from "hono";
import { z, type ZodTypeAny } from "zod";
import type { AppEnv } from "../context";
import { HttpError } from "./http-error";

export async function parseBody<S extends ZodTypeAny>(
  c: Context<AppEnv>,
  schema: S,
): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "INVALID_ARGUMENT", "request body must be valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, "INVALID_ARGUMENT", "request body validation failed", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

export function parseIfMatch(c: Context<AppEnv>): number {
  const raw = c.req.header("If-Match");
  if (!raw) throw new HttpError(428, "PRECONDITION_REQUIRED", "If-Match header is required");
  const value = Number(raw.trim().replace(/^W\//, "").replace(/^"|"$/g, ""));
  if (!Number.isInteger(value) || value < 1) {
    throw new HttpError(400, "INVALID_ARGUMENT", "If-Match must be a card version");
  }
  return value;
}

export function requestIdOf(c: Context<AppEnv>): string {
  return c.get("requestId") ?? "req_unknown";
}

export function parseLimit(raw: string | undefined, fallback = 50, max = 200): number {
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
}
