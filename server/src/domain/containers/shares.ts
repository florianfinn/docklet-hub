import type { Pool } from "pg";

import type { ContainerShare } from "contract";

// The way to the table `container_share`, and nothing else. Pattern and
// reasons as in `features/logs/store.ts` and `domain/hosts/hub-network-store.ts`;
// only what differs is here.
//
// ⚠️ JE (ARM, CONTAINERNAME) UND NICHT JE CONTAINER-ID (011-container-shares.sql,
// Entscheidung des Leitstands). Jede Funktion hier nimmt deshalb `hostId` UND
// `containerName` entgegen, nie eine Container-Id — die Auflösung zur Id des
// Augenblicks geschieht erst beim Registry-Abgleich (`registry-sync.ts`), weil
// nur dort der aktuelle Bestand des Arms bekannt ist.

// The chosen share of a container: a shape of the contract
// (`contract/src/api/files.ts`, #248) — the web reads it from `GET`/`PUT …/share`.
export type { ContainerShare };

type ShareRow = { container_name: string; share_path: string };

/**
 * Prüft einen Freigabepfad — dieselbe Bedingung wie beim Agenten
 * (`src/registry.ts:318-330`, v0.19.1): fehlend heißt „keine", vorhanden muss
 * ein nicht leerer Text sein.
 *
 * ⚠️ Ein leerer Pfad ist die gefährlichste Form: er sähe aus wie eine Angabe
 * und bedeutete beim Agenten „das ganze Projektverzeichnis". Er wird deshalb
 * hier abgelehnt und nicht erst auf der Leitung zum Arm — ein Formfehler, der
 * diese Ablage erreicht, kostet den Container sonst irgendwann seinen ganzen
 * Platz in dessen Allowlist (`registry-sync.ts`), ohne dass eine Quittung
 * das je nennt.
 *
 * ⚠️ STRIKTE Typprüfung, keine Umwandlung — dieselbe Haltung wie bei
 * `normalizeExternalEndpoint` und `normalizeLogTailLines`: ein Aufrufer, der
 * keinen Text schickt, meint keinen Text.
 */
export function normalizeSharePath(value: unknown): { ok: true; value: string } | { ok: false } {
  if (typeof value !== "string") return { ok: false };
  if (value.length === 0) return { ok: false };
  return { ok: true, value };
}

/**
 * Alle gewählten Freigaben eines Arms, nach Containername sortiert.
 *
 * Für den Registry-Abgleich (`registry-sync.ts`, Baustein 3) — der ordnet sie
 * einem frischen Bestand über den Namen zu, nicht über die Id.
 */
export async function readShares(pool: Pool, hostId: string): Promise<ContainerShare[]> {
  const { rows } = await pool.query<ShareRow>(
    "SELECT container_name, share_path FROM container_share WHERE host_id = $1 ORDER BY container_name",
    [hostId]
  );
  return rows.map((row) => ({ containerName: row.container_name, path: row.share_path }));
}

/** Die gewählte Freigabe eines einzelnen Containers, oder `null` ohne eine. */
export async function readShare(pool: Pool, hostId: string, containerName: string): Promise<string | null> {
  const { rows } = await pool.query<ShareRow>(
    "SELECT container_name, share_path FROM container_share WHERE host_id = $1 AND container_name = $2",
    [hostId, containerName]
  );
  return rows[0]?.share_path ?? null;
}

/**
 * Setzt die Freigabe eines Containers — oder lehnt sie ab.
 *
 * ⚠️ EIN LEERER PFAD WIRD ABGELEHNT UND NICHT GESPEICHERT. Diese Funktion
 * prüft `path` selbst über `normalizeSharePath`, statt sich auf einen
 * Aufrufer zu verlassen, der schon geprüft hat — anders als bei
 * `writeHubNetwork`, das seinem Aufrufer vertraut. Der Unterschied ist
 * Absicht: der `CHECK` in 011 fängt einen Formfehler erst an der Datenbank
 * ab, mit einer 500 statt einer Antwort, die dem Aufrufer sagt, was er falsch
 * gemacht hat — diese Funktion ist die Stelle, die stattdessen klar
 * ablehnt.
 *
 * Eine Anweisung mit `ON CONFLICT`, aus demselben Grund wie bei `hub_network`
 * und `log_settings`: sie deckt „Zeile da" und „Zeile von Hand gelöscht" ab,
 * und der gemeldete Stand kommt aus `RETURNING` statt aus einem zweiten
 * Lesen.
 */
export async function setShare(pool: Pool, hostId: string, containerName: string, path: string): Promise<ContainerShare> {
  const normalized = normalizeSharePath(path);
  if (!normalized.ok) {
    throw new Error(
      `Der Freigabepfad für „${containerName}" ist leer. Ein leerer Pfad ist keine Angabe, sondern bedeutete ` +
        "beim Agenten das ganze Projektverzeichnis, und wird deshalb nicht gespeichert."
    );
  }
  const { rows } = await pool.query<ShareRow>(
    `INSERT INTO container_share (host_id, container_name, share_path)
     VALUES ($1, $2, $3)
     ON CONFLICT (host_id, container_name) DO UPDATE
        SET share_path = EXCLUDED.share_path,
            updated_at = now()
     RETURNING container_name, share_path`,
    [hostId, containerName, normalized.value]
  );
  return { containerName: rows[0].container_name, path: rows[0].share_path };
}

/** Entfernt die Freigabe eines Containers. Kein Fehler, wenn keine bestand. */
export async function removeShare(pool: Pool, hostId: string, containerName: string): Promise<void> {
  await pool.query("DELETE FROM container_share WHERE host_id = $1 AND container_name = $2", [hostId, containerName]);
}
