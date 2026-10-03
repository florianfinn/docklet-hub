import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";

import { planMigrations, type AppliedMigration, type AvailableMigration } from "./migration-plan.js";

// Das Ausführen der Migrationen. Die Entscheidung, WAS läuft, steht in
// migration-plan.ts und ist dort ohne Datenbank geprüft; hier steht nur noch,
// wie es an Postgres kommt.
//
// Läuft beim Start des Servers, nicht von Hand (AGENTS.md, „Datenbank"). Ein
// fremder Betreiber soll nichts anwenden müssen, wovon er nichts weiß — er
// startet den Stack, und das Schema ist da.

// Der Ort der Migrationen, aufgelöst relativ zu diesem Modul. Damit findet der
// Server sie in der Arbeitskopie (src/platform/db/migrations) wie im Image
// (dist/platform/db/migrations) über denselben Ausdruck; das Dockerfile kopiert die
// .sql-Dateien mit, weil tsc nur TypeScript übersetzt.
const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);

// Ein frei gewählter, fester Schlüssel für `pg_advisory_lock`. Er muss über
// alle Hub-Instanzen derselbe sein und darf sich nie ändern — sonst sperren
// zwei Fassungen des Hubs gegeneinander nicht mehr.
//
// Ohne diese Sperre ist der Fehlerfall nicht theoretisch: `docker compose up`
// mit mehreren Hub-Repliken startet sie gleichzeitig, beide sehen dieselbe
// leere Migrationstabelle und wenden dieselbe Migration an. Die zweite
// scheitert dann mitten im Schema — mit einer Meldung über eine bereits
// existierende Tabelle, die niemand mit „Wettlauf beim Start" übersetzt.
const LOCK_KEY = 8_147_231_905_662_004n;

const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   text        PRIMARY KEY,
    checksum   text        NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;

export type MigrationResult = {
  applied: string[];
  alreadyApplied: number;
};

function checksum(content: string): string {
  // Zeilenenden vereinheitlichen, bevor gehasht wird. Sonst meldet dieselbe
  // Datei nach einem Auschecken unter Windows eine Abweichung und hält einen
  // Start an, an dem nichts falsch ist. (`.gitattributes` regelt das im Repo,
  // aber die Prüfsumme soll nicht davon abhängen.)
  return createHash("sha256").update(content.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

async function readAvailable(): Promise<Map<string, { entry: AvailableMigration; sql: string }>> {
  const names = (await readdir(fileURLToPath(MIGRATIONS_DIR))).filter((name) => name.endsWith(".sql")).sort();
  const result = new Map<string, { entry: AvailableMigration; sql: string }>();
  for (const filename of names) {
    const sql = await readFile(fileURLToPath(new URL(filename, MIGRATIONS_DIR)), "utf8");
    result.set(filename, { entry: { filename, checksum: checksum(sql) }, sql });
  }
  return result;
}

async function readApplied(client: PoolClient): Promise<AppliedMigration[]> {
  const { rows } = await client.query<{ filename: string; checksum: string }>(
    "SELECT filename, checksum FROM schema_migrations"
  );
  return rows;
}

/**
 * Wendet alle ausstehenden Migrationen an. Gibt zurück, was gelaufen ist —
 * die Zahl gehört ins Startlog und in /health, damit „das Schema ist aktuell"
 * eine Beobachtung ist und keine Annahme.
 */
export async function runMigrations(client: PoolClient): Promise<MigrationResult> {
  // Die Sperre liegt VOR dem Anlegen der Tabelle: zwei gleichzeitig startende
  // Hubs würden sonst schon an dieser Stelle konkurrieren.
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY.toString()]);
  try {
    await client.query(TABLE_DDL);

    const available = await readAvailable();
    const applied = await readApplied(client);
    const pending = planMigrations(
      [...available.values()].map((item) => item.entry),
      applied
    );

    const done: string[] = [];
    for (const migration of pending) {
      const file = available.get(migration.filename);
      // Kann nach dem Plan nicht eintreten — steht als Zusicherung da, damit
      // ein späterer Umbau des Plans hier auffällt statt `undefined` auszuführen.
      if (!file) throw new Error(`Migration „${migration.filename}" fehlt nach dem Planen.`);

      // Je Migration eine Transaktion: Postgres kann DDL zurückrollen. Eine in
      // der Mitte gescheiterte Migration hinterlässt damit keinen halben
      // Zustand, den niemand mehr einordnen kann.
      await client.query("BEGIN");
      try {
        await client.query(file.sql);
        await client.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)", [
          migration.filename,
          migration.checksum
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(
          `Migration „${migration.filename}" ist gescheitert und wurde zurückgerollt: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error }
        );
      }
      done.push(migration.filename);
    }

    return { applied: done, alreadyApplied: applied.length };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY.toString()]);
  }
}
