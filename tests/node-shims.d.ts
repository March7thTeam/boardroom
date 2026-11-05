// Minimal Node typings for tests that run real SQL through Node's built-in
// SQLite. The project compiles against Workers types only and does not ship
// @types/node; declare just what the tests use.
declare module "node:fs" {
  export function readFileSync(path: URL | string, encoding: "utf8"): string;
}

declare module "node:module" {
  export function createRequire(from: string | URL): (id: string) => unknown;
}

declare module "node:sqlite" {
  export interface StatementSync {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

interface ImportMeta {
  readonly url: string;
}
