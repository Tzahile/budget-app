import { DatabaseSync } from "node:sqlite";

type Statement = string | { sql: string; args: readonly (string | number | null)[] };

let database: DatabaseSync | null = null;

export function useTestSqlite(value: DatabaseSync): void {
  database = value;
  database.exec("PRAGMA foreign_keys = ON");
}

function current(): DatabaseSync {
  if (!database) throw new Error("Test SQLite database has not been installed");
  return database;
}

function normalize(statement: Statement): { sql: string; args: readonly (string | number | null)[] } {
  return typeof statement === "string" ? { sql: statement, args: [] } : statement;
}

function readsRows(sql: string): boolean {
  return /^\s*(SELECT|PRAGMA|EXPLAIN)\b/i.test(sql);
}

/** Minimal compatibility adapter for the Val Town SQLite API. */
export const sqlite = {
  async execute(statement: Statement): Promise<{ rows: Array<Record<string, unknown>>; rowsAffected: number }> {
    const { sql, args } = normalize(statement);
    const prepared = current().prepare(sql);
    if (readsRows(sql)) return { rows: prepared.all(...args) as Array<Record<string, unknown>>, rowsAffected: 0 };
    const result = prepared.run(...args);
    return { rows: [], rowsAffected: Number(result.changes) };
  },

  async batch(statements: readonly Statement[]): Promise<void> {
    const connection = current();
    connection.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) {
        const { sql, args } = normalize(statement);
        connection.prepare(sql).run(...args);
      }
      connection.exec("COMMIT");
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  },
};
