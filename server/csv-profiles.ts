import { db, ensureSchema } from "./db.ts";
import type { CsvColumnMapping } from "./ingestion.ts";

export interface CsvMappingProfile {
  id: string;
  name: string;
  mapping: CsvColumnMapping;
  createdAt: string;
  updatedAt: string;
}

export async function listCsvMappingProfiles(): Promise<CsvMappingProfile[]> {
  await ensureSchema();
  const result = await db.execute("SELECT * FROM csv_mapping_profiles ORDER BY name COLLATE NOCASE");
  return result.rows.map((row) => ({
    id: String(row.id), name: String(row.name), mapping: JSON.parse(String(row.mapping_json)) as CsvColumnMapping,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }));
}

export async function saveCsvMappingProfile(name: string, mapping: CsvColumnMapping, id?: string): Promise<string> {
  await ensureSchema();
  const now = new Date().toISOString();
  if (id) {
    const result = await db.execute({ sql: "UPDATE csv_mapping_profiles SET name = ?, mapping_json = ?, updated_at = ? WHERE id = ?", args: [name, JSON.stringify(mapping), now, id] });
    if (!result.rowsAffected) throw new Error("CSV profile not found");
    return id;
  }
  const createdId = crypto.randomUUID();
  await db.execute({ sql: "INSERT INTO csv_mapping_profiles (id, name, mapping_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", args: [createdId, name, JSON.stringify(mapping), now, now] });
  return createdId;
}

export async function deleteCsvMappingProfile(id: string): Promise<void> {
  await ensureSchema();
  await db.execute({ sql: "DELETE FROM csv_mapping_profiles WHERE id = ?", args: [id] });
}
