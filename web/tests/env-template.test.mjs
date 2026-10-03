import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// `.env.example` ist der Saatpunkt jeder Laufzeitumgebung: wer das System neu
// aufsetzt, füllt diese Vorlage und sonst nichts. Eine Variable, die der Code
// liest, aber die Vorlage nicht führt, ist deshalb kein Schönheitsfehler — sie
// ist eine Einstellung, von der ein neuer Betreiber nie erfährt, bis etwas
// nicht funktioniert.
//
// Das wiegt hier schwerer als anderswo: das Zielbild ist ein Dritter, der das
// System in seinem eigenen Netz hochfährt, ohne dieses hier zu kennen.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Variablen, die bewusst NICHT in der Vorlage stehen, jede mit ihrem Grund.
// Diese Liste ist kurz zu halten — sie ist die Tür, durch die die Regel
// verschwindet.
const EXCEPTIONS = new Map([
  // Gehört zur Arbeitsumgebung, nicht zur Laufzeit: kein Serverprozess liest
  // ihn, und die Vorlage ist der Saatpunkt der LAUFZEIT.
  ["SHADCNBLOCKS_API_KEY", "Arbeitsumgebung, kein Laufzeitwert"],
  // Liest nur `scripts/bootstrap.sh`, um die Docker-GID abzulesen — ein
  // Einrichtungswert, kein Laufzeitwert. Der Wächter sieht Shell-Skripte
  // nicht; der Eintrag hier hält die Entscheidung fest (#27, 2026-09-06),
  // der Weg für den Betreiber steht im README unter „Stack starten".
  ["DOCKER_SOCKET", "Einrichtungswert des Bootstrap-Skripts, kein Laufzeitwert"],
  // Von Node bzw. den Werkzeugen selbst gesetzt.
  ["NODE_ENV", "von der Laufzeit gesetzt"]
]);

test("jede gelesene Umgebungsvariable steht in .env.example", () => {
  const sources = execFileSync("git", ["ls-files", "server/src/*.ts", "web/src/*.ts", "web/src/*.tsx"], {
    cwd: ROOT,
    encoding: "utf8"
  })
    .split("\n")
    .filter(Boolean);

  const readNames = new Set();
  for (const path of sources) {
    const content = readFileSync(new URL(path, `file://${ROOT}`), "utf8");
    for (const match of content.matchAll(/process\.env\.([A-Z0-9_]+)/g)) readNames.add(match[1]);
    for (const match of content.matchAll(/process\.env\[["']([A-Z0-9_]+)["']\]/g)) readNames.add(match[1]);
    // Auch der Zugriff über eine hereingereichte Umgebung, nicht nur über
    // `process.env` direkt.
    //
    // Ohne diese Zeile hat der Wächter ein Loch, durch das die gesamte
    // Konfiguration passt: eine Funktion `loadConfig(env = process.env)` liest
    // ihre Werte über diesen Parameter, und `process.env` mit Punkt und Namen
    // steht dann nirgends
    // mehr im Code. Genau so ist server/src/platform/config/config.ts gebaut — testbar zu
    // sein, ist der Grund dafür, und die Sichtbarkeit hier darf das nicht kosten.
    for (const match of content.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) readNames.add(match[1]);
    for (const match of content.matchAll(/\benv\[["']([A-Z0-9_]+)["']\]/g)) readNames.add(match[1]);
  }

  const template = new Set(
    readFileSync(new URL(".env.example", `file://${ROOT}`), "utf8")
      .split("\n")
      .map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1])
      .filter(Boolean)
  );

  const missing = [...readNames].filter((name) => !template.has(name) && !EXCEPTIONS.has(name)).sort();
  assert.deepEqual(missing, [], `Vom Code gelesen, aber nicht in .env.example:\n${missing.join("\n")}`);
});

// Die Gegenrichtung, und sie fehlte: der Test oben prüft Code → Vorlage und
// sieht deshalb nicht, wenn eine Zeile der Vorlage ins Leere zeigt. Gemessen am
// 2026-09-09 (#142): sieben Namen der Benachrichtigungen standen ohne einen
// einzigen Leser da, und wer sie ausfüllte, wartete auf eine Mail, die nie
// kommt. Eine Vorlage, die Stellschrauben verspricht, die es nicht gibt, ist
// schlechter als eine, die schweigt.
//
// Der Ausweg ist keine zweite Ausnahmeliste, sondern die Überschrift: ein
// Abschnitt, der „spätere Phase" trägt, sagt dem Leser dasselbe wie dieser
// Wächter — hier ist noch nichts angeschlossen.
const LATER_PHASE = "spätere Phase";

function templateSections() {
  const lines = readFileSync(new URL(".env.example", `file://${ROOT}`), "utf8").split("\n");
  const sections = new Map();
  // Eine Überschrift ist die Kommentarzeile ZWISCHEN zwei Linien aus Strichen.
  // Über die Linien zu zählen ginge auch, bis eine dritte dazukommt.
  const isRule = (line) => /^#\s*-{10,}\s*$/.test(line ?? "");
  let heading = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("#") && !isRule(line) && isRule(lines[index - 1]) && isRule(lines[index + 1])) {
      heading = line.replace(/^#\s?/, "").trim();
      continue;
    }
    const name = line.match(/^#?\s*([A-Z][A-Z0-9_]*)=/)?.[1];
    if (name) sections.set(name, heading);
  }
  return sections;
}

test("jede Variable der Vorlage wird gelesen oder steht unter einer späteren Phase", () => {
  // Derselbe Suchraum, aus dem der Befund kam: die Compose-Datei, beide
  // Workspaces und die Skripte. Ein Treffer im Fließtext einer Doku zählt
  // ausdrücklich nicht — er beweist nur, dass jemand über die Variable
  // geschrieben hat, nicht dass sie jemand liest.
  const sources = execFileSync(
    "git",
    ["ls-files", "docker-compose.yml", "server/src", "web/src", "scripts"],
    { cwd: ROOT, encoding: "utf8" }
  )
    .split("\n")
    .filter(Boolean);
  const haystack = sources.map((path) => readFileSync(new URL(path, `file://${ROOT}`), "utf8")).join("\n");

  const unused = [...templateSections()]
    .filter(([name, heading]) => !heading.includes(LATER_PHASE) && !new RegExp(`\\b${name}\\b`).test(haystack))
    .map(([name]) => name)
    .sort();

  assert.deepEqual(
    unused,
    [],
    `In .env.example geführt, aber nirgends gelesen — anschließen oder in einen Abschnitt mit „${LATER_PHASE}" ` +
      `verschieben:\n${unused.join("\n")}`
  );
});

test("keine Ausnahme steht versehentlich doch in der Vorlage", () => {
  const template = readFileSync(new URL(".env.example", `file://${ROOT}`), "utf8");
  const duplicates = [...EXCEPTIONS.keys()].filter((name) => new RegExp(`^${name}=`, "m").test(template));
  assert.deepEqual(duplicates, [], `Als Ausnahme geführt und trotzdem in der Vorlage:\n${duplicates.join("\n")}`);
});
