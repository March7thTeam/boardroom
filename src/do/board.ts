import { DurableObject } from "cloudflare:workers";
import type { CardEventRow, Env } from "../types";
import { ZERO_HASH } from "../domain/audit";
import { nowIso } from "../lib/time";
import { type AuthPrincipal } from "../lib/session";
import { publishOutboxEvent, reconcileEvents, authorizedPrincipalIndexes, type EventHead, type OutboxRow } from "../lib/event-store";

interface SseConnection {
  controller: ReadableStreamDefaultController<Uint8Array>;
  principal: AuthPrincipal;
  closed: boolean;
  cleanup: () => void;
}
const encoder = new TextEncoder();

export class BoardDO extends DurableObject<Env> {
  private readonly projectId: string;
  private readonly connections = new Set<SseConnection>();
  private readonly initPromise: Promise<void>;
  private writeChain: Promise<unknown> = Promise.resolve();
  private purged = false;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private heartbeatChecking = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.projectId = ctx.id.name ?? "unknown";
    this.initPromise = ctx.blockConcurrencyWhile(() => this.init());
  }

  private async init(): Promise<void> {
    const sql = this.ctx.storage.sql;
    if (!(await this.env.DB.prepare("SELECT id FROM projects WHERE id = ?1").bind(this.projectId).first())) {
      this.purged = true;
      return;
    }
    sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.cacheHead(await reconcileEvents(this.env.DB, this.projectId));
  }

  private cacheHead(head: EventHead): void {
    this.ctx.storage.sql.exec("INSERT INTO meta(k, v) VALUES ('last_seq', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v", String(head.seq));
    this.ctx.storage.sql.exec("INSERT INTO meta(k, v) VALUES ('last_hash', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v", head.hash);
  }

  private enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(fn, fn);
    this.writeChain = result.catch(() => undefined);
    return result;
  }

  async getSeq(): Promise<number> {
    return this.enqueueWrite(async () => {
      await this.initPromise;
      if (this.purged) return 0;
      await this.drain();
      const head = await reconcileEvents(this.env.DB, this.projectId);
      this.cacheHead(head);
      return head.seq;
    });
  }

  async publish(eventId: string): Promise<{ seq: number }> {
    return this.enqueueWrite(async () => {
      await this.initPromise;
      if (this.purged) throw new Error("project has been deleted");
      const target = await this.env.DB.prepare("SELECT event_id, published_seq FROM event_outbox WHERE event_id = ?1 AND project_id = ?2")
        .bind(eventId, this.projectId).first<{ event_id: string; published_seq: number | null }>();
      if (!target) throw new Error("event is not in this project's outbox");
      if (target.published_seq !== null) return { seq: target.published_seq };
      await this.drain(eventId);
      const published = await this.env.DB.prepare("SELECT published_seq FROM event_outbox WHERE event_id = ?1")
        .bind(eventId).first<{ published_seq: number | null }>();
      if (published?.published_seq == null) throw new Error("event publication is pending");
      return { seq: published.published_seq };
    });
  }

  private async drain(target?: string): Promise<number> {
    if (this.purged) return 0;
    if (!(await this.env.DB.prepare("SELECT id FROM projects WHERE id = ?1").bind(this.projectId).first())) {
      this.purged = true;
      return 0;
    }
    let head = await reconcileEvents(this.env.DB, this.projectId);
    let count = 0;
    for (;;) {
      const rows = await this.env.DB.prepare(`SELECT * FROM event_outbox WHERE project_id = ?1
        AND published_seq IS NULL ORDER BY order_id LIMIT 100`).bind(this.projectId).all<OutboxRow>();
      if (!rows.results.length) break;
      for (const row of rows.results) {
        head = await publishOutboxEvent(this.env.DB, row, head);
        // Local state is a cache. A crash here is recovered from the D1 checkpoint.
        this.cacheHead(head);
        await this.broadcast(this.frame({ t: "event", seq: head.seq,
          e: { card_id: row.card_id, type: row.event_type, payload: JSON.parse(row.payload_json), created_at: row.created_at } }, head.seq));
        count++;
        if (row.event_id === target || (!target && count >= 1000)) return count;
      }
    }
    this.cacheHead(head);
    return count;
  }

  async flushAudit(): Promise<number> {
    return this.enqueueWrite(async () => { await this.initPromise; return this.drain(); });
  }

  async fetch(request: Request): Promise<Response> {
    await this.initPromise;
    if (this.purged) return new Response("not found", { status: 404 });
    const url = new URL(request.url);
    if (url.pathname.endsWith("/events")) return this.enqueueWrite(() => this.handleSse(request, url));
    if (url.pathname.endsWith("/seq")) return Response.json({ seq: await this.getSeq() });
    return new Response("not found", { status: 404 });
  }

  private async handleSse(request: Request, url: URL): Promise<Response> {
    let principal: AuthPrincipal;
    try {
      principal = JSON.parse(request.headers.get("X-Boardroom-Principal") ?? "null") as AuthPrincipal;
      if (!principal || typeof principal.userId !== "string" || !Number.isSafeInteger(principal.authVersion) ||
        !(principal.sessionId === null || typeof principal.sessionId === "string") ||
        !["session", "access", "development"].includes(principal.mode) ||
        (principal.mode === "session" && !principal.sessionId) ||
        (principal.mode === "development" && this.env.ENVIRONMENT !== "development") ||
        (principal.mode === "access" && this.env.AUTH_MODE !== "access")) throw new Error("invalid principal");
    } catch { return new Response("unauthorized", { status: 401 }); }
    if (!((await authorizedPrincipalIndexes(this.env.DB, [principal], this.projectId)).has(0))) return new Response("forbidden", { status: 403 });
    const rawSince = Number(url.searchParams.get("since") ?? "0");
    if (!Number.isSafeInteger(rawSince) || rawSince < 0) return new Response("invalid cursor", { status: 400 });
    const head = await reconcileEvents(this.env.DB, this.projectId);
    const replay = await this.env.DB.prepare(`SELECT * FROM card_events WHERE project_id = ?1 AND seq > ?2
      ORDER BY seq LIMIT 501`).bind(this.projectId, rawSince).all<CardEventRow>();
    if (!((await authorizedPrincipalIndexes(this.env.DB, [principal], this.projectId)).has(0))) return new Response("forbidden", { status: 403 });
    let active: SseConnection | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const connection: SseConnection = { controller, principal, closed: false, cleanup: () => {} };
        const cleanup = () => {
          if (connection.closed) return;
          connection.closed = true;
          request.signal.removeEventListener("abort", cleanup);
          this.connections.delete(connection);
          if (this.connections.size === 0 && this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
          }
          try { controller.close(); } catch { /* Client already cancelled. */ }
        };
        connection.cleanup = cleanup;
        active = connection;
        if (request.signal.aborted) { cleanup(); return; }
        request.signal.addEventListener("abort", cleanup, { once: true });
        this.connections.add(connection);
        const gap = replay.results.length > 500 || rawSince > head.seq ||
          (replay.results.length > 0 && replay.results[0].seq !== rawSince + 1);
        if (gap) controller.enqueue(encoder.encode(this.frame({ t: "resync", from: rawSince, reason: "gap_too_large" })));
        else for (const row of replay.results) controller.enqueue(encoder.encode(this.frame({ t: "event", seq: row.seq,
          e: { card_id: row.card_id, type: row.event_type, payload: JSON.parse(row.payload_json), created_at: row.created_at } }, row.seq)));
        controller.enqueue(encoder.encode(this.frame({ t: "hello", seq: head.seq, project_id: this.projectId, server_time: nowIso() })));
        if (!this.heartbeatTimer) this.heartbeatTimer = setInterval(() => {
          if (this.heartbeatChecking) return;
          this.heartbeatChecking = true;
          void this.broadcast(": ping\n\n").finally(() => { this.heartbeatChecking = false; });
        }, 25_000);
      },
      cancel: () => active?.cleanup(),
    });
    return new Response(stream, { headers: {
      "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform",
      connection: "keep-alive", "x-accel-buffering": "no",
    } });
  }

  private frame(data: unknown, id?: number): string {
    return `${id === undefined ? "" : `id: ${id}\n`}event: message\ndata: ${JSON.stringify(data)}\n\n`;
  }

  /** Revalidate one batch of distinct principals, including individual sessions. */
  private async broadcast(frame: string): Promise<void> {
    const connections = [...this.connections].filter((connection) => !connection.closed);
    if (!connections.length) return;
    const keys = new Map<string, number>();
    const principals: AuthPrincipal[] = [];
    const indexes = connections.map((connection) => {
      const key = JSON.stringify(connection.principal);
      if (!keys.has(key)) { keys.set(key, principals.length); principals.push(connection.principal); }
      return keys.get(key)!;
    });
    try {
      const allowed = await authorizedPrincipalIndexes(this.env.DB, principals, this.projectId);
      const bytes = encoder.encode(frame);
      connections.forEach((connection, i) => {
        if (!allowed.has(indexes[i]!)) connection.cleanup();
        else if (!connection.closed) {
          try { connection.controller.enqueue(bytes); } catch { connection.cleanup(); }
        }
      });
    } catch { for (const connection of connections) connection.cleanup(); }
  }

  async closeConnections(): Promise<number> {
    return this.enqueueWrite(async () => {
      const count = this.connections.size;
      for (const connection of [...this.connections]) connection.cleanup();
      return count;
    });
  }

  async purgeProject(): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.initPromise.catch(() => undefined);
      this.purged = true;
      for (const connection of [...this.connections]) connection.cleanup();
      const sql = this.ctx.storage.sql;
      sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
      // Tables from earlier versions are disposable; drop them if present.
      sql.exec("DROP TABLE IF EXISTS events");
      sql.exec("DROP TABLE IF EXISTS audit_buffer");
      this.cacheHead({ seq: 0, hash: ZERO_HASH });
    });
  }
}
