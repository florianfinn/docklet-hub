import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stripComments } from "./strip-comments.mjs";

// Wächter über die Schale des Hubs aus D3 (#62): `web/src/app/shell/` mit
// `AppShell.tsx`, `AppSidebar.tsx`, `navigation.ts` und `CommandPalette.tsx`.
//
// Diese Dateien entstehen in einem ANDEREN Bauabschnitt, parallel zu diesem
// Wächter. Solange sie fehlen, MUSS dieser Test verständlich rot werden — mit
// einer Meldung, die das fehlende Verzeichnis nennt — und NICHT mit einem
// ENOENT-Stapel von Node, der wie ein kaputter Test aussieht. Deshalb steht
// vor jedem Lesen ein eigenes `assert.ok(existsSync(...))`.
//
// Dieser Wächter ist ABSICHTLICH nicht aus dem entstehenden Code abgeleitet,
// sondern aus den drei Regeln des Projekts (AGENTS.md, Abschnitt Sprache;
// docs/design/hub-color-and-structure.md). Ein Wächter, der aus dem Code
// abgeschrieben ist, prüft nur, dass der Code so ist, wie er ist.
//
// GEPRÜFT WIRD, sechs Zusicherungen, nicht mehr:
//   1. kein Navigationseintrag ohne Fläche und ohne Adresse — jeder Eintrag in
//      `navigation.ts` trägt das Pflichtfeld `screen`, und dessen Wert zeigt
//      auf einen Bildschirm, den es unter `web/src/app/screens/` wirklich gibt;
//      und seit D6b (#62) das Pflichtfeld `path`, dessen Wert eine Adresse mit
//      führendem „/" ist. Das ist die wertvollste Zusicherung des Pakets: sie
//      hält „Einträge, die es noch nicht gibt, erscheinen nicht" über die
//      nächsten Etappen hinweg maschinell wahr. Ohne sie wandert irgendwann
//      ein Eintrag in die Liste, dessen Fläche erst „nächste Woche" kommt, und
//      niemand merkt es. ⚠️ Der PFAD gehört hierher und nicht in den Wächter
//      über die Routentabelle: er steht am Eintrag, weil es dort seine EINE
//      Quelle gibt — die Routentabelle liest ihn. Ob es zu jedem Eintrag eine
//      Route gibt, ob ein Pfad doppelt vorkommt und ob der Startpfad belegt
//      ist, prüft `web/tests/screen-switching.test.mjs`,
//   2. kein sichtbarer Text in der Schale — `ui-texts.test.mjs` prüft
//      JSX-Textknoten und vier Attribute; die Navigationsdaten sind aber eine
//      LISTE VON OBJEKTEN und fallen dort durch. Genau diese Lücke wird hier
//      geschlossen: `label: "Übersicht"` ist rot. Seit der Sprachumschaltung
//      (#70) kommt die zweite Hälfte dazu: die Navigationsdaten stehen auf
//      MODULEBENE und können deshalb keinen Hook rufen — sie tragen statt
//      eines Textes einen SCHLÜSSEL im Feld `labelKey`, den die Seitenleiste
//      erst beim Zeichnen durch `t()` schickt. Ein Schlüssel ist aber nur so
//      viel wert wie sein Eintrag. ⚠️ Der Typcheck fängt einen Tippfehler
//      darin HEUTE mit: `labelKey` ist ein `TranslationKey` und keine
//      Zeichenkette, und `labelKey: "navOverviw"` meldet `tsc --noEmit` als
//      TS2820 samt „Did you mean '"navOverview"'?" (gemessen am 2026-09-05).
//      Diese Deckung ist aber eine LEIHGABE am Typ des Feldes: wird er zu
//      `string` geweitet oder steht irgendwo ein `as`, ist sie still weg —
//      `use-intl` gibt zur Laufzeit den Schlüssel selbst zurück, und in der
//      Seitenleiste steht dann „navOverviw". Deshalb wird hier jeder `labelKey`
//      ein zweites Mal und an keinem Typ hängend gegen die Schlüssel aus
//      `web/src/platform/i18n/messages/de.ts` gehalten,
//   3. die Schale setzt die Achse — `data-area` kommt unter `shell/` vor, und
//      jeder dort benutzte Wert steht in `web/src/platform/theme/palette.css`. Die
//      erlaubten Werte werden AUS `palette.css` gelesen und nicht
//      abgeschrieben, sonst laufen zwei Listen auseinander,
//   4. kein Rückfall auf die Tailwind-Grundpalette — keine Klasse wie
//      `text-slate-500`, `border-gray-200`, `bg-red-600`. Die Schale benutzt
//      die Token aus `web/src/platform/theme/`,
//   5. keine externe Quelle — kein `http(s)://` in einem `src`- oder
//      `href`-Attribut. Die CSP des Hubs ist `default-src 'self'`; ein
//      externes Bild lädt schlicht nicht. Der Vorlagenblock, an dem sich die
//      Schale orientiert, bringt genau so ein Logo mit,
//   6. `TooltipProvider` steht an der Wurzel — der übernommene Baustein
//      `tooltip` verlangt laut Registry, dass die Anwendung darin liegt.
//
// ⚠️ Zusicherung 1 bis 5 lesen den Rumpf OHNE KOMMENTARE. Das ist keine
// Feinheit: ein Platzhalter `label: "Übersicht"` in einer erklärenden Zeile
// ist kein Code, „slate" in Prosa ist keine Klasse, und eine Beispiel-URL in
// einem Kommentar lädt nichts. In dieser Sitzung ist ein Wächter genau daran
// gestolpert — eine Zusicherung ohne `stripComments()` löste einen Fehlalarm
// aus, der NUR im zusammengeführten Stand auftrat und in keinem einzelnen
// Worktree zu sehen war.
//
// ⚠️ NICHT geprüft und bewusst so:
//   - eine Fläche OHNE Navigationseintrag ist KEIN Fehler. `SetupScreen` und
//     `SignInScreen` gehören nie in die Navigation; die Gegenrichtung wird
//     deshalb nur als Diagnose gemeldet, nie erzwungen.
//   - verschachtelte Untereinträge (ein Objekt in einem Feld eines Eintrags).
//     Gelesen werden die Objekte der obersten Ebene eines Array-Literals.
//     Heute gibt es genau eine Fläche; entsteht später eine zweite Ebene,
//     gehört sie hier ergänzt.
//   - OB `TooltipProvider` wirklich das ÄUSSERSTE Element von `AppShell` ist.
//     Geprüft wird, dass er importiert und als Element benutzt wird — die
//     Schachtelungstiefe ließe sich ohne JSX-Parser nur raten, und ein
//     geratener Fehlalarm ist teurer als diese Lücke.
//   - ob die Farbtoken, die statt der Grundpalette benutzt werden, die
//     richtigen sind. Das prüft `design-tokens.test.mjs` an der Quelle.
//   - über Variablen zusammengesetzte Texte, Klassen und URLs. Dieser Wächter
//     hält den Normalfall, nicht den Vorsatz.
//   - `stripComments()` ist kein vollständiger Parser: ein Anführungszeichen
//     in einem regulären Ausdruck (`/["']/`) oder ein `//` innerhalb eines
//     `${…}` in einem Template-Literal kann es verwirren. Steht das eines
//     Tages im Code, ist die Meldung falsch — nicht die Prüfung überflüssig.

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Der Wächter liest normalerweise den echten Baum. Für die Mutationsproben
// (ein Nachbau des erwarteten Verzeichnisses unter dem Ablagefach, in dem
// genau eine Regel verletzt wird) zeigen diese vier Variablen auf den Nachbau.
// So läuft die Probe, ohne dass der Wächter dafür verbogen werden müsste —
// `vendored-origin.test.mjs` macht es mit `UI_ROOT` genauso.
const SHELL_ROOT = process.env.SHELL_ROOT ?? `${REPO_ROOT}web/src/app/shell`;
const SCREENS_ROOT = process.env.SCREENS_ROOT ?? `${REPO_ROOT}web/src/app/screens`;
const PALETTE_PATH = process.env.PALETTE_CSS ?? `${REPO_ROOT}web/src/platform/theme/palette.css`;
const MESSAGES_DE_PATH = process.env.MESSAGES_DE ?? `${REPO_ROOT}web/src/platform/i18n/messages/de.ts`;

