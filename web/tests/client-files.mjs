import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Der Dateileser der Web-API für die Repo-Wächter — seit Etappe B5-E4 (#5)
// aus `api-mirror.test.mjs` ausgelagert, weil jene Datei sonst über die
// Zeilenmarke aus `source-file-size.test.mjs` gewachsen wäre (LIMIT 1000).
//
// Warum eine eigene Datei und nicht in `router-routes.mjs`: jene Datei ist
// der ROUTEN-Leser — sie liest `server/src/app/router.ts` und die
// `routes.ts` der Features, und ihr Name sagt das. Die Dateien hier sind
// keine Routen, sie SPRECHEN mit ihnen; ein Leser dafür dort unterzubringen
// dehnte den Namen jener Datei über das aus, was sie tut. Diese Datei hier ist
// der Web-seitige Gegenpart, unter eigenem Namen.
//
// ⚠️ DER DATEINAME TRÄGT KEIN `.test.` — der Weblauf ist
// `node --import tsx --test "tests/**/*.test.{mjs,tsx}"`, und eine
// Hilfsdatei, die dieses Muster träfe, würde als Testdatei eingesammelt und
// meldete „keine Tests" (dieselbe Erklärung steht am Kopf von
// `router-routes.mjs`, Zeilen 18–21).

// Where the calls of the web live. Since #271 every module that calls the hub
// is named `api.ts` (`features/<name>/api.ts`, `domain/hosts/api.ts`,
// `platform/session/api.ts`, `platform/i18n/api.ts`), next to the transport in
// `platform/http/` (`request`, `parseResponse`, session expiry). Until then a
// part of them stood in `web/src/api/client.ts`.
// `web/tests/no-api-call-in-effect.test.mjs` holds the naming: a module outside these
// that calls the hub is red there.
const SRC_PATH = fileURLToPath(new URL("../src/", import.meta.url));
const TRANSPORT_DIR = "platform/http";

/**
 * Every file a call to the server can stand in: each `.ts` file under
 * `web/src/platform/http/` and every `api.ts` under `web/src/`, without tests
 * (`.test.`) and type declarations (`.d.ts`). Each entry is the repo-relative
 * path (for the messages of the guards) and the unread content. Read with
 * `readdirSync`, from the FILE SYSTEM and not through `git ls-files`: a new
 * file is seen at once, before its `git add`.
 */
export function clientFiles() {
  const transport = readdirSync(join(SRC_PATH, TRANSPORT_DIR))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.includes(".test."))
    .map((name) => `${TRANSPORT_DIR}/${name}`);
  const apis = readdirSync(SRC_PATH, { recursive: true })
    .map((name) => name.split(sep).join("/"))
    .filter((name) => name === "api.ts" || name.endsWith("/api.ts"));
  return [...transport, ...apis]
    .sort()
    .map((name) => ({ file: `web/src/${name}`, content: readFileSync(join(SRC_PATH, name), "utf8") }));
}
