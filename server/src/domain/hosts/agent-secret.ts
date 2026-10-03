import type { Pool } from "pg";

import { AgentError } from "../../platform/agent-transport/protocol.js";
import type { HostRecord } from "./host-record.js";
import { readHostAgentSecret } from "./host-store.js";

// Welches Geheimnis zu welchem Arm gehört — die eine Stelle, an der das
// entschieden wird.
//
// ⚠️ Der Fehler, den diese Datei behebt (#77): beide lesenden Routen nahmen
// DASSELBE Geheimnis aus der Umgebung. Es passt nur zum lokalen Arm, dessen
// Secret in der `.env` steht; jeder angebundene antwortete damit mit 401, und
// in der Übersicht stand statt seiner Container eine Ablehnung. Je Arm liegt
// seit 004-host-enrollment.sql ein eigenes bereit.
//
// ⚠️ DER RÜCKFALL AUF DIE UMGEBUNG HÄNGT AN `kind === "local"` UND NICHT
// DARAN, DASS DIE SPALTE LEER IST. Beides sieht im Diff gleich aus und ist es
// nicht: `readHostAgentSecret` liefert auch für einen angebundenen Arm `null`,
// dessen Zeile noch kein Secret trägt (angelegt, nie ein Archiv geholt). Fiele
// der Code auch dort auf die Umgebung zurück, ginge dieselbe falsche
// Beglaubigung wieder hinaus — der Fehler aus #77, nur besser versteckt: alle
// Tests blieben grün, weil in der Testumgebung ohnehin nur der lokale Arm
// antwortet.
//
// Ein angebundener Arm ohne Secret bekommt deshalb einen `AgentError`. Er wird
// in der Übersicht zur Meldung in SEINER Zeile (containers/overview.ts) und in
// `GET /hosts/:hostId/containers` zum Feld `error` — die Fläche fällt nicht
// um, und der Betreiber liest, was zu tun ist.

/**
 * Das Agent-Secret, mit dem dieser Hub DIESEN Arm anspricht.
 *
 * @param localSecret Das Geheimnis aus der Umgebung (`DOCKER_AGENT_SECRET`).
 *   Es gilt ausschließlich für `kind = "local"`.
 */
export async function resolveAgentSecret(pool: Pool, host: HostRecord, localSecret: string): Promise<string> {
  const stored = await readHostAgentSecret(pool, host.id);
  if (stored !== null) return stored;
  if (host.kind === "local") return localSecret;
  throw new AgentError(
    `Für den Arm „${host.name}" ist kein Agent-Secret hinterlegt. Ein neues Archiv ` +
      "(GET /hosts/:hostId/archive) legt eines an und schreibt es in die Zeile des Arms."
  );
}