const NAVIGATION_PATH = `${SHELL_ROOT}/navigation.ts`;
const APP_SHELL_PATH = `${SHELL_ROOT}/AppShell.tsx`;

// Der Grund, aus dem dieser Wächter im eigenen Worktree rot ist. Steht in
// jeder Meldung über eine fehlende Datei, damit niemand ihn für einen kaputten
// Test hält.
const PENDING =
  "wird parallel gebaut und fehlt in diesem Worktree noch — die Schale in D3 (#62), " +
  "die Sprachdateien unter web/src/platform/i18n/messages/ in der Sprachumschaltung (#70)";

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

const isModule = (path) => /\.tsx?$/.test(path);

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

// Alle Module unter `shell/`, Rumpf ohne Kommentare — die Grundlage der
// Zusicherungen 2 bis 5.
function readShellModules() {
  requireDirectory(SHELL_ROOT);
  const modules = collectFiles(SHELL_ROOT).filter(isModule);
  assert.ok(
    modules.length > 0,
    `Keine .ts/.tsx-Datei unter ${displayPath(SHELL_ROOT)} — der Wächter liefe ins Leere`
  );
  return modules.map((path) => ({ path, body: stripComments(readFileSync(path, "utf8")) }));
}

// ── Zusicherung 1: kein Eintrag ohne Fläche und ohne Adresse ────────────────
//
// Die Form des Verweises steht inzwischen IM VERTRAG: `navigation.ts` schreibt
// `screen: string` als Typ, und der Kommentar daneben nennt die Bedeutung —
// der Dateiname des Bildschirms OHNE Endung unter `web/src/app/screens/`. Das Feld
// wird hier deshalb BEIM NAMEN geprüft: es ist Pflicht, sein Wert ist eine
// Zeichenkette, und `<wert>.tsx` muss es unter `web/src/app/screens/` geben.
//
// ⚠️ Der Vorgänger dieser Zusicherung SUCHTE SICH das Verweisfeld selbst: er
// normalisierte jeden Feldwert jedes Eintrags und nahm dasjenige Feld, das in
// den MEISTEN Einträgen auf eine Datei unter `web/src/app/screens/` auflöste. Bei
// genau einem Eintrag gewann damit `id: "overview"` — über `OverviewScreen.tsx`
// ohne die Endung „screen" —, und `screen` wurde gar nicht mehr angesehen:
// `screen: "ContainersScreen"`, eine Fläche, die es nicht gibt, blieb GRÜN,
// 8 von 8. Ein Wächter, der rät, war zum Zeitpunkt seiner Entstehung richtig,
// weil die Form noch offen war; jetzt ist sie es nicht mehr. Mit der Erratung
// fallen `normalizeReference`, `screenIdentities` und `referenceCandidates`
// weg — sie hatten keinen anderen Zweck.

// Die Namen der Pflichtfelder. Stehen als Konstanten da, weil sie in der
// Meldung und in der Prüfung dieselben sein müssen.
const SCREEN_FIELD = "screen";

// ⚠️ Seit D6b (#62) ist der Pfad genauso Pflicht wie die Fläche: ein Eintrag
// ohne ihn hätte keine Adresse, unter der sein Bildschirm stünde, und die
// Seitenleiste zeichnete einen Verweis ins Nichts. Geprüft wird nur die FORM
// (eine schlichte Zeichenkette mit führendem „/") — ob es zu diesem Pfad eine
// Route gibt und ob er einmalig ist, prüft
// `web/tests/screen-switching.test.mjs`, weil dafür die Routentabelle daneben
// liegen muss.
const PATH_FIELD = "path";

// Der Wert eines `screen`-Feldes, wenn er eine schlichte Zeichenkette ist —
// sonst `null`. Ein Bezeichner, ein Template mit `${…}` oder ein
// zusammengesetzter Ausdruck lässt sich nicht auf eine Datei auflösen; das ist
// ein Befund und kein stiller Durchlass.
function screenLiteral(value) {
  const match = /^\s*(["'])([^"'`\n]*)\1\s*$/.exec(value);
  return match === null ? null : match[2];
}

// Die vorhandenen Bildschirme, relativ zu `SCREENS_ROOT`. Gebraucht wird die
// Liste nur noch für die Gegenrichtung als DIAGNOSE — geprüft wird gegen die
// Datei, die `screen` benennt, nicht gegen einen Index.
function readScreenFiles() {
  requireDirectory(SCREENS_ROOT);
  const files = collectFiles(SCREENS_ROOT)
    .filter(isModule)
    .map((path) => path.slice(SCREENS_ROOT.length + 1));
  assert.ok(
    files.length > 0,
    `Keine .ts/.tsx-Datei unter ${displayPath(SCREENS_ROOT)} — der Wächter liefe ins Leere`
  );
  return files;
}

// Die Objekte der obersten Ebene innerhalb eines Array-Literals — also die
// Einträge der Navigationsliste. Die Bedingung „innerhalb einer eckigen
// Klammer" hält Typdeklarationen (`type NavigationItem = { … }`) heraus, die
// sonst als Eintrag ohne Fläche gemeldet würden.
function collectArrayElementObjects(body) {
  const found = [];
  let quote = null;
  let bracketDepth = 0;
  let braceDepth = 0;
  let start = -1;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote !== null) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") quote = character;
    else if (character === "[") bracketDepth += 1;
    else if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (character === "{") {
      if (braceDepth === 0 && bracketDepth > 0) start = index;
      braceDepth += 1;
    } else if (character === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      if (braceDepth === 0 && start !== -1) {
        found.push({ text: body.slice(start, index + 1), start });
        start = -1;
      }
    }
  }
  return found;
}

