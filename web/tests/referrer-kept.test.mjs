import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Wächter: die eigene Oberfläche unterdrückt ihren `Referer` nirgends.
//
// ⚠️ WARUM ES IHN GIBT. Über reines HTTP (kein sicherer Kontext) sendet der
// Browser kein `Sec-Fetch-Site`, und bei einem GET aus derselben Herkunft auch
// kein `Origin`. Dann weist allein der `Referer` eine Anfrage an einer Route
// aus `GET_ROUTES_WITH_EFFECT` als die eigene aus — Zeile 6 der Tabelle in
// docs/design/phase-5-write-access.md §1 („Reines HTTP"). Gemessen am
// 2026-09-29 gegen `http://192.0.2.31:8090`: ohne diese Zeile standen
// Protokoll und Dateien auf jedem Arm auf `403 forbidden-origin`.
//
// Eine `Referrer-Policy: no-referrer`, ein `<meta name="referrer">` mit
// demselben Wert, ein `referrerPolicy` am `fetch` oder ein `rel="noreferrer"`
// an einem Download-Link bräche genau das wieder, und zwar still: jeder Test
// ohne Browser bliebe grün, weil er seine Kopfzeilen selbst setzt.
//
// Geprüft wird der ausgelieferte Code — Server, Oberfläche und `index.html`.
// Tests und Dokumente dürfen das Wort nennen; sie erklären den Fall.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const FORBIDDEN = /no-?referrer|referrerPolicy/i;

function shippedFiles() {
  const listed = execFileSync(
    "git",
    ["ls-files", "--", "server/src/*.ts", "web/src/*.ts", "web/src/*.tsx", "web/index.html"],
    { cwd: ROOT, encoding: "utf8" }
  );
  return listed
    .split("\n")
    .filter((path) => path !== "" && !/\.test\.tsx?$/.test(path));
}

test("der ausgelieferte Code unterdrückt den Referer nirgends", () => {
  const files = shippedFiles();
  // Eine leere Liste machte diesen Fall grün, ohne dass er etwas gesehen hat.
  assert.ok(files.length > 100, `nur ${files.length} Dateien gefunden — stimmt das Muster noch?`);

  const hits = [];
  for (const path of files) {
    const lines = readFileSync(join(ROOT, path), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (FORBIDDEN.test(line)) hits.push(`${path}:${index + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(
    hits,
    [],
    "Ohne Referer weist sich die eigene Oberfläche über reines HTTP nicht mehr aus (phase-5-write-access.md §1, Zeile 6)."
  );
});
