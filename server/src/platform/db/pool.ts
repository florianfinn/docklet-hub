import { Pool } from "pg";

// Der Verbindungspool zu Postgres.
//
// Eigene Datei, weil der Pool ein Prozess-Singleton ist: jede Stelle, die
// stattdessen selbst einen aufmacht, öffnet eine zweite Verbindungsmenge, die
// niemand mitzählt — und Postgres zählt sie sehr wohl.

export function createPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    // Klein gehalten: dieser Hub bedient ein Heimnetz, nicht eine Flotte. Der
    // Vorgabewert von zehn Verbindungen je Instanz ist für den Zweck
    // reichlich, und ein fremder Betreiber fährt Postgres womöglich mit den
    // Standardgrenzen.
    max: 5,
    // Ohne diese Grenze wartet ein Aufruf bei erschöpftem Pool unbegrenzt —
    // die Anfrage hängt dann, statt zu scheitern, und im Log steht nichts.
    connectionTimeoutMillis: 5_000
  });
}

/**
 * Wartet, bis die Datenbank Anfragen beantwortet.
 *
 * Compose startet den Hub erst, wenn Postgres seinen Healthcheck besteht — im
 * mitgelieferten Stack ist diese Schleife also der Rückfall, nicht der
 * Regelweg. Sie trägt trotzdem: nach einem Neustart des Hosts fahren beide
 * Container gleichzeitig hoch, und ein Hub, der genau dann einmal scheitert
 * und in eine Neustartschleife geht, sieht für den Betreiber aus wie ein
 * kaputter Hub statt wie eine langsame Datenbank.
 */
export async function waitForDatabase(
  pool: Pool,
  options: { attempts?: number; delayMs?: number; onRetry?: (attempt: number, error: Error) => void } = {}
): Promise<void> {
  const attempts = options.attempts ?? 30;
  const delayMs = options.delayMs ?? 1_000;

  let lastError: Error = new Error("Datenbank nicht erreichbar");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const client = await pool.connect();
      try {
        await client.query("SELECT 1");
        return;
      } finally {
        client.release();
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      options.onRetry?.(attempt, lastError);
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw new Error(
    `Datenbank nach ${attempts} Versuchen nicht erreichbar: ${lastError.message}. ` +
      `Prüfen: läuft der Dienst „postgres" im selben Compose-Projekt, und stimmt DATABASE_URL?`,
    { cause: lastError }
  );
}
