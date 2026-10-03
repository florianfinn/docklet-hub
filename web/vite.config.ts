import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

/**
 * Die Fassung des Hubs, gelesen aus der `package.json` der Repo-Wurzel.
 *
 * Bewusst die Wurzel und nicht `web/package.json`: die Fassung des Hubs ist die
 * des Ganzen, nicht die eines Arbeitsbereichs. `web` und `server` tragen eigene
 * Nummern, die niemand nach außen zusagt — was in der Fußzeile steht, ist die
 * Nummer, unter der jemand das ganze System betreibt.
 *
 * Gelesen wird hier, im Node-Kontext beim Bauen, und nicht im Bündel. Ein
 * `import "../package.json"` im Anwendungscode zöge die ganze Datei mit
 * Abhängigkeiten, Skripten und Beschreibung in das ausgelieferte JavaScript —
 * für eine einzige Zeichenkette.
 *
 * ⚠️ Ist die Datei unlesbar oder das Feld leer, bleibt das Ergebnis der leere
 * String. Hier wird nichts erfunden: keine „0.0.0", kein „unbekannt". Eine
 * erfundene Nummer ist schlimmer als gar keine, weil sie geglaubt und gemeldet
 * wird. Die Fußzeile zeigt an dieser Stelle dann nichts.
 */
function readHubVersion(): string {
  try {
    const packageFile = fileURLToPath(new URL("../package.json", import.meta.url));
    const content: unknown = JSON.parse(readFileSync(packageFile, "utf8"));
    const version = (content as { version?: unknown }).version;
    return typeof version === "string" ? version : "";
  } catch {
    return "";
  }
}

export default defineConfig({
  define: {
    // `define` ersetzt den Namen wörtlich im Quelltext, bevor gebündelt wird.
    // Der Wert muss deshalb schon gültiges JavaScript sein und nicht der nackte
    // Text — ohne `JSON.stringify` stünde `0.1.0` als Ausdruck im Bündel.
    // Der Typ dazu steht in `src/version.d.ts`.
    __HUB_VERSION__: JSON.stringify(readHubVersion())
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    // Bundle `contract` from its TypeScript source in dev and build alike,
    // so the web build does not depend on `contract/dist`.
    conditions: ["source", ...defaultClientConditions]
  },
  server: {
    // Im Entwicklungsbetrieb liefert Vite die Oberfläche und der Hub die API.
    // Ohne diesen Weiterleiter liefe jeder Aufruf gegen den Vite-Port und käme
    // als 404 zurück — ein Fehler, den man leicht dem Server zuschreibt.
    proxy: {
      "/health": "http://localhost:8080",
      "/api": "http://localhost:8080"
    }
  }
});
