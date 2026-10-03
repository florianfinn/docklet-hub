import type { Pool } from "pg";

// Der Weg zur Tabelle `hub_network` — und sonst nichts. Muster und Begründungen
// wie in `features/appearance/store.ts` (moved here from `hosts/` with #266: the hosts feature and the settings both read it); hier steht nur, was anders ist.

/**
 * Was der Hub über seine eigene Erreichbarkeit weiß.
 *
 * ⚠️ `null` ist ein ECHTER Zustand und kein fehlender Wert: ein Hub ohne
 * externen Arm braucht die Adresse nicht. Ein Vorgabewert an dieser Stelle wäre
 * eine erfundene Adresse, die beim ersten externen Arm stillschweigend in
 * dessen Paket geriete — und das Paket gibt es genau einmal.
 */
export type HubNetwork = { externalEndpoint: string | null };

export const NO_HUB_NETWORK: HubNetwork = { externalEndpoint: null };

type NetworkRow = { external_endpoint: string | null };

/**
 * Prüft eine Adresse für die Zeile `Endpoint = …` einer `wg0.conf`.
 *
 * ⚠️ Der Wert wird dort UNMASKIERT eingesetzt. Ein Leerzeichen ergibt eine
 * zweite Angabe, ein `/` einen Pfad, den WireGuard nicht kennt — und beides
 * fällt erst auf dem fremden Host auf, mit einer Meldung über die
 * Konfigurationsdatei statt über dieses Feld. Der `CHECK` in 009 sagt dasselbe
 * noch einmal; er ist die zweite Hälfte der Zusage und nicht ihre einzige,
 * denn eine verletzte Bedingung wäre eine 500 statt einer Antwort, die dem
 * Aufrufer sagt, was er falsch gemacht hat.
 *
 * Eine leere Eingabe ist gültig und bedeutet „wieder herausnehmen".
 */
export function normalizeExternalEndpoint(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const candidate = value.trim();
  if (candidate === "") return { ok: true, value: null };
  if (/[\s/]/.test(candidate)) return { ok: false };
  return { ok: true, value: candidate };
}

export async function readHubNetwork(pool: Pool): Promise<HubNetwork> {
  const { rows } = await pool.query<NetworkRow>("SELECT external_endpoint FROM hub_network WHERE singleton");
  return rows[0] ? { externalEndpoint: rows[0].external_endpoint } : NO_HUB_NETWORK;
}

/**
 * Schreibt die Adresse und meldet den Stand zurück.
 *
 * Eine Anweisung mit `ON CONFLICT`, aus denselben zwei Gründen wie beim Thema:
 * sie deckt „Zeile da" und „Zeile von Hand gelöscht" ab, und der gemeldete
 * Stand kommt aus `RETURNING` statt aus einem zweiten Lesen.
 */
export async function writeHubNetwork(pool: Pool, network: HubNetwork): Promise<HubNetwork> {
  const { rows } = await pool.query<NetworkRow>(
    `INSERT INTO hub_network (external_endpoint, singleton)
     VALUES ($1, true)
     ON CONFLICT (singleton) DO UPDATE
        SET external_endpoint = EXCLUDED.external_endpoint,
            updated_at = now()
     RETURNING external_endpoint`,
    [network.externalEndpoint]
  );
  return { externalEndpoint: rows[0].external_endpoint };
}
