import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { GERMAN_WORDS, splitWords } from "../../eslint-rules/english-identifiers.mjs";
import { stripComments } from "./strip-comments.mjs";

// Wächter über die übernommenen Bausteine aus D2 (#62): 20 flach unter
// `web/src/platform/ui/shadcn/` abgelegte Dateien aus der shadcn-Registry, dazu das
// Register `web/src/platform/ui/shadcn/PROVENANCE.md` und die selbst geschriebene
// `web/src/platform/ui/lib/cn.ts`.
//
// Diese Dateien entstehen in einem ANDEREN Bauabschnitt, parallel zu diesem
// Wächter. Solange sie fehlen, MUSS dieser Test verständlich rot werden — mit
// einer Meldung, die das fehlende Verzeichnis nennt — und NICHT mit einem
// ENOENT-Stapel von Node, der wie ein kaputter Test aussieht. Deshalb steht
// vor jedem Lesen ein eigenes `assert.ok(existsSync(...))`.
//
// Warum ein `sha256` und nicht der volle Commit-SHA, den die Konvention sonst
// verlangt: die Registry liefert keinen. Über alle 20 abgerufenen Einträge
// dieses Pakets gemessen trägt ein Registry-Eintrag zwischen vier und acht
// Schlüsseln (Verteilung {4: 1, 5: 17, 6: 1, 8: 1}); über alle 20 kommen neun
// verschiedene Schlüssel vor (`$schema`, `cssVars`, `dependencies`, `docs`,
// `files`, `name`, `registryDependencies`, `tailwind`, `type`), und keiner
// davon benennt eine Fassung, ein Datum oder einen Commit — Details dazu in
// `PROVENANCE.md`, Abschnitt b). An die Stelle des Commits tritt der sha256
// des abgerufenen Eintrags.
//
// GEPRÜFT WIRD, acht Zusicherungen, nicht mehr:
//   1. jede `.ts`/`.tsx` unter `shadcn/` beginnt mit einem Blockkommentar,
//      der die Zeile „Übernommener Baustein" trägt,
//   2. jeder Kopf nennt Quelle (https), Baustein, Bezugsdatum (JJJJ-MM-TT),
//      sha256 (GENAU 64 Hexzeichen) und einen Abschnitt „Abweichungen:" mit
//      mindestens einer Zeile darunter,
//   3. Register, Verzeichnis und die feste Liste `EXPECTED_MODULES` decken
//      sich in DREI Richtungen — ein Register, das eine gelöschte Datei
//      weiterführt, ist genauso falsch wie eine Datei ohne Eintrag, und ein
//      Baustein, der samt Eintrag verschwindet, fiele ohne die feste Liste
//      niemandem auf; jede Richtung wird einzeln gemeldet,
//   4. kein `sha256` kommt zweimal vor. Das ist der stille Fehler dieses
//      Pakets: ein vom Nachbarn abgeschriebener Kopf sieht aus wie ein
//      richtiger, kein Bau und kein Typprüfer bemerkt ihn, und die Herkunft
//      ist rückwirkend nicht mehr feststellbar,
//   5. keine Next.js-Reste unter `web/src/ui/` — weder `"use client"` noch ein
//      Import aus `next`, `next/…` oder `next-themes`. Diese Anwendung läuft
//      unter Vite; die Registry liefert ihre Dateien für Next.js aus,
//   6a. die Pakete des Übernahme-Ritus (`RITUAL_PACKAGES`) stehen in
//      `web/package.json` unter `dependencies` und sind exakt gepinnt. Die
//      Köpfe binden die Bausteine an einen Hash; ein Caret an einer dieser
//      Bibliotheken ließe den Baustein unter seinem eigenen Kopf
//      weiterwandern,
//   6b. kein Baustein importiert ein Paket außerhalb dieser Liste (plus
//      `react`/`react-dom`). 6b hält die Tür zu, die 6a sonst offen ließe:
//      ohne sie zöge ein künftiger Baustein ein weiteres Paket mit Caret
//      herein, und niemand merkte es,
//   7. kein Dateiname unter `web/src/ui/` trägt ein deutsches Wort — dieselbe
//      Wortliste wie `english-filenames.test.mjs` und die ESLint-Regel, damit
//      nicht drei Listen auseinanderlaufen. Der Fall ist an diesem Paket
//      einmal eingetreten: das Register hieß erst `HERKUNFT.md`, und
//      „herkunft" steht in der Liste.
//
// ⚠️ Zusicherung 1 bis 4 lesen DEN KOPF — der ist selbst ein Kommentar.
// Zusicherung 5 und 6 lesen den RUMPF OHNE KOMMENTARE. Das ist keine
// Feinheit: `"use client"` in einer Prosa-Zeile ist keine Anweisung, und ein
// `import`-Wort in einem Kommentar ist keine Abhängigkeit. Ein Wächter in
// diesem Repo ist genau daran schon gestolpert — eine Zusicherung ohne
// `stripComments()` löste einen Fehlalarm aus, der nur im zusammengeführten
// Stand auftrat und in keinem einzelnen Worktree zu sehen war.
//
// ⚠️ NICHT geprüft und bewusst so:
//   - dass das Register zu jedem Baustein auch Quelle und Hash führt.
//     Zusicherung 3 liest aus dem Register nur Dateinamen und ist damit gegen
//     jedes Format robust (Tabelle, Liste, Überschriften).
//   - Richtung 3 vergleicht das VERZEICHNIS mit der festen Liste, nicht das
//     Register. Das Register hängt über Richtung 1 und 2 am Verzeichnis und
//     damit mittelbar an der Liste. Ein Registereintrag für eine Datei, die
//     nur anderswo unter `web/src/ui/` liegt (etwa `cn.ts`), bleibt dabei
//     erlaubt — das Register darf sie erwähnen.
//   - ob der `sha256` im Kopf wirklich der Hash des abgerufenen
//     Registry-Eintrags ist. Das ließe sich nur mit einem Netzabruf prüfen,
//     und ein Wächter, der das Netz braucht, ist kein Wächter. Geprüft wird
//     die Form und die Einmaligkeit, nicht der Wert.
//   - ob die Abweichungen im Kopf die tatsächlichen Abweichungen sind.
//   - `web/src/platform/ui/lib/cn.ts` ist NICHT übernommen und trägt KEINEN
//     Herkunftskopf. Zusicherung 1 und 2 fordern von ihr nichts; 5, 6 und 7
//     gelten für sie wie für jede andere Datei unter `web/src/ui/`.
//   - `stripComments()` liest keinen vollständigen JavaScript-Parser: ein
//     Anführungszeichen in einem regulären Ausdruck (`/["']/`) oder ein `//`
//     innerhalb eines `${…}` in einem Template-Literal kann es verwirren. In
//     Registry-Bausteinen kommt beides nicht vor; steht es eines Tages doch
//     drin, ist die Meldung falsch — nicht die Prüfung überflüssig.

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Der Wächter liest normalerweise den echten Baum. Für die Mutationsproben
// (ein Nachbau des erwarteten Verzeichnisses unter /tmp, in dem genau eine
// Regel verletzt wird) zeigen diese beiden Variablen auf den Nachbau. So läuft
// die Probe, ohne dass der Wächter dafür verbogen werden müsste.
//
// The UI lives under `web/src/platform/ui/` (`shadcn/`, `lib/`, and the parts
// with their own tone or domain knowledge: dot-wave, marks, metrics). Until #255
// it also lived under `web/src/ui/`, which #270 removed; assertions 5 to 7 keep
// reading a list of roots so a second one can be added without a rewrite.
const PLATFORM_UI_ROOT = process.env.UI_ROOT ?? `${REPO_ROOT}web/src/platform/ui`;
const UI_ROOTS = [PLATFORM_UI_ROOT];
const PACKAGE_JSON_PATH = process.env.UI_PACKAGE_JSON ?? `${REPO_ROOT}web/package.json`;

