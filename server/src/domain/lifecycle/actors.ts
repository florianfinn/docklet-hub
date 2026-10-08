import type { Pool } from "pg";

export type ReadActorNames = (ids: string[]) => Promise<Map<string, string>>;
// Read names only; account email addresses are never used as display names.
export async function readLifecycleActorNames(pool: Pool, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { rows } = await pool.query<{ id: string; name: string }>(
    'SELECT "id", "name" FROM "user" WHERE "id" = ANY($1::text[])', [ids]);
  return new Map(rows.map((row) => [row.id, row.name]));
}
export function actorName(actor: string | null, names: Map<string, string>): string | null {
  if (!actor?.startsWith("user:")) return null;
  const name = names.get(actor.slice(5))?.replace(/\S+@\S+/g, "").trim();
  return name || null;
}
