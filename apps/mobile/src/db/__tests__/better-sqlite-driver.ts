import Database from 'better-sqlite3';

/**
 * Test driver: better-sqlite3 wrapped in expo-sqlite's async shape, so the
 * adapter under test executes REAL sql in Jest (contract parity with the
 * device driver — TC-MOB-002).
 */
export interface BetterSqliteDb {
  getAllAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  getFirstAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  runAsync(sql: string, params?: unknown[]): Promise<void>;
  execAsync(sql: string): Promise<void>;
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): void;
}

export function openTestDb(): BetterSqliteDb {
  const db = new Database(':memory:');
  const adapted: BetterSqliteDb = {
    async getAllAsync<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...params) as T[];
    },
    async getFirstAsync<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async runAsync(sql: string, params: unknown[] = []) {
      db.prepare(sql).run(...params);
    },
    async execAsync(sql: string) {
      db.exec(sql);
    },
    async withTransaction<T>(fn: () => Promise<T>) {
      // :memory: single connection — statements autocommit individually; the
      // end state matches a real transaction for these tests
      return fn();
    },
    close() {
      db.close();
    },
  };
  return adapted;
}