const SHADCN_DIRECTORY = `${PLATFORM_UI_ROOT}/shadcn`;
const REGISTER_NAME = "PROVENANCE.md";
const REGISTER_PATH = `${SHADCN_DIRECTORY}/${REGISTER_NAME}`;

// Der Grund, aus dem dieser Wächter im eigenen Worktree rot ist. Steht in
// jeder Fehlermeldung über eine fehlende Datei, damit niemand ihn für einen
// kaputten Test hält.
const PENDING = "wird parallel in D2 (#62) gebaut und fehlt in diesem Worktree noch";

// Die Bausteine, die D2 übernimmt — ausgeschrieben, nicht gezählt. Eine
// Marke wie „mindestens 15 Dateien" verfällt lautlos: sie bleibt grün, wenn
// fünf Dateien verschwinden. Auch die Rechnung gegen das Register allein
// genügt nicht, denn verschwinden Datei UND Eintrag gemeinsam, stimmen beide
// Seiten wieder überein und das Paket schrumpft, ohne dass etwas rot wird.
//
// Wer einen Baustein dazustellt, trägt ihn in beide Listen ein und hat damit
// den Ritus vollzogen. Diese Liste ist deshalb keine Trägheit, die man beim
// nächsten roten Lauf wegräumt, sondern die Stelle, an der das Dazustellen
// bemerkt wird.
//
// ⚠️ DIE ZAHL DIESER LISTE STEHT NIRGENDS ALS WORT. Hier stand bis zum
// 2026-09-08 an drei Stellen „20 Bausteine" — im Kopf, in diesem Absatz und im
// Titel des Falls unten —, während die Liste 24 Einträge führt (gemessen mit
// `EXPECTED_MODULES.length`). Eine ausgeschriebene Liste, deren Länge daneben
// als Wort steht, veraltet beim ersten Dazustellen, und der Titel bestätigt
// dann eine Zahl, die niemand mehr geprüft hat. Wo die Länge gebraucht wird,
// wird sie deshalb gerechnet.
const EXPECTED_MODULES = [
  "avatar.tsx", "badge.tsx", "breadcrumb.tsx", "button.tsx", "card.tsx", "chart.tsx", "collapsible.tsx",
  "command.tsx", "context-menu.tsx", "dialog.tsx", "dropdown-menu.tsx", "input.tsx",
  "label.tsx", "radio-group.tsx", "select.tsx", "separator.tsx", "sheet.tsx", "sidebar.tsx",
  "skeleton.tsx", "slider.tsx", "sonner.tsx", "switch.tsx", "table.tsx", "tabs.tsx",
  "tooltip.tsx", "use-mobile.ts"
];

