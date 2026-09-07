/**
 * TASK-MOB-005 — minimal async SQLite surface shared by expo-sqlite (device)
 * and better-sqlite3 (Jest contract tests). Structural subset of
 * expo-sqlite's SQLiteDatabase so the adapter runs unchanged in both.
 */
export interface MobileSqliteDatabase {
  getAllAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  getFirstAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  runAsync(sql: string, params?: unknown[]): Promise<unknown>;
  execAsync(sql: string): Promise<void>;
  /** wraps expo-sqlite's withTransactionAsync (returns the task result) */
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;
}

/** adapter so expo-sqlite's withTransactionAsync (void) fits the <T> surface */
function withResult<T>(db: { withTransactionAsync(task: () => Promise<void>): Promise<void> }, fn: () => Promise<T>): Promise<T> {
  let result: T;
  return db.withTransactionAsync(async () => {
    result = await fn();
  }).then(() => result);
}

export async function openMobileDb(): Promise<MobileSqliteDatabase> {
  const sqlite = await import('expo-sqlite');
  const db = await sqlite.openDatabaseAsync('banana-chat.db');
  return {
    getAllAsync: (sql, params) => db.getAllAsync(sql, (params ?? []) as never[]),
    getFirstAsync: (sql, params) => db.getFirstAsync(sql, (params ?? []) as never[]),
    runAsync: (sql, params) => db.runAsync(sql, (params ?? []) as never[]),
    execAsync: (sql) => db.execAsync(sql),
    withTransaction: <T>(fn: () => Promise<T>) => withResult(db, fn),
  };
}
