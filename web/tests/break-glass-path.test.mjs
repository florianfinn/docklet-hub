import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Wächter über den einen Pfad, der stimmen muss, wenn nichts mehr stimmt.
//
// Das Break-Glass ist der Weg zurück in einen ausgesperrten Hub. Wer ihn
// braucht, hat keine Weboberfläche mehr, über die er nachsehen könnte, wie er
// heißt — er hat die Zeile aus dem README oder aus der Fehlermeldung, und die
// muss stimmen.
//
// Sie stimmt leicht nicht: der Befehl nennt den Pfad im IMAGE
// (`server/dist/...`), die Datei liegt in der Arbeitskopie unter
// `server/src/...`, und zwischen beiden steht das Dockerfile. Wer die Datei
// verschiebt, ändert damit drei Stellen, von denen zwei Prosa sind.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Der Pfad, unter dem das Werkzeug im Image liegt. Er ergibt sich aus dem
// WORKDIR des Dockerfiles (/app) und dem, was dorthin kopiert wird.
const COMMAND_PATH = "server/dist/platform/auth/break-glass.js";
const SOURCE_PATH = "server/src/platform/auth/break-glass.ts";

function read(path) {
  return readFileSync(new URL(path, `file://${ROOT}`), "utf8");
}

test("das Werkzeug liegt dort, wo der Befehl es vermutet", () => {
  assert.ok(existsSync(new URL(SOURCE_PATH, `file://${ROOT}`)), `${SOURCE_PATH} fehlt`);

  // `tsc` bildet src/ nach dist/ eins zu eins ab (server/tsconfig.json:
  // rootDir src, outDir dist). Der Befehlspfad folgt daraus.
  const expected = SOURCE_PATH.replace("/src/", "/dist/").replace(/\.ts$/, ".js");
  assert.equal(COMMAND_PATH, expected);
});

test("jede Stelle, die den Befehl nennt, nennt denselben Pfad", () => {
  // Prosa und Code getrennt geprüft, weil sie getrennt veralten.
  const places = ["README.md", "server/src/platform/auth/break-glass-args.ts", "server/src/platform/auth/auth.ts"];
  const missing = places.filter((place) => !read(place).includes(COMMAND_PATH));
  assert.deepEqual(missing, [], `Nennt das Break-Glass nicht unter „${COMMAND_PATH}":\n${missing.join("\n")}`);
});

test("das Image bekommt das Werkzeug mit", () => {
  // Es liegt unter server/dist und wandert mit der einen COPY-Zeile ins
  // Image, die den ganzen Ordner nimmt. Fiele sie weg oder würde sie auf
  // einzelne Dateien verengt, stünde der Befehl im README und liefe ins Leere.
  const dockerfile = read("server/Dockerfile");
  assert.match(dockerfile, /^COPY .*\/server\/dist \.\/server\/dist$/m);
});
