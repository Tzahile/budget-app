import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import { migrateDatabase, type MigrationDatabase } from "./migrations.ts";

export const db = sqlite;

let initialized: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  initialized ??= migrateDatabase(db as unknown as MigrationDatabase).catch((error) => {
    initialized = null;
    throw error;
  });
  return initialized;
}