// Die Pakete des Übernahme-Ritus. Ein Baustein IST im Wesentlichen ein Aufruf
// dieser Bibliotheken; ein Caret darauf ließe sein Verhalten unter einem
// festen `sha256` weiterwandern, und genau das soll der Kopf verhindern.
//
// ⚠️ Dieselbe Geschichte wie bei `EXPECTED_MODULES`: der Kopf und der Titel
// des Falls unten sagten bis zum 2026-09-08 „sechs Pakete", die Liste führt
// sieben (gemessen mit `RITUAL_PACKAGES.length`). Gezählt wird jetzt dort, wo
// die Zahl gebraucht wird.
const RITUAL_PACKAGES = [
  "radix-ui",
  "class-variance-authority",
  "clsx",
  "tailwind-merge",
  "lucide-react",
  "sonner",
  "cmdk",
  // Der Diagramm-Baustein (#213). Sein Registry-Eintrag nennt `recharts@3.8.0`.
  "recharts"
];

// ⚠️ Die einzige Ausnahme im ganzen Wächter, und sie steht genau hier:
// `react` und `react-dom` sind das Rahmenwerk der ganzen Anwendung. Ihre
// Fassungspolitik gehört dem Projekt, nicht dem Übernahme-Ritus — deshalb
// fordert 6a von ihnen keine exakte Fassung. Zugemacht wird die Ausnahme von
// 6b: jedes andere Paket muss erst auf die Liste oben, und wer es dort
// einträgt, kommt an 6a nicht vorbei.
//
// `use-intl` gehört aus demselben Grund hierher und ausdrücklich NICHT in
// `RITUAL_PACKAGES`: der Unterschied zwischen den beiden Listen ist nicht
// „importiert" gegen „nicht importiert", sondern WER das Paket verlangt.
// `RITUAL_PACKAGES` sind die Abhängigkeiten, die der Registry-Eintrag des
// jeweiligen Bausteins selbst nennt — sie gehören zur Vorlage, und ein Caret
// darauf ließe deren Verhalten unter dem festen `sha256` weiterwandern.
// `use-intl` nennt keine Vorlage; es steht in `dialog.tsx`, `sheet.tsx`,
// `sidebar.tsx`, `breadcrumb.tsx` und `command.tsx` nur, weil DIESES PROJEKT
// dort eine Abweichung eingebaut hat — sichtbaren und vom Screenreader
// gelesenen Text über die Sprachschicht zu führen (siehe PROVENANCE.md,
// Abweichung 7). Dieselbe Abweichung stand vorher schon da, nur über das
// projekteigene Modul `web/src/platform/i18n`; das war nie auf der Ritusliste, weil
// es aus demselben Grund kein Registry-Paket ist. Genau wie bei `react` gilt
// deshalb: Rahmenwerk der Anwendung, nicht Zutat der Vorlage.
//
// `contract` joins them for the same reason (#245): it is this repo's own
// workspace package (shared types and constants), not an ingredient of any
// template. `MarkChip` in `platform/ui/marks/` imports its tone and style names from it.
const FRAMEWORK_PACKAGES = ["react", "react-dom", "use-intl", "contract"];