// Die Felder der obersten Ebene eines Eintrags, jeweils mit ihrem Wert als
// Text. Quotenbewusst und klammerzählend, damit ein `,` in einem
// verschachtelten Aufruf keinen neuen Feldnamen erfindet.
function collectFields(entryText) {
  const fields = [];
  let quote = null;
  let depth = 0;
  let index = 0;
  let pending = null;
  let valueStart = -1;

  const flush = (end) => {
    if (pending === null) return;
    fields.push({ name: pending.name, nameIndex: pending.index, value: entryText.slice(valueStart, end) });
    pending = null;
  };

  while (index < entryText.length) {
    const character = entryText[index];
    if (quote !== null) {
      if (character === "\\") index += 2;
      else {
        if (character === quote) quote = null;
        index += 1;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      index += 1;
      continue;
    }
    if (character === "{" || character === "[" || character === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === "}" || character === "]" || character === ")") {
      depth -= 1;
      if (depth === 0) {
        flush(index);
        break;
      }
      index += 1;
      continue;
    }
    if (depth === 1 && character === ",") {
      flush(index);
      index += 1;
      continue;
    }
    if (depth === 1 && pending === null) {
      const match = /^["']?([A-Za-z_$][\w$-]*)["']?\s*:/.exec(entryText.slice(index));
      if (match !== null) {
        pending = { name: match[1], index };
        index += match[0].length;
        valueStart = index;
        continue;
      }
    }
    index += 1;
  }
  return fields;
}

test("kein Navigationseintrag ohne Fläche unter web/src/app/screens und ohne Pfad", (t) => {
  const screenFiles = readScreenFiles();
  const source = stripComments(readOrFail(NAVIGATION_PATH));
  const entries = collectArrayElementObjects(source);

  assert.ok(
    entries.length > 0,
    `${displayPath(NAVIGATION_PATH)} trägt keinen einzigen Listeneintrag — der Wächter liefe ins Leere`
  );

  const findings = [];
  const referenced = new Set();

  for (const entry of entries) {
    // Jede Meldung nennt DATEI UND FELD: wer den Wächter rot sieht, soll ohne
    // Nachdenken wissen, wo er nachsieht.
    const place = `${displayPath(NAVIGATION_PATH)}:${lineOf(source, entry.start)}`;
    const fields = collectFields(entry.text);

    // ⚠️ Der Pfad ZUERST und ohne `continue`: er ist unabhängig von der Fläche,
    // und ein Eintrag, dem beides fehlt, soll beides gemeldet bekommen. Wer nur
    // die eine Hälfte erfährt, repariert und läuft in die zweite.
    const pathField = fields.find((candidate) => candidate.name === PATH_FIELD);
    if (pathField === undefined) {
      const seen = fields.map((candidate) => candidate.name).join(", ");
      findings.push(
        `${place}: Pflichtfeld „${PATH_FIELD}" fehlt in diesem Eintrag — JEDER Eintrag in ` +
          `${displayPath(NAVIGATION_PATH)} trägt seine Adresse selbst, und die Routentabelle liest ` +
          `sie dort. Gelesene Felder: ${seen === "" ? "(keine)" : seen}`
      );
    } else {
      const pathLiteral = screenLiteral(pathField.value);
      if (pathLiteral === null) {
        findings.push(
          `${place}: Feld „${PATH_FIELD}" trägt keine schlichte Zeichenkette, sondern ` +
            `„${pathField.value.trim()}" — ein zusammengesetzter Pfad lässt sich weder gegen die ` +
            "Routentabelle noch gegen einen zweiten Pfad halten"
        );
      } else if (!pathLiteral.startsWith("/")) {
        findings.push(
          `${place}: Feld „${PATH_FIELD}" = „${pathLiteral}" — ein Pfad der Anwendung beginnt mit ` +
            `einem Schrägstrich. Ohne ihn löst der Router den Pfad RELATIV zur gerade offenen ` +
            `Adresse auf, und derselbe Eintrag führte je nach Standort woandershin`
        );
      }
    }

    const field = fields.find((candidate) => candidate.name === SCREEN_FIELD);

    if (field === undefined) {
      const seen = fields.map((candidate) => candidate.name).join(", ");
      findings.push(
        `${place}: Pflichtfeld „${SCREEN_FIELD}" fehlt in diesem Eintrag — JEDER Eintrag in ` +
          `${displayPath(NAVIGATION_PATH)} muss „${SCREEN_FIELD}" tragen (der Dateiname unter ` +
          `${displayPath(SCREENS_ROOT)} ohne Endung). Gelesene Felder: ${seen === "" ? "(keine)" : seen}`
      );
      continue;
    }

    const literal = screenLiteral(field.value);
    if (literal === null) {
      findings.push(
        `${place}: Feld „${SCREEN_FIELD}" trägt keine schlichte Zeichenkette, sondern ` +
          `„${field.value.trim()}" — nur ein Dateiname lässt sich auf eine Fläche auflösen`
      );
      continue;
    }

    // Die Form des Wertes: ein Dateiname ohne Endung, kein Ausbruch aus
    // `web/src/app/screens/`. Ein Wert mit `.tsx` oder mit `..` würde unten zwar
    // vielleicht existieren, wäre aber nicht das, was der Vertrag beschreibt.
    const invalid =
      literal === "" ||
      literal.includes("\\") ||
      /\.(tsx?|jsx?)$/i.test(literal) ||
      literal.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
    if (invalid) {
      findings.push(
        `${place}: Feld „${SCREEN_FIELD}" = „${literal}" ist kein Dateiname ohne Endung unter ` +
          `${displayPath(SCREENS_ROOT)} — erwartet wird etwa „OverviewScreen", nicht ein leerer ` +
          "Wert, ein Ausbruch aus dem Verzeichnis oder ein Name mit Endung"
      );
      continue;
    }

    const relative = `${literal}.tsx`;
    if (!existsSync(`${SCREENS_ROOT}/${relative}`)) {
      findings.push(
        `${place}: Feld „${SCREEN_FIELD}" = „${literal}" — die Fläche ` +
          `${displayPath(SCREENS_ROOT)}/${relative} gibt es nicht`
      );
      continue;
    }
    referenced.add(relative);
  }

  // Die Gegenrichtung wird gemeldet, aber NIE erzwungen: `SetupScreen` und
  // `SignInScreen` gehören nie in die Navigation, und seit D6b (#62) gibt es
  // dazu die Detailflächen — die Stack-Seite, „Mein Konto", „Einstellungen" —,
  // die als Route OHNE Eintrag stehen. Dass jede ROUTE eine Fläche hat, prüft
  // `web/tests/screen-switching.test.mjs`.
  const unreferenced = screenFiles.filter((relative) => !referenced.has(relative));
  if (unreferenced.length > 0) {
    t.diagnostic(
      `Bildschirm ohne Navigationseintrag (kein Fehler — SetupScreen und SignInScreen gehören ` +
        `nie in die Navigation, Detailflächen stehen als Route ohne Eintrag): ${unreferenced.join(", ")}`
    );
  }

  assert.deepEqual(
    findings,
    [],
    `Navigationseintrag ohne Fläche oder ohne Pfad. „Einträge, die es noch nicht gibt, erscheinen ` +
      `nicht" — ein Eintrag wartet nicht auf seinen Bildschirm, er entsteht mit ihm:\n${findings.join("\n")}`
  );
});

// ── Zusicherung 2: kein sichtbarer Text in der Schale ───────────────────────
//
// Die Felder, die sichtbaren Text tragen. Bewusst eine Liste und kein „jede
// Zeichenkette mit einem Leerzeichen": `className="flex items-center gap-2"`
// wäre sonst ein Fehlalarm, und ein Fehlalarm ist hier teurer als eine Lücke —
// wer ihn trifft, hat zwei Auswege, den Code verbiegen oder den Wächter
// lockern, und der zweite kostet die Regel.
const TEXT_FIELDS = [
  "label", "title", "description", "heading", "subtitle", "summary",
  "hint", "tooltip", "caption", "placeholder", "alt", "text", "message",
  "ariaLabel", "aria-label"
];

// Trifft `label: "Übersicht"` ebenso wie `label="Übersicht"` und
// `label={"Übersicht"}` — der Doppelpunkt ist die Objektform der
// Navigationsdaten, das Gleichheitszeichen die JSX-Form.
const HARDCODED_TEXT = new RegExp(
  `(?<![\\w$.-])(${TEXT_FIELDS.join("|")})\\s*[:=]\\s*\\{?\\s*(["'])([^"'\\n]*)\\2`,
  "g"
);

// Der zweite Fühler, unabhängig von der Feldliste: eine Zeichenkette mit
// Umlaut oder ß ist im Quelltext dieser Schale praktisch immer sichtbarer
// Text. Klassennamen, Modulpfade und `data-area`-Werte tragen so etwas nie.
const GERMAN_STRING = /(["'`])([^"'`\n]*[äöüÄÖÜß][^"'`\n]*)\1/g;

const CONTAINS_LETTER = /\p{L}/u;

// Das Feld, das den Text ERSETZT. Die Navigationsdaten stehen auf Modulebene
// und können `useTranslations()` nicht rufen — ein Hook läuft nur in einer
// Komponente. Sie tragen deshalb einen Schlüssel, und die Seitenleiste schickt
// ihn beim Zeichnen durch `t()`.
const LABEL_KEY_FIELD = "labelKey";

// `labelKey: "navOverview"` in den Navigationsdaten, `labelKey="navOverview"`
// in der JSX-Form. Beide Schreibweisen, wie bei `HARDCODED_TEXT` — die
// Rückschau hält `defaultLabelKey` und `item.labelKey` heraus.
const LABEL_KEY_VALUE = new RegExp(
  `(?<![\\w$.-])${LABEL_KEY_FIELD}\\s*[:=]\\s*\\{?\\s*(["'])([^"'\`\\n]*)\\1`,
  "g"
);

// ── Die Schlüssel einer Sprachdatei ─────────────────────────────────────────
//
// ⚠️ Gelesen wird der TEXT der Datei, nicht das Modul. Dieser Wächter läuft als
// `.mjs` unter `node --test` und kann `de.ts` nicht importieren — es gibt in
// diesem Repo keinen Übersetzungsschritt für Tests, und einen dafür
// einzuführen hieße, die Prüfkette von einem Bauwerkzeug abhängig zu machen,
// das genau das prüfen soll.
//
// Der Anfang wird mit einem Muster gesucht, das ENDE durch Zählen der
// Klammern — quotenbewusst, damit eine geschweifte Klammer INNERHALB eines
// Textes („{0} Container") das Literal nicht vorzeitig schließt. Die Felder
// holt derselbe `collectFields()`, der auch die Navigationseinträge zerlegt:
// zwei Zerleger für dieselbe Form liefen irgendwann auseinander.
//
// Grenze, ehrlich benannt: gelesen wird die OBERSTE Ebene eines flachen
// Objektliterals. Verschachtelte Gruppen (`nav: { overview: "…" }`) wären
// damit ein Schlüssel `nav` statt `nav.overview`. Entsteht diese Form eines
// Tages, gehört sie hier ergänzt — bis dahin ist die Sprachdatei flach, und
// eine geratene Auflösung wäre schlechter als eine benannte Lücke.
const MESSAGES_DECLARATION = /\bexport\s+const\s+[A-Za-z_$][\w$]*\s*(?::[^=;]*)?=\s*\{/;

function messagesLiteral(source) {
  const start = MESSAGES_DECLARATION.exec(source);
  if (start === null) return null;
  const open = start.index + start[0].length - 1;
  let depth = 0;
  let quote = null;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return null;
}

function readMessageKeys(path) {
  const body = stripComments(readOrFail(path));
  const literal = messagesLiteral(body);
  // ⚠️ Der Erkenner darf nicht dadurch grün werden, dass er nichts gelesen
  // hat. Findet er das Objektliteral nicht, ist JEDER `labelKey` unbekannt —
  // die Meldung sagt deshalb, dass der WÄCHTER nichts sieht, und nicht, dass
  // die Schlüssel falsch sind.
  assert.ok(
    literal !== null,
    `${displayPath(path)} trägt kein lesbares „export const … = { … }" — der Wächter kann ` +
      "die Schlüssel nicht lesen und prüft damit nichts. Erwartet wird ein Objektliteral " +
      "auf Modulebene, kein über eine Funktion zusammengesetztes."
  );
  const keys = collectFields(literal).map((field) => field.name);
  assert.ok(
    keys.length > 0,
    `${displayPath(path)} führt keinen einzigen Schlüssel — der Wächter liefe ins Leere`
  );
  return new Set(keys);
}

test("kein sichtbarer Text steht fest in der Schale", () => {
  // Zuerst die Sprachdatei: fehlt sie, soll die Meldung SIE nennen und nicht
  // eine Liste unbekannter Schlüssel.
  const messageKeys = readMessageKeys(MESSAGES_DE_PATH);
  const findings = [];
  let labelKeys = 0;

  for (const module of readShellModules()) {
    const name = displayPath(module.path);

    for (const match of module.body.matchAll(HARDCODED_TEXT)) {
      if (!CONTAINS_LETTER.test(match[3])) continue;
      findings.push(
        `${name}:${lineOf(module.body, match.index)}: ${match[1]} = „${match[3]}" — ` +
          `sichtbarer Text steht in ${displayPath(MESSAGES_DE_PATH)}`
      );
    }

    for (const match of module.body.matchAll(GERMAN_STRING)) {
      const place = `${name}:${lineOf(module.body, match.index)}`;
      if (findings.some((finding) => finding.startsWith(`${place}: `))) continue;
      findings.push(
        `${place}: Zeichenkette „${match[2]}" — deutscher Text gehört nach ` +
          `${displayPath(MESSAGES_DE_PATH)}`
      );
    }

    // Jeder gesetzte `labelKey` muss ein Schlüssel sein, den die Sprachdatei
    // führt. ⚠️ Der Typcheck sagt dazu heute schon etwas: `labelKey` ist ein
    // `TranslationKey`, und ein Tippfehler ist TS2820 mit „Did you mean".
    // Diese Prüfung hängt hier trotzdem an keinem Typ — geht die Deckung
    // verloren (Feld als `string`, ein `as`), gibt `use-intl` zur Laufzeit den
    // Schlüssel selbst zurück, und in der Seitenleiste steht der Schlüssel
    // statt des Wortes.
    const values = [...module.body.matchAll(LABEL_KEY_VALUE)];
    labelKeys += values.length;
    for (const match of values) {
      if (messageKeys.has(match[2])) continue;
      findings.push(
        `${name}:${lineOf(module.body, match.index)}: ${LABEL_KEY_FIELD} = „${match[2]}" — ` +
          `${displayPath(MESSAGES_DE_PATH)} führt diesen Schlüssel nicht`
      );
    }

    // Die Gegenprobe zum Erkenner oben: ein `labelKey`, hinter dem KEINE
    // schlichte Zeichenkette steht (`labelKey: prefix + name`), fällt durch
    // `LABEL_KEY_VALUE` und wäre sonst ein STILLER Durchlass — die Sorte
    // Lücke, die einen Wächter grün hält, während die Regel bricht.
    //
    // ⚠️ Geprüft wird STRUKTURELL, über die Listeneinträge, und nicht über
    // eine zweite Zählung von „labelKey" im Text. Eine Textzählung träfe die
    // Typdeklaration `type NavigationItem = { labelKey: string }` mit — dort
    // steht das Feld völlig richtig ohne Zeichenkette, und der Wächter wäre
    // auf der ersten Zeile jeder korrekten Umsetzung rot. `collectArrayElementObjects`
    // sieht nur Objekte INNERHALB einer eckigen Klammer und lässt die
    // Typdeklaration damit aus, genau wie bei Zusicherung 1.
    for (const entry of collectArrayElementObjects(module.body)) {
      const field = collectFields(entry.text).find((candidate) => candidate.name === LABEL_KEY_FIELD);
      if (field === undefined) continue;
      // Derselbe Leser wie für `screen`: eine schlichte Zeichenkette oder
      // `null`. Ein Bezeichner oder ein Template mit `${…}` lässt sich nicht
      // gegen die Sprachdatei halten.
      if (screenLiteral(field.value) !== null) continue;
      findings.push(
        `${name}:${lineOf(module.body, entry.start)}: Feld „${LABEL_KEY_FIELD}" trägt keine ` +
          `schlichte Zeichenkette, sondern „${field.value.trim()}" — ein zusammengesetzter ` +
          `Schlüssel lässt sich nicht gegen ${displayPath(MESSAGES_DE_PATH)} halten und ist ` +
          "damit ungeprüft"
      );
    }
  }

  // ⚠️ Die Fundstellen ZUERST, die Leerlaufsperre danach. Umgekehrt verdeckte
  // die Sperre den genaueren Befund: ein `labelKey: buildKey(id)` liefert
  // beides — eine Fundstelle UND null lesbare Schlüssel —, und die Meldung
  // „kein einziges labelKey" schickte den Leser dann an die falsche Stelle.
  assert.deepEqual(
    findings,
    [],
    "Sichtbarer Text in der Schale. ui-texts.test.mjs sieht JSX-Textknoten und vier " +
      "Attribute; die Navigationsdaten sind eine Liste von Objekten und fallen dort durch — " +
      `der Zugang ist: labelKey: „…" in den Daten, t(„…") aus useTranslations() beim ` +
      `Zeichnen:\n${findings.join("\n")}`
  );

  // Der Wächter darf nicht dadurch grün werden, dass die Schale gar keine
  // Beschriftungen mehr trägt: `navigation.ts` führt jeden Eintrag mit einem
  // `labelKey`, sonst hätte die Seitenleiste nichts zu zeichnen.
  assert.ok(
    labelKeys > 0,
    `Kein einziges „${LABEL_KEY_FIELD}" unter ${displayPath(SHELL_ROOT)} — die Navigationsdaten ` +
      "stehen auf Modulebene und tragen ihren Text als Schlüssel (#70). Steht dort wieder ein " +
      "fertiger Text, prüft diese Zusicherung ihn nicht mehr gegen die Sprachdatei."
  );
});

// ── Zusicherung 3: die Schale setzt die Achse ───────────────────────────────

// Die erlaubten Werte werden AUS `palette.css` gelesen. Eine abgeschriebene
// Liste liefe irgendwann neben der Palette her, und dann wäre entweder der
// Wächter falsch oder die Farbe.
const AREA_IN_PALETTE = /\[data-area\s*=\s*(["'])([^"']+)\1\]/g;
// Die beiden optionalen Anführungszeichen um den Namen sind kein Zierrat: als
// Objektschlüssel muss `data-area` zitiert werden (`{ "data-area": "…" }`),
// als JSX-Attribut nicht.
const AREA_IN_CODE = /(?<![\w-])["']?data-area["']?\s*[:=]\s*\{?\s*(["'`])([^"'`\n]*)\1/g;
const AREA_MENTION = /(?<![\w-])data-area(?![\w-])/g;

// ⚠️ Seit D6b (#62) hängt der Bereich an der ADRESSE: `AppShell.tsx` setzt
// `data-area={areaForPath(pathname)}` — ein Bezeichner, keine Zeichenkette.
// `AREA_IN_CODE` verlangt hinter `data-area` sofort ein Anführungszeichen und
// sieht einen Bezeichner deshalb GAR NICHT — nicht als Fund, aber auch nicht
// als Freispruch. Ohne diese Ergänzung bliebe die Zusicherung grün, obwohl sie
// den tatsächlich möglichen Wert nie gegen `palette.css` hält, und genau DAS
// ist der Fall, den die Zusicherung ihrem eigenen Namen nach prüfen soll. Die
// Werte, die `areaForPath` (`web/src/app/shell/navigation.ts`) zurückgeben kann,
// stehen dort an zwei Stellen: als Feld `area:` an jedem Eintrag von
// `navigationItems`, und — für die Adressen ohne Eintrag — als WERT in der
// Zuordnung `managementPaths` (`Record<string, AreaId>`, Schlüssel ist der
// Pfad). Zwei Muster, weil die zweite Stelle keinen Feldnamen „area" trägt.
const AREA_FIELD_VALUE = /(?<![\w-])area\s*:\s*(["'`])([^"'`\n]*)\1/g;
// Schlüssel: ein unter Anführungszeichen stehender Pfad („/…"). So bleibt das
// Muster an eine ADRESSE gebunden und liest nicht jedes beliebige
// Zeichenketten-Paar unter `shell/` mit — geprüft ist nur, was heute unter
// `web/src/app/shell/` als Pfad-Schlüssel vorkommt: `managementPaths`.
const AREA_PATH_MAP_VALUE = /(["'`])\/[^"'`\n]*\1\s*:\s*(["'`])([^"'`\n]*)\2/g;

test("die Schale setzt data-area, und jeder Wert steht in palette.css", () => {
  const palette = readOrFail(PALETTE_PATH);
  const allowed = new Set([...palette.matchAll(AREA_IN_PALETTE)].map((match) => match[2]));
  assert.ok(
    allowed.size > 0,
    `${displayPath(PALETTE_PATH)} vergibt keinen einzigen [data-area="…"]-Wert — der Wächter liefe ins Leere`
  );

  const modules = readShellModules();
  const mentions = modules.reduce((sum, module) => sum + [...module.body.matchAll(AREA_MENTION)].length, 0);

  const findings = [];
  for (const module of modules) {
    for (const match of module.body.matchAll(AREA_IN_CODE)) {
      if (allowed.has(match[2])) continue;
      findings.push(
        `${displayPath(module.path)}:${lineOf(module.body, match.index)}: data-area="${match[2]}" — ` +
          `${displayPath(PALETTE_PATH)} kennt nur: ${[...allowed].sort().join(", ")}`
      );
    }
    for (const match of module.body.matchAll(AREA_FIELD_VALUE)) {
      if (allowed.has(match[2])) continue;
      findings.push(
        `${displayPath(module.path)}:${lineOf(module.body, match.index)}: area: "${match[2]}" — ` +
          `${displayPath(PALETTE_PATH)} kennt nur: ${[...allowed].sort().join(", ")}`
      );
    }
    for (const match of module.body.matchAll(AREA_PATH_MAP_VALUE)) {
      if (allowed.has(match[3])) continue;
      findings.push(
        `${displayPath(module.path)}:${lineOf(module.body, match.index)}: "…": "${match[3]}" — ` +
          `${displayPath(PALETTE_PATH)} kennt nur: ${[...allowed].sort().join(", ")}`
      );
    }
  }

  assert.ok(
    mentions > 0,
    `Kein einziges „data-area" unter ${displayPath(SHELL_ROOT)} — die Schale trägt die Achse ` +
      "(docs/design/hub-color-and-structure.md, Abschnitt 1), sonst bleibt jede Fläche ohne Ton"
  );
  assert.deepEqual(findings, [], `data-area-Wert außerhalb der Palette:\n${findings.join("\n")}`);
});

// ── Zusicherung 4: kein Rückfall auf die Tailwind-Grundpalette ──────────────

const TAILWIND_COLORS = [
  "slate", "gray", "zinc", "neutral", "stone",
  "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal",
  "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose"
];

// Die Utilities, die eine Farbe tragen. Ohne diese Liste UND ohne die
// Zahlenstufe griffe das Muster zu weit: `text-sm`, `border-2` und `bg-card`
// dürfen NICHT anspringen — `bg-card` ist genau der richtige Weg.
const COLOR_UTILITIES = [
  "text", "bg", "border", "ring", "ring-offset", "outline", "fill", "stroke",
  "shadow", "decoration", "divide", "accent", "caret", "placeholder",
  "from", "via", "to", "selection"
];

// Optional davor: Varianten (`hover:`, `dark:`, `md:`), ein `!` für wichtig
// und ein `-` für negative Utilities. Dahinter optional eine Deckung
// (`/50`). Die Zahlenstufe ist Pflicht — sie ist das, was eine Farbe der
// Grundpalette von einem Token unterscheidet.
const BASE_PALETTE_CLASS = new RegExp(
  `(?<![\\w-])(?:[a-z][a-z0-9-]*:)*!?-?(?:${COLOR_UTILITIES.join("|")})-` +
    `(?:${TAILWIND_COLORS.join("|")})-\\d{2,3}(?:\\/\\d{1,3})?(?![\\w-])`,
  "g"
);

test("kein Rückfall auf die Tailwind-Grundpalette in der Schale", () => {
  const findings = [];

  for (const module of readShellModules()) {
    for (const match of module.body.matchAll(BASE_PALETTE_CLASS)) {
      findings.push(
        `${displayPath(module.path)}:${lineOf(module.body, match.index)}: „${match[0]}" — ` +
          "die Schale nimmt die Token aus web/src/platform/theme/"
      );
    }
  }

  assert.deepEqual(
    findings,
    [],
    "Farbe der Tailwind-Grundpalette in der Schale. Sie steht neben dem Tokensystem und " +
      `folgt weder Ton noch Sättigung des Hosts:\n${findings.join("\n")}`
  );
});

// ── Zusicherung 5: keine externe Quelle ─────────────────────────────────────

const EXTERNAL_SOURCE = /(?<![\w$.-])(src|href)\s*[:=]\s*\{?\s*(["'`])\s*(https?:\/\/[^"'`\s]*)/g;

test("keine externe Quelle in der Schale", () => {
  const findings = [];

  for (const module of readShellModules()) {
    for (const match of module.body.matchAll(EXTERNAL_SOURCE)) {
      findings.push(
        `${displayPath(module.path)}:${lineOf(module.body, match.index)}: ${match[1]}="${match[3]}"`
      );
    }
  }

  assert.deepEqual(
    findings,
    [],
    "Externer Verweis in der Schale. Die CSP des Hubs ist `default-src 'self'` — das lädt " +
      `nicht, es fehlt einfach:\n${findings.join("\n")}`
  );
});

// ── Zusicherung 6: TooltipProvider an der Wurzel ────────────────────────────

const TOOLTIP_ELEMENT = /<\s*TooltipProvider(?![\w$])/;
const TOOLTIP_IMPORT = /import[^;]*?(?<![\w$])TooltipProvider(?![\w$])[^;]*?from\s*["'][^"']+["']/s;

test("AppShell benutzt den TooltipProvider", () => {
  const body = stripComments(readOrFail(APP_SHELL_PATH));
  const name = displayPath(APP_SHELL_PATH);
  const findings = [];

  const element = TOOLTIP_ELEMENT.exec(body);
  if (element === null) {
    findings.push(`${name}: kein <TooltipProvider> — der Baustein „tooltip" verlangt ihn um die Anwendung`);
  }

  const imported = TOOLTIP_IMPORT.exec(body);
  if (imported === null) {
    findings.push(`${name}: „TooltipProvider" wird nirgends importiert`);
  }

  assert.deepEqual(
    findings,
    [],
    `Der übernommene Baustein „tooltip" verlangt laut Registry, dass die Anwendung im ` +
      `TooltipProvider liegt — ohne ihn öffnet kein Tooltip:\n${findings.join("\n")}`
  );
});

// ── Selbsttest der Erkenner ─────────────────────────────────────────────────
//
// Ein Wächter ohne eigenen Test ist eine Behauptung, und die teure Hälfte
// dieses Wächters sind nicht die Fundstellen, sondern die Nicht-Fundstellen:
// ein Muster, das zu weit greift, meldet gewöhnlichen Code als Befund. Die
// Fälle unten sind deshalb beides — die Lücke UND der Fehlalarm. Sie laufen
// ohne `web/src/app/shell/` und sind der Grund, warum dieser Test grün ist,
// während die sechs oben auf D3 warten.
test("der Erkenner selbst: was er fangen muss und was nicht", () => {
  const cases = [
    // [Muster, Beschreibung, Quelltext, soll gefunden werden]
    [HARDCODED_TEXT, "fester Text im Objektfeld", `label: "Übersicht",`, true],
    [HARDCODED_TEXT, "fester Text im JSX-Attribut", `<a title="Abmelden" />`, true],
    [HARDCODED_TEXT, "Sprachschlüssel", "label: texts.navOverview,", false],
    [HARDCODED_TEXT, "Sprachschlüssel im JSX", "<a title={texts.signOut} />", false],
    [HARDCODED_TEXT, "gleichnamiges Teilwort", `dataLabel: "x"`, false],
    // ⚠️ `labelKey` darf NICHT als fester Text gemeldet werden — er ist die
    // vorgeschriebene Form. Ohne diesen Fall wäre die Umstellung auf #70 ein
    // Fehlalarm auf jeder einzelnen Navigationszeile.
    [HARDCODED_TEXT, "Schlüsselfeld ist kein Textfeld", `labelKey: "navOverview",`, false],

    [LABEL_KEY_VALUE, "Schlüssel im Objektfeld", `labelKey: "navOverview",`, true],
    [LABEL_KEY_VALUE, "Schlüssel im JSX-Attribut", `<Item labelKey="navOverview" />`, true],
    [LABEL_KEY_VALUE, "Schlüssel in geschweifter Klammer", `<Item labelKey={"navOverview"} />`, true],
    [LABEL_KEY_VALUE, "zusammengesetzter Schlüssel", "labelKey: prefix + name,", false],
    [LABEL_KEY_VALUE, "Zugriff statt Zuweisung", "const key = item.labelKey;", false],
    // ⚠️ Die Typdeklaration ist KEINE Fundstelle: `labelKey: string` trägt
    // keinen Schlüssel, sondern seine Form. Meldete der Erkenner sie, wäre er
    // auf jeder korrekten Umsetzung rot.
    [LABEL_KEY_VALUE, "Typdeklaration", "type NavigationItem = { labelKey: string };", false],

    [GERMAN_STRING, "deutsche Zeichenkette", `const a = "Größe";`, true],
    [GERMAN_STRING, "Klassenliste ohne Umlaut", `className="flex items-center gap-2"`, false],

    [AREA_IN_CODE, "Achse im JSX", `<div data-area="operations">`, true],
    [AREA_IN_CODE, "Achse im Objekt", `{ "data-area": "management" }`, true],
    [AREA_IN_CODE, "Achse in geschweifter Klammer", `<div data-area={"operations"}>`, true],

    [BASE_PALETTE_CLASS, "Grundpalette", `className="text-slate-500"`, true],
    [BASE_PALETTE_CLASS, "Grundpalette am Rand", `className="border-gray-200"`, true],
    [BASE_PALETTE_CLASS, "Grundpalette mit Variante", `className="dark:hover:bg-red-600"`, true],
    [BASE_PALETTE_CLASS, "Grundpalette mit Deckung", `className="bg-blue-500/50"`, true],
    [BASE_PALETTE_CLASS, "Schriftgröße", `className="text-sm"`, false],
    [BASE_PALETTE_CLASS, "Rahmenbreite", `className="border-2"`, false],
    [BASE_PALETTE_CLASS, "Token", `className="bg-card text-muted-foreground"`, false],
    [BASE_PALETTE_CLASS, "Tonvorrat der Palette", `<div data-hue="neutral">`, false],
    [BASE_PALETTE_CLASS, "Prosa", "const a = 1; // ein Ton wie slate", false],

    [EXTERNAL_SOURCE, "externes Logo", `<img src="https://example.com/logo.svg" />`, true],
    [EXTERNAL_SOURCE, "externer Verweis", `<a href="http://example.com">`, true],
    [EXTERNAL_SOURCE, "eigenes Bild", `<img src="/logo.svg" />`, false],
    [EXTERNAL_SOURCE, "Sprungmarke", `<a href="#main">`, false],

    [TOOLTIP_ELEMENT, "Element", "<TooltipProvider>{children}</TooltipProvider>", true],
    [TOOLTIP_ELEMENT, "nur der Name", "const a = TooltipProviderProps;", false],
    [TOOLTIP_IMPORT, "Import", `import { Tooltip, TooltipProvider } from "../../platform/ui/shadcn/tooltip";`, true],
    [TOOLTIP_IMPORT, "anderer Baustein", `import { Tooltip } from "../../platform/ui/shadcn/tooltip";`, false]
  ];

  const findings = [];
  for (const [pattern, description, source, expected] of cases) {
    // ⚠️ Ein globales Muster trägt `lastIndex` von Aufruf zu Aufruf mit sich.
    // Ohne das Zurücksetzen fiele jeder zweite Fall falsch aus.
    if (pattern.global) pattern.lastIndex = 0;
    const found = pattern.test(source);
    if (pattern.global) pattern.lastIndex = 0;
    if (found !== expected) {
      findings.push(`${description}: „${source}" ${found ? "wurde gemeldet" : "wurde nicht gemeldet"}`);
    }
  }

  assert.deepEqual(findings, [], `Der Erkenner trifft nicht, was er treffen soll:\n${findings.join("\n")}`);
});

// Der Zerleger der Navigationsliste, ebenfalls ohne `shell/` prüfbar. Er ist
// die Stelle, an der Zusicherung 1 stillschweigend scheitern könnte: findet er
// keine Einträge, meldet er nichts — deshalb hat er einen eigenen Fall.
test("der Zerleger der Navigationsliste: Einträge und Felder", () => {
  const source = [
    "import { texts } from \"../i18n\";",
    "type NavigationItem = { label: string; screen: string };",
    "export const navigation: NavigationItem[] = [",
    "  { label: texts.navOverview, path: \"/\", screen: \"OverviewScreen\", icon: Gauge },",
    "  { label: texts.navContainers, path: \"/containers\", screen: \"ContainersScreen\", badge: { tone: \"muted\" } }",
    "];"
  ].join("\n");

  const entries = collectArrayElementObjects(source);
  assert.equal(entries.length, 2, "Die Typdeklaration darf nicht als Eintrag zählen");
  assert.equal(lineOf(source, entries[0].start), 4);

  const fields = collectFields(entries[1].text);
  assert.deepEqual(
    fields.map((field) => field.name),
    ["label", "path", "screen", "badge"],
    "Das `,` im verschachtelten Objekt darf keinen Feldnamen erfinden"
  );

  // Der Wert eines Pflichtfeldes wird als Zeichenkette gelesen, und NUR als
  // solche: ein Sprachschlüssel (`texts.navContainers`) ist kein Dateiname und
  // fällt deshalb auf `null` — der Aufrufer meldet ihn.
  assert.equal(screenLiteral(fields[2].value), "ContainersScreen");
  assert.equal(screenLiteral(fields[0].value), null, "Ein Sprachschlüssel ist kein Dateiname");
  assert.equal(screenLiteral(' "OverviewScreen" '), "OverviewScreen", "Leerraum ringsum gehört nicht zum Wert");

  // ⚠️ Derselbe Leser liest seit D6b auch den PFAD — er liest eine schlichte
  // Zeichenkette, egal wie das Feld heißt. Der Schrägstrich darin ist keine
  // Besonderheit, und ein Pfad mit Parameter ebenso wenig: die FORM prüft der
  // Aufrufer, nicht dieser Leser.
  assert.equal(screenLiteral(fields[1].value), "/containers");
  assert.equal(screenLiteral(' "/stack/:hostId/:project" '), "/stack/:hostId/:project");
});

// Der Leser der Sprachdatei, ebenfalls ohne `web/src/platform/i18n/messages/` prüfbar.
// Er ist die Stelle, an der Zusicherung 2 stillschweigend scheitern könnte:
// liest er die Schlüssel nicht, ist JEDER `labelKey` unbekannt — und wer das
// dann repariert, repariert die falsche Seite. `readMessageKeys()` macht daraus
// deshalb eine eigene, benannte Meldung; hier steht der Beweis, dass der Leser
// die Form der Sprachdatei wirklich trifft.
test("der Leser der Sprachdatei: Schlüssel aus dem Objektliteral", () => {
  const source = [
    "// Deutsch — die erste Sprache.",
    "export const de = {",
    "  appTitle: \"Docker-Verwaltung\",",
    "  // Ein Kommentar, der einen Schlüssel nennt: erfundenerSchluessel: \"x\"",
    "  setupLead:",
    "    \"Ein langer Satz, der eine geschweifte Klammer { enthält und ein Komma, dazu.\",",
    "  navOverview: \"Übersicht\"",
    "} as const;"
  ].join("\n");

  const literal = messagesLiteral(stripComments(source));
  assert.notEqual(literal, null, "Das Objektliteral muss gefunden werden");

  assert.deepEqual(
    collectFields(literal).map((field) => field.name),
    ["appTitle", "setupLead", "navOverview"],
    "Ein Kommentar erfindet keinen Schlüssel, eine geschweifte Klammer im Text schließt " +
      "das Literal nicht, und ein Wert auf der nächsten Zeile gehört zu seinem Schlüssel"
  );

  // ⚠️ Benannte Grenze, gemessen und nicht vermutet: `collectFields()` liest
  // einen ZITIERTEN Schlüssel (`"quoted-key": "…"`) NICHT. Der Zerleger sieht
  // das Anführungszeichen zuerst und behandelt es als Zeichenkette, bevor er
  // nach einem Feldnamen sucht. Das steht hier als Fall, damit es eine
  // Zusage ist und keine Überraschung — und es fällt in die sichere Richtung:
  // ein zitierter Schlüssel in der Sprachdatei fehlt der Menge, ein `labelKey`
  // darauf wird als unbekannt GEMELDET. Falscher Alarm, kein stiller
  // Durchlass. Wer zitierte Schlüssel braucht, erweitert `collectFields()` —
  // dieselbe Funktion zerlegt die Navigationseinträge, deshalb nicht nebenbei.
  assert.deepEqual(
    collectFields('{ "quoted-key": "Wert", plain: "Wert" }').map((field) => field.name),
    ["plain"],
    "Ein zitierter Schlüssel bleibt ungelesen — bekannte Grenze, in die sichere Richtung"
  );

  // Die Gegenprobe: eine Sprachdatei, die ihr Objekt nicht auf Modulebene
  // hinschreibt, ist für diesen Leser NICHT lesbar — und das muss `null`
  // ergeben und nicht eine leere, grüne Schlüsselmenge.
  assert.equal(
    messagesLiteral("export const de = buildMessages();"),
    null,
    "Ein zusammengesetztes Objekt ist kein lesbares Literal"
  );
});
