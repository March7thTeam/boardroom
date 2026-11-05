import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../src/context";
import { createSession, readSession } from "../../src/lib/session";
import type { UserRow } from "../../src/types";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-11-01T00:00:00.000Z");
const user: UserRow = {
  id: "usr_session_test",
  email: "session@example.test",
  display_name: "Session test",
  role: "member",
  status: "active",
  password_hash: null,
  password_updated_at: null,
  must_change_password: 0,
  auth_version: 1,
  last_seen_at: null,
  created_at: new Date(START).toISOString(),
};

function harness(options: {
  changes?: number;
  failRefresh?: boolean;
  missing?: boolean;
  beforeRefresh?: () => Promise<void>;
} = {}) {
  const writes: { sql: string; values: unknown[] }[] = [];
  const pending: Promise<unknown>[] = [];
  const row = {
    ...user,
    session_id: "ses_session_test",
    session_expires_at: new Date(START + 7 * DAY_MS).toISOString(),
    session_last_seen_at: new Date(START).toISOString(),
  };
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...args: unknown[]) { values = args; return this; },
        async first() { return options.missing ? null : row; },
        async run() {
          writes.push({ sql, values });
          if (sql.startsWith("UPDATE user_sessions")) await options.beforeRefresh?.();
          if (options.failRefresh && sql.startsWith("UPDATE user_sessions")) {
            throw new Error("test refresh failure");
          }
          return { meta: { changes: options.changes ?? 1 } };
        },
      };
    },
  };
  const env = { DB: db, TOKEN_PEPPER: "session-test-pepper" } as unknown as AppEnv["Bindings"];
  const ctx = {
    waitUntil(promise: Promise<unknown>) { pending.push(promise); },
    passThroughOnException() {},
  } as ExecutionContext;
  const app = new Hono<AppEnv>();
  app.get("/start", async (c) => { await createSession(c, user); return c.json({ ok: true }); });
  app.get("/me", async (c) => c.json({ authenticated: Boolean(await readSession(c)) }));
  return {
    writes,
    pending,
    request(path: string, cookie?: string, protocol = "https") {
      return app.fetch(new Request(`${protocol}://example.test${path}`, {
        headers: cookie ? { Cookie: cookie } : {},
      }), env, ctx);
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("sliding session cookies", () => {
  it("renews the browser cookie with the same token after the hourly database refresh", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
    const h = harness();
    const initial = await h.request("/start");
    const initialCookie = initial.headers.get("set-cookie")!;
    const cookie = initialCookie.split(";")[0];
    vi.setSystemTime(START + DAY_MS);

    const response = await h.request("/me", cookie);
    await Promise.all(h.pending);
    const refreshed = response.headers.get("set-cookie");
    expect(await response.json()).toEqual({ authenticated: true });
    expect(refreshed === initialCookie).toBe(true);
    expect(refreshed).toContain("Max-Age=604800");
    expect(refreshed).toContain("HttpOnly");
    expect(refreshed).toContain("Secure");
    expect(refreshed).toContain("SameSite=Lax");
    expect(refreshed).toContain("Path=/");
    const refresh = h.writes.find((entry) => entry.sql.startsWith("UPDATE user_sessions"));
    expect(refresh?.values[1]).toBe(new Date(START + 8 * DAY_MS).toISOString());
    expect(refresh?.sql).toContain("revoked_at IS NULL");
  });

  it("waits for database renewal before returning a renewed HTTP cookie", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START + DAY_MS);
    let notifyStarted!: () => void;
    let releaseRefresh!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const h = harness({ beforeRefresh: async () => { notifyStarted(); await gate; } });
    let returned = false;
    const request = Promise.resolve(h.request("/me", "boardroom_session=test-token", "http")).then((response) => {
      returned = true;
      return response;
    });
    await started;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(returned).toBe(false);
    releaseRefresh();
    const response = await request;
    expect(response.headers.get("set-cookie")).toContain("boardroom_session=test-token;");
    expect(response.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("keeps the hourly refresh throttle", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START + 30 * 60 * 1000);
    const h = harness();
    const response = await h.request("/me", "boardroom_session=test-token");
    expect(await response.json()).toEqual({ authenticated: true });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(h.writes).toHaveLength(0);
  });

  it.each([{ changes: 0 }, { failRefresh: true }])("does not renew the cookie when database refresh fails: %j", async (options) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START + DAY_MS);
    const h = harness(options);
    const response = await h.request("/me", "boardroom_session=test-token", "http");
    await Promise.all(h.pending);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("clears an invalid or revoked session without renewing it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START + DAY_MS);
    const h = harness({ missing: true });
    const response = await h.request("/me", "boardroom_session=test-token");
    expect(await response.json()).toEqual({ authenticated: false });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(h.writes).toHaveLength(0);
  });
});