const ALLOWED_PACKAGES = new Set([...RITUAL_PACKAGES, ...FRAMEWORK_PACKAGES]);

// Eine Fassung gilt als exakt, wenn sie keinen Spielraum lässt. `x` auch groß
// geschrieben: `1.X.0` ist derselbe Platzhalter wie `1.x.0`.
function isPinned(version) {
  return (
    typeof version === "string" &&
    version.trim() !== "" &&
    !/[\^~><*xX]/.test(version) &&
    version !== "latest" &&
    !version.startsWith("workspace:")
  );
}

function displayPath(absolute) {
  return absolute.startsWith(REPO_ROOT) ? absolute.slice(REPO_ROOT.length) : absolute;
}

function requireDirectory(directory) {
  assert.ok(existsSync(directory), `Verzeichnis fehlt: ${displayPath(directory)} — ${PENDING}`);
  assert.ok(statSync(directory).isDirectory(), `Kein Verzeichnis: ${displayPath(directory)}`);
}

function readOrFail(path) {
  assert.ok(existsSync(path), `Datei fehlt: ${displayPath(path)} — ${PENDING}`);
  return readFileSync(path, "utf8");
}

// Alle Dateien unterhalb eines Verzeichnisses, absolut und stabil sortiert.
function collectFiles(directory) {
  const found = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...collectFiles(absolute));
    else found.push(absolute);
  }
  return found;
}

// Every file under all UI roots, each root required to exist.
function collectUiFiles() {
  return UI_ROOTS.flatMap((root) => {
    requireDirectory(root);
    return collectFiles(root);
  });
}

const UI_ROOTS_LABEL = UI_ROOTS.map(displayPath).join(" und ");

const isModule = (path) => /\.tsx?$/.test(path);

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

// Die Zeile, in der ein Schlüssel in einer JSON-Datei steht — damit eine
// Meldung über `web/package.json` auf eine Stelle zeigt und nicht nur auf die
// Datei. Ohne Treffer die 1, denn eine erfundene Zeile wäre schlimmer.
function lineOfKey(text, key) {
  const index = text.indexOf(`"${key}"`);
  return index === -1 ? 1 : lineOf(text, index);
}

// Der erste Block der Datei, sofern es ein Blockkommentar ist. `^\s*` lässt
// nur Leerraum davor zu: ein Kopf, der hinter einem Import steht, ist kein
// erster Block und zählt nicht.
function leadingBlockComment(source) {
  const match = /^\s*(\/\*[\s\S]*?\*\/)/.exec(source);
  if (match === null) return null;
  return { text: match[1], start: match.index + match[0].indexOf("/*") };
}

