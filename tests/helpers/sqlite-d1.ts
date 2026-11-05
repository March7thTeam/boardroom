type SqlValue = string | number | bigint | null | Uint8Array;
type Row = Record<string, SqlValue>;
interface Statement {
  run(...values: SqlValue[]): { changes: number | bigint };
  get(...values: SqlValue[]): Row | undefined;
  all(...values: SqlValue[]): Row[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

/** Node 24 CI builtin; no Node globals/types leak into the Worker project. */
export function builtin<T>(name: string): T {
  return (globalThis as unknown as { process: { getBuiltinModule(name: string): unknown } })
    .process.getBuiltinModule(name) as T;
}
const { DatabaseSync } = builtin<{ DatabaseSync: new (path: string) => SqliteDatabase }>("node:sqlite");

/** Real SQLite constraints and atomic batches; only the D1 API is adapted. */
export class SqliteD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  afterAll?: (sql: string, rows: Row[]) => Promise<void>;
  beforeBatch?: () => Promise<void>;

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this, sql);
  }

  async batch(statements: SqliteStatement[]) {
    await this.beforeBatch?.();
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}

class SqliteStatement {
  private values: SqlValue[] = [];

  constructor(private db: SqliteD1, private sql: string) {}

  bind(...values: SqlValue[]): this {
    this.values = values;
    return this;
  }

  private compile() {
    const values: SqlValue[] = [];
    const sql = this.sql.replace(/\?(\d+)/g, (_, index: string) => {
      values.push(this.values[Number(index) - 1]!);
      return "?";
    });
    return { statement: this.db.sqlite.prepare(sql), values };
  }

  runSync() {
    const { statement, values } = this.compile();
    if (/^\s*(?:SELECT|PRAGMA|WITH)\b/i.test(this.sql)) {
      return { success: true, results: statement.all(...values), meta: { changes: 0 } };
    }
    const result = statement.run(...values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  async run() { return this.runSync(); }

  async first<T = Row>(): Promise<T | null> {
    const { statement, values } = this.compile();
    return (statement.get(...values) as T | undefined) ?? null;
  }

  async all<T = Row>(): Promise<{ results: T[]; success: true }> {
    const { statement, values } = this.compile();
    const rows = statement.all(...values);
    await this.db.afterAll?.(this.sql, rows);
    return { results: rows as T[], success: true };
  }
}
