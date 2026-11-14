import { Hono } from "hono";
import type { AppEnv } from "./context";
import { DEFAULT_LOCALE, getTranslator, translateErrorCode } from "./i18n";
import { sweepProject } from "./domain/timeouts";
import { HttpError } from "./lib/http-error";
import { resolveLocale } from "./middleware/locale";
import { requestId } from "./middleware/request-id";
import { agentApiRoutes } from "./routes/agent-api";
import { agentMemoryRoutes } from "./routes/agent-memory";
import { agentRoutes } from "./routes/agents";
import { adminRoutes } from "./routes/admin";
import { auditRoutes } from "./routes/audit";
import { authRoutes } from "./routes/auth";
import { cardRoutes } from "./routes/cards";
import { eventRoutes } from "./routes/events";
import { healthRoutes } from "./routes/health";
import { languageRoutes, localeRoutes } from "./routes/locale";
import { meRoutes } from "./routes/me";
import { memoryRoutes } from "./routes/memory";
import { projectJoinRoutes } from "./routes/project-join";
import { projectRoutes } from "./routes/projects";
import { setupRoutes } from "./routes/setup";
import { userRoutes } from "./routes/users";
import type { Env } from "./types";

const app = new Hono<AppEnv>();

app.use("*", requestId);
app.use("*", resolveLocale);

app.onError((error, c) => {
  const requestIdValue = c.get("requestId") ?? "req_unknown";
  const t = (c.get("t") as ReturnType<typeof getTranslator> | undefined) ?? getTranslator(DEFAULT_LOCALE);

  if (error instanceof HttpError) {
    c.header("X-Request-Id", requestIdValue);
    return c.json(
      {
        error: {
          code: error.code,
          message: translateErrorCode(t, error.code, error.message),
          details: error.details,
          request_id: requestIdValue,
        },
      },
      error.status as never,
    );
  }

  console.error(
    JSON.stringify({
      level: "error",
      request_id: requestIdValue,
      path: c.req.path,
      method: c.req.method,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }),
  );

  c.header("X-Request-Id", requestIdValue);
  return c.json(
    {
      error: {
        code: "INTERNAL",
        message: "internal server error",
        request_id: requestIdValue,
      },
    },
    500,
  );
});

app.route("/api/v1", healthRoutes);
app.route("/api/v1", localeRoutes);
app.route("/api/v1", authRoutes);
app.route("/api/v1", setupRoutes);
app.route("/api/v1", adminRoutes);
app.route("/api/v1", userRoutes);
// Convenience alias for an admin-only client: /api/v1/admin/users...
app.route("/api/v1/admin", userRoutes);
app.route("/api/v1", meRoutes);
app.route("/api/v1", projectRoutes);
app.route("/api/v1", projectJoinRoutes);
app.route("/api/v1", agentRoutes);
app.route("/api/v1", cardRoutes);
app.route("/api/v1", memoryRoutes);
app.route("/api/v1", eventRoutes);
app.route("/api/v1", auditRoutes);
app.route("/agent", agentApiRoutes);
app.route("/agent", agentMemoryRoutes);
app.route("/", languageRoutes);

async function setupNeeded(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  return (row?.count ?? 0) === 0;
}

/** First-run gate: an empty instance always lands on /setup. */
app.get("/", async (c) => {
  try {
    if (await setupNeeded(c.env)) return c.redirect("/setup");
  } catch {
    // Fall through to the SPA; /setup/status will surface the real error.
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

app.get("/setup", async (c) => {
  try {
    if (!(await setupNeeded(c.env))) return c.redirect("/");
  } catch {
    // Fall through to the SPA.
  }
  return c.env.ASSETS.fetch(new Request(new URL("/", c.req.url), { headers: c.req.raw.headers }));
});

app.notFound((c) => {
  if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/agent")) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "resource not found",
          request_id: c.get("requestId") ?? "req_unknown",
        },
      },
      404,
    );
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export { BoardDO } from "./do/board";

const scheduled = async (
  _event: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> => {
  const projects = await env.DB.prepare("SELECT id, archived_at FROM projects").all<{
    id: string;
    archived_at: string | null;
  }>();
  const results = await Promise.allSettled(
    projects.results.map(async (project) => {
      await env.BOARD_DO.getByName(project.id).flushAudit();
      return project.archived_at ? undefined : sweepProject(env, project.id);
    }),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      console.error(
        JSON.stringify({
          level: "error",
          job: "cron_sweep",
          message: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }),
      );
    }
  }
};

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