// Liest einen Schlüssel aus dem Kopf. Verankert am Zeilenanfang (nach dem
// führenden `*` des Blockkommentars), damit ein Fließtext, der zufällig
// „sha256:" oder ein langes Hexwort enthält, nicht als Kopfzeile durchgeht.
function headerValue(header, key) {
  const match = new RegExp(`^[ \\t]*\\*?[ \\t]*${key}:[ \\t]*(.*)$`, "m").exec(header);
  if (match === null) return null;
  return { value: match[1].trim(), index: match.index };
}

// Jede Modulquelle im Rumpf: `from "x"`, `import "x"`, `import("x")`,
// `require("x")` und `export … from "x"`.
const IMPORT_SOURCE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(["'])([^"']+)\1/g;

function collectImportSources(body) {
  const found = [];
  for (const match of body.matchAll(IMPORT_SOURCE)) {
    found.push({ specifier: match[2], index: match.index });
  }
  return found;
}

const isRelative = (specifier) => specifier.startsWith(".") || specifier.startsWith("/");

// `radix-ui/x` → `radix-ui`, `@scope/paket/x` → `@scope/paket`.
function packageNameOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

// Alle Module unter `web/src/ui/`, Rumpf ohne Kommentare — die Grundlage von
// Zusicherung 5 und 6.
function readStrippedModules() {
  const modules = collectUiFiles().filter(isModule);
  assert.ok(modules.length > 0, `Keine .ts/.tsx-Datei unter ${UI_ROOTS_LABEL} — der Wächter liefe ins Leere`);
  return modules.map((path) => ({ path, body: stripComments(readFileSync(path, "utf8")) }));
}

// Alle Bausteine unter `shadcn/` mit ihrem führenden Blockkommentar. Das
// Register ist keine `.ts`/`.tsx` und fällt hier ohnehin heraus.
function readVendoredModules() {
  requireDirectory(SHADCN_DIRECTORY);
  const modules = collectFiles(SHADCN_DIRECTORY).filter(isModule);
  assert.ok(
    modules.length > 0,
    `Keine .ts/.tsx-Datei unter ${displayPath(SHADCN_DIRECTORY)} — der Wächter liefe ins Leere`
  );
  return modules.map((path) => {
    const source = readFileSync(path, "utf8");
    return { path, source, header: leadingBlockComment(source) };
  });
}

test("jeder übernommene Baustein beginnt mit einem Herkunftskopf", () => {
  const findings = readVendoredModules()
    .filter((module) => module.header === null || !/Übernommener Baustein/.test(module.header.text))
    .map((module) => `${displayPath(module.path)}:1: kein führender Blockkommentar mit „Übernommener Baustein"`);

  assert.deepEqual(findings, [], `Baustein ohne Herkunftskopf:\n${findings.join("\n")}`);
});

test("jeder Herkunftskopf nennt Quelle, Baustein, Bezugsdatum, sha256 und Abweichungen", () => {
  const findings = [];

  for (const module of readVendoredModules()) {
    const name = displayPath(module.path);
    if (module.header === null) continue; // Zusicherung 1 meldet das bereits.
    const header = module.header.text;
    const headerLine = (index) => lineOf(module.source, module.header.start + index);

    const source = headerValue(header, "Quelle");
    if (source === null) findings.push(`${name}:${headerLine(0)}: „Quelle:" fehlt im Kopf`);
    else if (!/^https:\/\/\S+/.test(source.value)) {
      findings.push(`${name}:${headerLine(source.index)}: „Quelle:" ist keine https-URL: „${source.value}"`);
    }

    const block = headerValue(header, "Baustein");
    if (block === null) findings.push(`${name}:${headerLine(0)}: „Baustein:" fehlt im Kopf`);
    else if (block.value === "") findings.push(`${name}:${headerLine(block.index)}: „Baustein:" ist leer`);

    const date = headerValue(header, "Bezugsdatum");
    if (date === null) findings.push(`${name}:${headerLine(0)}: „Bezugsdatum:" fehlt im Kopf`);
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(date.value)) {
      findings.push(`${name}:${headerLine(date.index)}: „Bezugsdatum:" ist nicht JJJJ-MM-TT: „${date.value}"`);
    }

    const hash = headerValue(header, "sha256");
    if (hash === null) findings.push(`${name}:${headerLine(0)}: „sha256:" fehlt im Kopf`);
    else {
      const hex = /^[0-9a-fA-F]+/.exec(hash.value);
      const length = hex === null ? 0 : hex[0].length;
      if (length !== 64) {
        findings.push(
          `${name}:${headerLine(hash.index)}: „sha256:" trägt ${length} statt genau 64 Hexzeichen: „${hash.value}"`
        );
      }
    }

    const deviations = headerValue(header, "Abweichungen");
    if (deviations === null) findings.push(`${name}:${headerLine(0)}: Abschnitt „Abweichungen:" fehlt im Kopf`);
    else {
      // Der Blockabschluss `*/` muss ZUERST weg. Andernfalls bleibt vom
      // Rand `` * / `` ein `/` stehen, das als Inhaltszeile durchgeht — die
      // Prüfung wäre dann grün, obwohl unter „Abweichungen:" nichts steht.
      // Genau so ist sie in der ersten Fassung durchgerutscht.
      const below = header
        .slice(deviations.index)
        .split("\n")
        .slice(1)
        .map((line) => line.replace(/\*\/[ \t]*$/, "").replace(/^[ \t]*\*?[ \t]*/, "").trim())
        .filter((line) => line !== "");
      if (below.length === 0) {
        findings.push(`${name}:${headerLine(deviations.index)}: „Abweichungen:" trägt keine einzige Zeile darunter`);
      }
    }
  }

  assert.deepEqual(findings, [], `Unvollständiger Herkunftskopf:\n${findings.join("\n")}`);
});

// ⚠️ Die Zahl im Titel ist GERECHNET und nicht getippt. Ein Titel, der eine
// Zahl nennt und sie nicht erreicht, bestätigt sie nur — hier stand „20",
// während die Liste 24 führt. Der Ausdruck daneben ist zugleich der Messweg.
test(`Register, Verzeichnis und die feste Liste der ${EXPECTED_MODULES.length} Bausteine decken sich`, () => {
  requireDirectory(SHADCN_DIRECTORY);
  const register = readOrFail(REGISTER_PATH);

  const filesInDirectory = collectFiles(SHADCN_DIRECTORY).filter((path) => !path.endsWith(`/${REGISTER_NAME}`));
  assert.ok(
    filesInDirectory.length > 0,
    `${displayPath(SHADCN_DIRECTORY)} trägt außer dem Register keine Datei — der Wächter liefe ins Leere`
  );

  // Richtung 1: jede Datei im Verzeichnis kommt im Register vor. Gesucht wird
  // der Dateiname als eigenes Wort, damit `card.tsx` nicht in
  // `hover-card.tsx` aufgeht.
  const missingInRegister = filesInDirectory
    .filter((path) => {
      const name = path.slice(SHADCN_DIRECTORY.length + 1);
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return !new RegExp(`(?<![\\w./-])${escaped}(?![\\w-])`).test(register);
    })
    .map((path) => `${displayPath(path)}: Datei ohne Eintrag in ${REGISTER_NAME}`);

  // Richtung 2: jeder im Register geführte Dateiname existiert. Gelesen werden
  // nur `.ts`/`.tsx`-Namen — die Registry-URLs im Register enden auf `.json`
  // und stehen hinter einem `/`, das die Rückschau ausschließt.
  const knownNames = new Set(collectUiFiles().map((path) => path.slice(path.lastIndexOf("/") + 1)));
  const listedNames = [...register.matchAll(/(?<![\w./-])([A-Za-z0-9][A-Za-z0-9._-]*\.tsx?)(?![\w-])/g)];
  const seen = new Set();
  const missingOnDisk = [];
  for (const match of listedNames) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    if (!knownNames.has(name)) {
      missingOnDisk.push(`${REGISTER_NAME}:${lineOf(register, match.index)}: „${name}" ist geführt, existiert aber nicht`);
    }
  }
  assert.ok(seen.size > 0, `${REGISTER_NAME} führt keinen einzigen Dateinamen — der Wächter liefe ins Leere`);

  // Richtung 3: das Verzeichnis gegen die feste Liste, in beide Richtungen.
  // Nur sie sieht den Fall, in dem Datei und Registereintrag GEMEINSAM
  // verschwinden — Richtung 1 und 2 stimmen dann wieder überein.
  const namesInDirectory = new Set(filesInDirectory.map((path) => path.slice(SHADCN_DIRECTORY.length + 1)));
  const missingModules = EXPECTED_MODULES.filter((name) => !namesInDirectory.has(name)).map(
    (name) => `${displayPath(SHADCN_DIRECTORY)}/${name}: erwarteter Baustein fehlt`
  );
  const unexpectedModules = [...namesInDirectory]
    .filter((name) => !EXPECTED_MODULES.includes(name))
    .sort()
    .map((name) => `${displayPath(SHADCN_DIRECTORY)}/${name}: steht auf keiner der 20 erwarteten Bausteine`);

  assert.deepEqual(missingInRegister, [], `Datei ohne Registereintrag:\n${missingInRegister.join("\n")}`);
  assert.deepEqual(missingOnDisk, [], `Registereintrag ohne Datei:\n${missingOnDisk.join("\n")}`);
  assert.deepEqual(missingModules, [], `Erwarteter Baustein fehlt im Verzeichnis:\n${missingModules.join("\n")}`);
  assert.deepEqual(
    unexpectedModules,
    [],
    "Baustein außerhalb der festen Liste — wer einen dazustellt, trägt ihn in beide Listen ein " +
      `und hat damit den Ritus vollzogen:\n${unexpectedModules.join("\n")}`
  );
});

