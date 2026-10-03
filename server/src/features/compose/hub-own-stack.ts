import { hostname } from "node:os";

import type { ContainerOverviewEntry } from "../../domain/containers/index.js";

// Der eigene Stack des Hubs — erkannt, damit der Compose-Editor ihn nicht
// anwendet (#183, Entscheidung des Betreibers vom 2026-09-29).
//
// ⚠️ WARUM ÜBERHAUPT. Seit #183 hängt der lokale Agent den Basispfad ein
// (`docker-compose.yml`, Dienst `docker-agent`), und damit liegt auch das
// Verzeichnis dieses Stacks in seinem Blick. Ein Anwenden dort ersetzte die
// Container des Hubs, während der Hub den Vorgang noch führt: der Strom
// risse ab, der Abgleich danach liefe nie, und ob der Stack wieder steht,
// sähe niemand.
//
// ⚠️ WORAN ER SICH ERKENNT: AM EIGENEN HOSTNAMEN. Der Hub hat keinen
// docker.sock und kann sich nicht selbst inspizieren. Docker setzt den
// Hostnamen eines Containers auf die ersten zwölf Stellen seiner Kennung.
// Der Hub teilt seinen Netz-Namensraum mit dem Tunnel-Dienst
// (`network_mode: "service:wireguard"`) und trägt dann dessen Hostnamen —
// gemessen am 2026-09-29 auf dem Proxy: `hostname` im Hub ergab
// `37bfb9511f3f`, die Kennung eines Containers aus `docker compose ps -q`
// desselben Stacks. Welcher der beiden es ist, spielt keine Rolle: beide
// gehören zu diesem Compose-Projekt.
//
// ⚠️ SIEHT DER HOSTNAME NICHT AUS WIE EINE KENNUNG, GIBT ES KEINEN EIGENEN
// STACK. Das ist der Hub außerhalb von Docker (Entwicklung, Tests) oder mit
// gesetztem `hostname:`. Dann sperrt nichts — und das ist ehrlich: erkannt
// wird, was sich belegen lässt, nicht was vermutet wird.

/** Die ersten zwölf Stellen einer Container-Kennung — so setzt Docker den Hostnamen. */
const SHORT_ID = /^[0-9a-f]{12}$/;

/** Die Kurzkennung dieses Hubs, oder `null`, wo der Hostname keine ist. */
export function ownShortId(name: string = hostname()): string | null {
  return SHORT_ID.test(name) ? name : null;
}

/**
 * Gehört `anchor` zum Compose-Projekt, in dem dieser Hub läuft?
 *
 * ⚠️ ÜBER DAS PROJEKT UND NICHT ÜBER DEN EINEN CONTAINER. Der Anker des
 * Compose-Reiters ist irgendein Container des Stacks — oft Postgres, nicht
 * der Container mit diesem Hostnamen. Verglichen wird deshalb, ob IRGENDEIN
 * Container desselben Projekts auf diesem Arm die eigene Kennung trägt.
 */
export function isHubOwnStack(
  anchor: ContainerOverviewEntry,
  containers: readonly ContainerOverviewEntry[],
  shortId: string | null = ownShortId()
): boolean {
  if (shortId === null || anchor.compose === null) return false;
  const project = anchor.compose.project;
  return containers.some((entry) => entry.compose?.project === project && entry.id.startsWith(shortId));
}