test("kein sha256 kommt in zwei Bausteinen vor", () => {
  const byHash = new Map();

  for (const module of readVendoredModules()) {
    if (module.header === null) continue; // Zusicherung 1 meldet das bereits.
    const hash = headerValue(module.header.text, "sha256");
    if (hash === null) continue; // Zusicherung 2 meldet das bereits.
    const hex = /^[0-9a-fA-F]+/.exec(hash.value);
    if (hex === null) continue;
    const value = hex[0].toLowerCase();
    const line = lineOf(module.source, module.header.start + hash.index);
    if (!byHash.has(value)) byHash.set(value, []);
    byHash.get(value).push(`${displayPath(module.path)}:${line}`);
  }

  assert.ok(byHash.size > 0, "Kein einziger sha256 gelesen — der Wächter liefe ins Leere");

  const findings = [...byHash.entries()]
    .filter(([, places]) => places.length > 1)
    .map(([value, places]) => `${value}: ${places.join(", ")}`);

  assert.deepEqual(
    findings,
    [],
    `Derselbe sha256 in mehreren Bausteinen — ein Kopf ist vom Nachbarn abgeschrieben:\n${findings.join("\n")}`
  );
});

test("keine Next.js-Reste unter web/src/ui", () => {
  const findings = [];

  for (const module of readStrippedModules()) {
    const name = displayPath(module.path);

    for (const match of module.body.matchAll(/(["'`])use client\1/g)) {
      findings.push(`${name}:${lineOf(module.body, match.index)}: „use client" — eine Next.js-Anweisung ohne Bedeutung unter Vite`);
    }

    for (const source of collectImportSources(module.body)) {
      const specifier = source.specifier;
      const isNext =
        specifier === "next" ||
        specifier.startsWith("next/") ||
        specifier === "next-themes" ||
        specifier.startsWith("next-themes/");
      if (isNext) {
        findings.push(`${name}:${lineOf(module.body, source.index)}: Import aus „${specifier}" — diese Anwendung läuft unter Vite`);
      }
    }
  }

  assert.deepEqual(findings, [], `Next.js-Rest unter ${UI_ROOTS_LABEL}:\n${findings.join("\n")}`);
});

// ⚠️ Gerechnet wie beim Fall oben, und aus demselben Anlass: hier stand
// „sechs", während `RITUAL_PACKAGES` sieben Einträge führt.
test(`die ${RITUAL_PACKAGES.length} Pakete des Übernahme-Ritus sind exakt gepinnt`, () => {
  // Diese Zusicherung hat nur dort einen Gegenstand, wo es Bausteine gibt:
  // ohne sie ist die Fassungspolitik dieser Pakete keine Frage des
  // Ritus. Der Verzeichnisfall wird deshalb zuerst geprüft, damit dieser
  // Wächter im eigenen Worktree mit „Verzeichnis fehlt" scheitert und nicht
  // mit einer Meldung je Paket, das D2 erst noch einträgt.
  requireDirectory(SHADCN_DIRECTORY);

  const manifest = readOrFail(PACKAGE_JSON_PATH);
  const dependencies = JSON.parse(manifest).dependencies ?? {};
  const findings = [];

  for (const packageName of RITUAL_PACKAGES) {
    const line = lineOfKey(manifest, packageName);
    const version = dependencies[packageName];
    if (version === undefined) {
      findings.push(`${displayPath(PACKAGE_JSON_PATH)}:${line}: „${packageName}" fehlt unter „dependencies"`);
      continue;
    }
    if (!isPinned(version)) {
      findings.push(`${displayPath(PACKAGE_JSON_PATH)}:${line}: „${packageName}" ist nicht exakt gepinnt: „${version}"`);
    }
  }

  assert.deepEqual(findings, [], `Paket des Ritus ohne exakte Fassung:\n${findings.join("\n")}`);
});

test("kein Baustein importiert ein Paket außerhalb der Liste des Ritus", () => {
  const allowed = [...ALLOWED_PACKAGES].join(", ");
  const findings = [];
  const checked = new Set();

  for (const module of readStrippedModules()) {
    for (const source of collectImportSources(module.body)) {
      if (isRelative(source.specifier)) continue;
      const packageName = packageNameOf(source.specifier);
      if (ALLOWED_PACKAGES.has(packageName)) continue;
      const place = `${displayPath(module.path)}:${lineOf(module.body, source.index)}`;
      if (checked.has(place)) continue;
      checked.add(place);
      findings.push(`${place}: „${packageName}" steht nicht auf der Liste — erlaubt sind nur: ${allowed}`);
    }
  }

  assert.deepEqual(
    findings,
    [],
    "Baustein zieht ein Paket außerhalb des Ritus herein. Ein neues Paket gehört erst auf die " +
      `Liste in dieser Datei, und dort kommt es an der exakten Fassung nicht vorbei:\n${findings.join("\n")}`
  );
});

test("kein Dateiname unter web/src/ui trägt ein deutsches Wort", () => {
  // Ohne diesen Fall liefe der Wächter bei einer leeren Wortliste ins Leere.
  assert.ok(GERMAN_WORDS.size > 100, `Die Wortliste zählt nur ${GERMAN_WORDS.size} Einträge — das sieht nach einem Unfall aus`);

  const files = UI_ROOTS.flatMap((root) => {
    requireDirectory(root);
    return collectFiles(root).map((path) => ({ path, inside: path.slice(root.length + 1) }));
  });
  assert.ok(files.length > 0, `${UI_ROOTS_LABEL} ist leer — der Wächter liefe ins Leere`);

  // Ein Segment wird an `.` und `-` getrennt und jedes Stück wie ein
  // Bezeichner gelesen — dieselbe Zerlegung wie in `english-filenames`.
  const findings = [];
  for (const { path, inside } of files) {
    for (const segment of inside.split("/")) {
      for (const piece of segment.split(/[.-]+/)) {
        const german = splitWords(piece).find((word) => GERMAN_WORDS.has(word));
        if (german !== undefined) {
          findings.push(`${displayPath(path)}: „${segment}" trägt „${german}"`);
          break;
        }
      }
    }
  }

  assert.deepEqual(
    findings,
    [],
    `Deutscher Datei- oder Verzeichnisname unter ${UI_ROOTS_LABEL} (AGENTS.md, Abschnitt Sprache):\n${findings.join("\n")}`
  );
});
