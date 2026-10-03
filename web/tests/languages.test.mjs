import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { messageRoots } from "./message-roots.mjs";
import { stripComments } from "./strip-comments.mjs";

// Wächter über die Sprachschicht (#70): zwei Sprachen, Deutsch und Englisch,
// über `use-intl`, mit der Sprache je Benutzer im Konto.
//
// Die Dateien, die hier geprüft werden, entstehen in ANDEREN Bauabschnitten,
// parallel zu diesem Wächter. Solange sie fehlen, MUSS dieser Test
// verständlich rot werden — mit einer Meldung, die die fehlende Datei nennt —
// und NICHT mit einem ENOENT-Stapel von Node, der wie ein kaputter Test
// aussieht. Deshalb steht vor jedem Lesen ein eigenes `assert.ok(existsSync(…))`.
//
// Dieser Wächter ist ABSICHTLICH nicht aus dem entstehenden Code abgeleitet,
// sondern aus dem Vertrag des Pakets. Ein Wächter, der aus dem Code
// abgeschrieben ist, sichert zu, was da ist, statt was zugesagt war — und wird
// grün, egal was gebaut wurde.
//
// GEPRÜFT WIRD, sechs Zusicherungen, nicht mehr:
//
//   1. DREI ORTE NENNEN DIESELBEN SPRACHCODES — `server/src/platform/auth/language.ts`,
//      `web/src/platform/i18n/languages.ts` und der `CHECK` in
//      `server/src/platform/db/migrations/005-user-language.sql`.
//   2. BEIDE SPRACHEN TRAGEN GENAU DIESELBEN SCHLÜSSEL, in beide Richtungen —
//      und kein Schlüssel steht zweimal.
//   3. KEIN LEERER WERT.
//   4. KEIN EINZELNES ANFÜHRUNGSZEICHEN IN EINEM WERT.
//   5. JEDER SCHLÜSSEL WIRD BENUTZT.
//   6. DER TITEL AUS `web/index.html` IST DERSELBE WIE `appTitle` in
//      `messages/de.ts`.
//
// Die Begründung je Zusicherung steht über ihr — jede sagt, welchen Fehler sie
// fängt und warum ihn sonst nichts fängt.
//
// ⚠️ NICHT geprüft und bewusst so:
//   - OB die englische Übersetzung dasselbe BEDEUTET wie die deutsche. Das ist
//     keine Maschinenfrage. Geprüft wird die Form, nicht der Inhalt.
//   - ob `DEFAULT_LANGUAGE` und der `DEFAULT`-Wert der Spalte übereinstimmen.
//     Das wäre eine siebte Zusicherung; sie steht nicht im Auftrag dieses
//     Wächters und ist als Lücke benannt, statt halb gebaut zu werden.
//   - über Variablen zusammengesetzte Schlüssel (`t(`nav${name}`)`). Dieser
//     Wächter hält den Normalfall, nicht den Vorsatz — Zusicherung 5 meldete
//     einen so benutzten Schlüssel zu Unrecht als tot.
//   - verschachtelte Sprachgruppen (`nav: { overview: "…" }`). Gelesen wird
//     die oberste Ebene eines flachen Objektliterals; entsteht die zweite
//     Ebene, gehört sie hier ergänzt. Siehe `collectFields()`.
//
// ⚠️ SEIT PAKET B6, ETAPPE E6 (#5) IST EINE SPRACHE MEHRERE DATEIEN. Die
// Zusicherungen 2 bis 5 laufen deshalb über `readLanguage(code)` und damit
// über die Hauptdatei UND jede Teildatei `de-<thema>.ts` / `en-<thema>.ts`
// daneben — die Begründung steht bei `messagePartPaths()`.

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Der Wächter liest normalerweise den echten Baum. Für die Mutationsproben
// (ein Nachbau der erwarteten Dateien unter dem Ablagefach, in dem genau eine
// Regel verletzt wird) zeigen diese fünf Variablen auf den Nachbau. So läuft
// die Probe, ohne dass der Wächter dafür verbogen werden müsste —
// `shell-navigation.test.mjs` macht es mit `SHELL_ROOT` genauso.
const SERVER_LANGUAGE_PATH = process.env.SERVER_LANGUAGE_TS ?? `${REPO_ROOT}server/src/platform/auth/language.ts`;
const WEB_LANGUAGES_PATH = process.env.WEB_LANGUAGES_TS ?? `${REPO_ROOT}web/src/platform/i18n/languages.ts`;
const MIGRATION_PATH =
  process.env.LANGUAGE_MIGRATION_SQL ?? `${REPO_ROOT}server/src/platform/db/migrations/005-user-language.sql`;
const MESSAGES_ROOT = process.env.MESSAGES_ROOT ?? `${REPO_ROOT}web/src/platform/i18n/messages`;
const WEB_SOURCE_ROOT = process.env.WEB_SOURCE_ROOT ?? `${REPO_ROOT}web/src`;
// The language files of the features (#258), see `message-roots.mjs`.
const FEATURES_ROOT = process.env.FEATURES_ROOT ?? `${WEB_SOURCE_ROOT}/features`;
const INDEX_HTML_PATH = process.env.WEB_INDEX_HTML ?? `${REPO_ROOT}web/index.html`;

// ⚠️ Die HAUPTdatei der Vorgabesprache, und nur sie. Seit der Teilung (B6/E6,
// #5) liest dieser Wächter die Schlüssel über `readLanguage(code)` aus ALLEN
// Teilen; dieser Pfad steht hier weiterhin, weil Zusicherung 6 ihn braucht:
// `appTitle` ist der Titel VOR dem ersten Rendern und gehört in die
// Hauptdatei. Läge er in einem Teil, fände ihn diese eine Zusicherung nicht —
// und meldete das dann auch (siehe ihre Fehlermeldung), statt still grün zu
// bleiben. Eine englische Entsprechung braucht sie nicht.
const GERMAN_MESSAGES_PATH = `${MESSAGES_ROOT}/de.ts`;

// Der Grund, aus dem dieser Wächter im eigenen Worktree rot ist. Steht in
// jeder Meldung über eine fehlende Datei, damit niemand ihn für einen kaputten
// Test hält.
const PENDING = "wird parallel in der Sprachumschaltung (#70) gebaut und fehlt in diesem Worktree noch";

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

// ⚠️ `stripComments` aus `./strip-comments.mjs` ist für DIESEN Wächter keine
// Feinheit, sondern die Voraussetzung: die Sprachdateien dieses Repos sind
// dicht kommentiert, und ein Kommentar über einen Schlüssel
// (`// setupLead: der lange Satz`) sähe für jeden Leser unten aus wie ein
// Schlüssel mit Wert. Zusicherung 2 meldete dann einen Schlüssel, den es
// nicht gibt.
//
// ⚠️ NICHT zu verwechseln mit `stripSqlComments` weiter unten: SQL kennt `--`
// als Kommentar und maskiert Anführungszeichen durch Verdopplung. Der
// Entferner gehört zur gelesenen Sprache.

// Ersetzt jeden SQL-Kommentar durch Leerzeichen — `--` bis zum Zeilenende und
// `/* … */` — und behält dabei die Zeilenumbrüche.
//
// ⚠️ WOGEGEN ER STEHT, und das ist kein erfundener Fall: der Prosakopf von
// `005-user-language.sql` erklärt seinen `CHECK` über mehrere `--`-Zeilen. Wer
// dort beim Eintragen einer dritten Sprache fortschreibt, schreibt die Form im
// Hausstil hin — und der Leser unten nähme den ERSTEN Treffer, den aus dem
// Kommentar, während die echte Schranke daneben etwas anderes sagt.
// Nachgestellt am echten Baum: die Prüfkette blieb grün, und die Datenbank
// ließe eine Sprache zu, die die Oberfläche nicht kennt.
//
// ⚠️ Eine EIGENE Funktion und nicht `stripComments()`: der ist für TypeScript
// gebaut, kennt `--` überhaupt nicht und ließe die Prosazeilen stehen.
//
// ⚠️ SQL maskiert ein Anführungszeichen durch VERDOPPELUNG (`'don''t'`) und
// NICHT durch einen Backslash. Wer die Regel von JavaScript mitbringt, hält
// das zweite `'` für ein Ende, ist danach um eine Zeichenkette verschoben und
// frisst den Rest der Datei — und ein Wächter, der nichts mehr liest, ist
// grün. Deshalb schließt ein `'` innerhalb einer Zeichenkette nur, wenn ihm
// kein weiteres folgt; für den zitierten Bezeichner gilt dasselbe mit `""`.
//
// Bekannte Grenze, wie bei `stripComments()`: ein SQL-Parser ist das nicht.
// Dollar-Quoting (`$$ … $$`) und `E'\n'` kennt er nicht; beide stehen in
// keiner Migration dieses Repos.
function stripSqlComments(source) {
  let output = "";
  let index = 0;
  let quote = null;
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (quote !== null) {
      // Die Verdopplung: beide Zeichen gehören zum Wert, die Zeichenkette
      // läuft weiter.
      if (character === quote && next === quote) {
        output += character + next;
        index += 2;
        continue;
      }
      if (character === quote) quote = null;
      output += character;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      output += character;
      index += 1;
      continue;
    }
    if (character === "-" && next === "-") {
      while (index < source.length && source[index] !== "\n") {
        output += " ";
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let position = index; position < stop; position += 1) {
        output += source[position] === "\n" ? "\n" : " ";
      }
      index = stop;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

// ── Wie dieser Wächter TypeScript liest ─────────────────────────────────────
//
// ⚠️ ERSTE BAUENTSCHEIDUNG, und sie ist erzwungen: dieser Wächter läuft als
// `.mjs` unter `node --test`. Er kann `de.ts`, `en.ts` und `language.ts` NICHT
// importieren — Node führt kein TypeScript aus, und einen Übersetzungsschritt
// nur für die Prüfkette einzuführen hieße, die Wächter von genau dem Werkzeug
// abhängig zu machen, dessen Ergebnis sie prüfen sollen. Die vorhandenen
// Wächter dieses Repos gehen alle denselben Weg: Text lesen, mit einem
// benannten regulären Ausdruck auswerten, die Grenze des Ausdrucks über ihm
// hinschreiben.
//
// Die zweite Hälfte dieser Entscheidung ist die gefährliche: ein Leser, der
// nichts findet, liefert eine LEERE MENGE, und eine leere Menge verletzt keine
// Zusicherung. Ein Wächter, der grün wird, weil er nichts gelesen hat, ist die
// gefährlichste Sorte — er sieht aus wie ein Beweis und ist keiner. Deshalb
// trägt JEDER Leser hier eine eigene Zusicherung, dass er etwas gelesen hat,
// und die Meldung sagt ausdrücklich, dass der WÄCHTER blind ist und nicht der
// Code falsch.

// Das Array hinter `LANGUAGES`. Getroffen wird die Deklaration in beiden
// Workspaces: `export const LANGUAGES = ["de", "en"] as const;` ebenso wie eine
// mit Typangabe (`const LANGUAGES: readonly Language[] = [...]`).
//
// Grenze: das Array muss ein LITERAL sein. `LANGUAGES = Object.keys(messages)`
// wäre nicht lesbar — und fällt dann auf `null`, nicht auf eine leere Liste.
const LANGUAGE_ARRAY = /\bLANGUAGES\s*(?::[^=;]*)?=\s*\[([^\]]*)\]/;

// Der `CHECK` der Migration. Der Spaltenname darf zitiert sein oder nicht,
// die Schlüsselwörter in jeder Schreibweise stehen.
//
// Grenze: genau die Form `CHECK ("language" IN ('de', 'en'))`. Eine mit
// `<>`-Vergleichen oder über eine eigene Tabelle gebaute Einschränkung wäre
// nicht lesbar — und fällt dann auf `null`.
//
// ⚠️ Der Ausdruck trägt `g`, und das ist keine Kosmetik: gesucht wird nicht
// der erste Treffer, sondern ALLE — der erste Treffer WAR die Lücke.
// `matchAll` ist deshalb der einzige Zugriff auf ihn; `exec` liefe mit `g` auf
// einem fortgeschriebenen `lastIndex`.
const SQL_LANGUAGE_CHECK = /\bCHECK\s*\(\s*"?language"?\s+IN\s*\(([^)]*)\)/gi;

function sqlChecks(source) {
  return [...source.matchAll(SQL_LANGUAGE_CHECK)];
}

// Der EINE Treffer — oder `null`, wenn es keinen gibt ODER mehr als einen.
//
// ⚠️ Zwei Treffer sind ausdrücklich KEIN Treffer und nicht etwa „der erste
// gewinnt": welche Form die Spalte am Ende trägt, hängt an der Reihenfolge der
// Anweisungen und ist aus dem Text nicht zu entscheiden. Der Aufrufer macht
// daraus eine eigene Meldung — das erschlägt die ganze Fehlerklasse und nicht
// nur den Köder im Kommentar.
function singleSqlCheck(source) {
  const found = sqlChecks(source);
  return found.length === 1 ? found[0] : null;
}

// Die Zeichenketten innerhalb eines Ausschnitts — für die Codes im Array und
// im `IN (…)`. Beide Anführungszeichen, weil TypeScript doppelte und SQL
// einfache benutzt.
const QUOTED_CODE = /(["'])([^"'\n]*)\1/g;

// Liest die Sprachcodes aus einem Ausschnitt und meldet, WELCHER Leser blind
// ist, wenn nichts herauskommt.
function codesFrom(match, path, shape) {
  assert.ok(
    match !== null,
    `${displayPath(path)}: der Wächter findet ${shape} nicht und liest damit KEINEN einzigen ` +
      "Sprachcode. Er prüft an dieser Stelle nichts — das ist ein Befund am Wächter oder an " +
      "der Form der Datei, kein grünes Ergebnis."
  );
  const codes = [...match[1].matchAll(QUOTED_CODE)].map((found) => found[2]);
  assert.ok(
    codes.length >= 2,
    `${displayPath(path)}: gelesen wurden ${codes.length} Sprachcodes (${codes.join(", ") || "keine"}). ` +
      "Erwartet werden mindestens zwei — eine Sprachumschaltung mit einer Sprache ist keine, und " +
      "ein Leser, der einen von zwei findet, ist kaputt."
  );
  return codes;
}

// Das eine Objektliteral einer Sprachdatei: `export const de = { … } as const;`.
// Der Anfang wird mit einem Muster gesucht, das ENDE durch Zählen der
// Klammern — quotenbewusst, damit eine geschweifte Klammer INNERHALB eines
// Textes („{0} Container") das Literal nicht vorzeitig schließt.
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

// Die Felder der obersten Ebene eines Objektliterals, jeweils mit ihrem Wert
// als Text. Quotenbewusst und klammerzählend, damit ein `,` in einem Text
// keinen neuen Schlüssel erfindet und eine geschweifte Klammer in einem Text
// die Ebene nicht verschiebt.
//
// Grenze: der Schlüssel steht ohne Anführungszeichen da (`appTitle:`), so wie
// heute in `web/src/platform/i18n/messages/de.ts`. Ein zitierter Schlüssel (`"app-title":`) wird
// NICHT gelesen — er fehlte dann in beiden Mengen und fiele bei Zusicherung 2
// nicht auf. Das ist die eine Stelle, an der dieser Leser in die UNSICHERE
// Richtung fällt; sie steht deshalb im Selbsttest unten als eigener Fall.
function collectFields(literalText) {
  const fields = [];
  let quote = null;
  let depth = 0;
  let index = 0;
  let pending = null;
  let valueStart = -1;

  const flush = (end) => {
    if (pending === null) return;
    fields.push({ name: pending.name, index: pending.index, value: literalText.slice(valueStart, end) });
    pending = null;
  };

  while (index < literalText.length) {
    const character = literalText[index];
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
      const match = /^([A-Za-z_$][\w$]*)\s*:/.exec(literalText.slice(index));
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

// Der Inhalt einer schlichten Zeichenkette, Maskierungen aufgelöst — sonst
// `null`. Ein Template-Literal, eine Verkettung oder ein Aufruf ist kein
// lesbarer Wert; der Aufrufer meldet ihn, statt ihn zu überspringen.
//
// ⚠️ Das ANDERE Anführungszeichen darf im Text stehen: `"Es heißt 'so'"` ist
// eine gültige Zeichenkette — und genau der Fall, den Zusicherung 4 sucht. Ein
// Leser, der ihn als „nicht lesbar" abtut, nähme dieser Zusicherung ihren
// einzigen Fall.
const STRING_VALUE = /^\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)')\s*$/;

function stringValue(text) {
  const match = STRING_VALUE.exec(text);
  if (match === null) return null;
  const raw = match[1] ?? match[2];
  return raw.replace(/\\(.)/g, (_, character) => {
    if (character === "n") return "\n";
    if (character === "t") return "\t";
    return character;
  });
}

// Die Schlüssel und Werte einer Sprachdatei, mit der Zusicherung, dass der
// Leser etwas gelesen hat.
function readMessages(path) {
  const body = stripComments(readOrFail(path));
  const literal = messagesLiteral(body);
  assert.ok(
    literal !== null,
    `${displayPath(path)} trägt kein lesbares „export const … = { … }" auf Modulebene — der ` +
      "Wächter liest damit KEINEN Schlüssel und prüft an dieser Stelle nichts."
  );
  const fields = collectFields(literal);
  assert.ok(
    fields.length > 0,
    `${displayPath(path)} führt keinen einzigen Schlüssel — der Wächter liefe ins Leere`
  );
  return fields;
}

// ── Die TEILE einer Sprache ────────────────────────────────────────────────
//
// ⚠️ SEIT PAKET B6, ETAPPE E6 (#5) IST EINE SPRACHDATEI NICHT MEHR EINE DATEI.
// `de.ts` stand bei 967 Zeilen von 1.000 (`source-file-size.test.mjs`), und der
// Reiter „Shell" brauchte rund dreißig Schlüssel mehr. Geteilt wurde in flache
// Dateien `de-<thema>.ts` / `en-<thema>.ts` daneben, die die Hauptdatei per
// `...` einsetzt.
//
// ⚠️ WARUM DIESER LESER MITWACHSEN MUSSTE UND NICHT BLOSS DURFTE. Ohne ihn
// wäre die Teilung ein LECK und kein Umbau: die fünf Zusicherungen unten
// hielten weiterhin sechs Zusagen — aber nur noch über die Hauptdatei. Jeder
// Schlüssel in einem Teil wäre ungeprüft gewesen: er dürfte auf Englisch
// fehlen, leer sein, ein ICU-Anführungszeichen tragen und tot sein, und alles
// bliebe grün. Dieselbe Fehlerklasse wie eine Gruppe `shell: { … }`, nur mit
// einem Dateinamen statt einer Klammer.
//
// GEFUNDEN WIRD ÜBER DEN DATEINAMEN und nicht über die Importe der Hauptdatei:
// ein Teil, den niemand einsetzt, ist damit trotzdem gelesen — und seine toten
// Schlüssel fallen bei Zusicherung 5 auf, statt unbemerkt danebenzuliegen.
function messagePartPaths(code) {
  requireDirectory(MESSAGES_ROOT);
  const pattern = new RegExp(`^${code}(?:-[a-z0-9-]+)?\\.ts$`);
  const parts = messageRoots(MESSAGES_ROOT, FEATURES_ROOT)
    .flatMap((root) =>
      readdirSync(root)
        .filter((name) => pattern.test(name))
        .map((name) => `${root}/${name}`)
    )
    .sort();
  assert.ok(
    parts.length > 0,
    `Keine Sprachdatei „${code}(-<thema>).ts" unter ${displayPath(MESSAGES_ROOT)} — ${PENDING}`
  );
  return parts;
}

/**
 * Alle Schlüssel EINER Sprache, über alle Teile hinweg — jeder mit der Datei,
 * aus der er stammt, damit jede Meldung unten den Ort nennt.
 */
function readLanguage(code) {
  return messagePartPaths(code).flatMap((path) => readMessages(path).map((field) => ({ ...field, path })));
}

// ── Zusicherung 1: drei Orte nennen dieselben Sprachcodes ───────────────────
//
// FÄNGT: eine Sprache, die nur an zwei der drei Stellen steht.
//
// WARUM SIE SONST NIEMAND FÄNGT: die drei Orte liegen in ZWEI WORKSPACES UND
// EINER SQL-DATEI. Der Typcheck des Web-Workspaces sieht `server/` nicht, der
// des Servers sieht `web/` nicht, und die Migration ist für beide eine
// Textdatei ohne Typen. Es gibt keinen Lauf, in dem die drei zusammen
// vorkommen — außer diesem.
//
// WAS SCHIEFGEHT, wenn sie fehlt, in beide Richtungen:
//   - Die Sprache steht in `web/` und fehlt im `CHECK`: das Menü bietet sie
//     an, das Speichern läuft in eine verletzte Einschränkung — ein 500er auf
//     einen Klick, der aussieht wie jeder andere.
//   - Die Sprache steht im `CHECK` und in `server/`, fehlt aber in `web/`: sie
//     ist eine tote Auswahl, die niemand je zu sehen bekommt.
test("die drei Orte nennen dieselben Sprachcodes", () => {
  const serverSource = stripComments(readOrFail(SERVER_LANGUAGE_PATH));
  const webSource = stripComments(readOrFail(WEB_LANGUAGES_PATH));
  // Die Migration wird OHNE ihre Kommentare gelesen — siehe
  // `stripSqlComments()`. Ein `CHECK` in einem SQL-Kommentar ist kein absurder
  // Fall: der Prosakopf genau dieser Datei erklärt den `CHECK` über mehrere
  // `--`-Zeilen, und wer ihn beim Eintragen einer dritten Sprache
  // fortschreibt, schreibt die Form dort im Hausstil hin.
  const migrationSource = stripSqlComments(readOrFail(MIGRATION_PATH));

  const server = codesFrom(
    LANGUAGE_ARRAY.exec(serverSource),
    SERVER_LANGUAGE_PATH,
    "die Deklaration „LANGUAGES = [ … ]"
  );
  const web = codesFrom(
    LANGUAGE_ARRAY.exec(webSource),
    WEB_LANGUAGES_PATH,
    "die Deklaration „LANGUAGES = [ … ]"
  );
  // ⚠️ GENAU EIN TREFFER, sonst rot. Selbst nach dem Entfernen der Kommentare:
  // stehen zwei `CHECK`-Formen für dieselbe Spalte in der Datei, ist nicht
  // bestimmt, welche gilt — und dieser Wächter darf nicht raten. Er nähme
  // sonst wieder still die erste, und die zweite wäre die, die zählt.
  const checks = sqlChecks(migrationSource);
  assert.ok(
    checks.length <= 1,
    `${displayPath(MIGRATION_PATH)}: ${checks.length} Einschränkungen „CHECK ("language" IN ( … ))" ` +
      "in einer Datei. Welche von ihnen die Spalte am Ende trägt, ist aus dem Text nicht zu " +
      "entscheiden — dieser Wächter prüfte dann eine und ließe die andere laufen. Eine Migration " +
      `trägt genau eine Schranke:\n${checks.map((found) => found[0]).join("\n")}`
  );

  const migration = codesFrom(
    singleSqlCheck(migrationSource),
    MIGRATION_PATH,
    "die Einschränkung „CHECK (\"language\" IN ( … ))"
  );

  const places = [
    { name: displayPath(SERVER_LANGUAGE_PATH), codes: new Set(server) },
    { name: displayPath(WEB_LANGUAGES_PATH), codes: new Set(web) },
    { name: `${displayPath(MIGRATION_PATH)} (CHECK)`, codes: new Set(migration) }
  ];

  const findings = [];
  const everywhere = new Set([...server, ...web, ...migration]);
  for (const code of [...everywhere].sort()) {
    const missing = places.filter((place) => !place.codes.has(code)).map((place) => place.name);
    if (missing.length === 0) continue;
    const present = places.filter((place) => place.codes.has(code)).map((place) => place.name);
    findings.push(`„${code}" steht in ${present.join(" und ")}, fehlt aber in ${missing.join(" und ")}`);
  }

  assert.deepEqual(
    findings,
    [],
    "Die Sprachcodes laufen auseinander. Eine Sprache, die nur an zwei der drei Stellen " +
      "steht, ist entweder eine tote Auswahl im Menü oder ein 500er beim Speichern:\n" +
      findings.join("\n")
  );
});

// ── Zusicherung 2: beide Sprachdateien tragen dieselben Schlüssel ───────────
//
// FÄNGT: einen Schlüssel, der in einer der beiden Dateien fehlt — in BEIDE
// Richtungen. Ein fehlender deutscher Schlüssel ist genauso ein Loch wie ein
// fehlender englischer.
//
// WARUM SIE SONST NIEMAND FÄNGT: heute deckt der Typcheck das mit ab —
// `Messages = typeof de` macht jede Übersetzung, der ein Schlüssel fehlt, zum
// Typfehler. Diese Deckung ist aber eine LEIHGABE: sie fällt in dem Moment weg,
// in dem irgendwo ein `as` steht (`en as Messages`, `en as unknown as
// Messages`), und ein `as` schreibt niemand aus Bosheit — er schreibt es, weil
// der Typcheck bei einer halbfertigen Übersetzung im Weg stand. Danach ist die
// Zusage still weg und der Bildschirm zeigt englische Schlüssel statt Wörter.
// Diese Zusicherung hängt an keinem `as`.
test("beide Sprachdateien tragen genau dieselben Schlüssel", () => {
  const german = readLanguage("de");
  const english = readLanguage("en");

  const germanKeys = new Set(german.map((field) => field.name));
  const englishKeys = new Set(english.map((field) => field.name));

  const findings = [];
  for (const field of german.filter((entry) => !englishKeys.has(entry.name))) {
    findings.push(`„${field.name}" steht in ${displayPath(field.path)}, fehlt in der Sprache „en"`);
  }
  for (const field of english.filter((entry) => !germanKeys.has(entry.name))) {
    findings.push(`„${field.name}" steht in ${displayPath(field.path)}, fehlt in der Sprache „de"`);
  }

  // ⚠️ Ein doppelt vergebener Schlüssel wäre in beiden Mengen genau einmal und
  // fiele oben nicht auf — es gewinnt still ein Wert. Seit der Teilung gilt
  // das ÜBER DIE TEILE HINWEG und nicht mehr nur innerhalb einer Datei: steht
  // derselbe Schlüssel in `de.ts` und in `features/shell/messages/de.ts`, entscheidet die
  // Reihenfolge des `...`-Einsatzes, welcher Text erscheint. Das ist die eine
  // neue Fehlerklasse, die die Teilung überhaupt erst mitbringt.
  for (const fields of [german, english]) {
    const seen = new Map();
    for (const field of fields) {
      const first = seen.get(field.name);
      if (first !== undefined) {
        findings.push(
          `„${field.name}" steht in ${displayPath(first)} UND in ${displayPath(field.path)} — ` +
            "welcher Wert erscheint, entscheidet die Reihenfolge des Einsatzes in der Hauptdatei"
        );
      } else {
        seen.set(field.name, field.path);
      }
    }
  }

  assert.deepEqual(
    findings,
    [],
    "Die Sprachdateien tragen nicht dieselben Schlüssel. Der Typcheck deckt das heute mit ab " +
      "und fällt weg, sobald irgendwo ein `as` steht:\n" + findings.join("\n")
  );
});

// ── Zusicherung 3: kein leerer Wert ─────────────────────────────────────────
//
// FÄNGT: einen Schlüssel, dessen Wert die leere Zeichenkette ist — oder nur
// Leerraum.
//
// WARUM SIE SONST NIEMAND FÄNGT: eine leere Zeichenkette IST eine Zeichenkette.
// Sie erfüllt den Typ, sie erfüllt Zusicherung 2, sie erfüllt jede Prüfung, die
// nach der Anwesenheit eines Schlüssels fragt. Im Bildschirm ist sie dasselbe
// wie ein fehlender Schlüssel — nur schlimmer, weil kein Platzhalter erscheint,
// den jemand sehen könnte: ein Knopf ohne Aufschrift, eine Spalte ohne
// Überschrift. Sie entsteht regelmäßig beim Anlegen der zweiten Sprache, wenn
// die Schlüsselliste zuerst kopiert und dann gefüllt wird.
test("kein Wert in einer Sprachdatei ist leer", () => {
  const findings = [];

  for (const code of ["de", "en"]) {
    for (const field of readLanguage(code)) {
      const path = field.path;
      const value = stringValue(field.value);
      if (value === null) {
        findings.push(
          `${displayPath(path)}: „${field.name}" trägt keine schlichte Zeichenkette, sondern ` +
            `„${field.value.trim()}" — ein zusammengesetzter Wert ist für diesen Wächter nicht ` +
            "lesbar und damit ungeprüft"
        );
        continue;
      }
      if (value.trim() === "") {
        findings.push(`${displayPath(path)}: „${field.name}" ist leer`);
      }
    }
  }

  assert.deepEqual(
    findings,
    [],
    "Leerer Wert in einer Sprachdatei. Im Bildschirm ist das dasselbe wie ein fehlender " +
      "Schlüssel, fällt aber durch jeden Typcheck:\n" + findings.join("\n")
  );
});

// ── Zusicherung 4: kein einzelnes Anführungszeichen in einem Wert ───────────
//
// FÄNGT: ein einzelnes `'` in einem Wert.
//
// WARUM SIE SONST NIEMAND FÄNGT: `use-intl` reicht jeden Wert durch die
// ICU-Formatierung, und dort ist `'` das MASKIERUNGSZEICHEN. `Der 'Hub'` kommt
// im Bildschirm als `Der Hub` an, `Es ist so 'ne Sache {name}` verschluckt
// alles bis zum nächsten `'` — der Platzhalter darin wird nicht mehr ersetzt.
// Das ist kein Typfehler, keine Ausnahme, kein roter Lauf: der Text kommt
// einfach verstümmelt an, und niemand sieht es, außer er liest genau diesen
// Bildschirm.
//
// Wer ein Anführungszeichen BRAUCHT, verdoppelt es: `''` ergibt ein `'`. Diese
// Zusicherung ist der Ort, an dem er das erfährt — deshalb steht es in der
// Meldung und nicht nur hier.
//
// ⚠️ Gemessen am heutigen Bestand ist das umsonst zu haben:
// `grep -c "'" web/src/platform/i18n/messages/de.ts` → 0. Es gibt keine Ausnahme, die getragen
// werden müsste, und deshalb bekommt diese Zusicherung auch keine
// Ausnahmeliste. Eine leere Ausnahmeliste ist eine Tür.
const APOSTROPHE_RUN = /'+/g;

function unbalancedApostrophes(value) {
  return [...value.matchAll(APOSTROPHE_RUN)].filter((match) => match[0].length % 2 === 1);
}

test("kein Wert in einer Sprachdatei trägt ein einzelnes Anführungszeichen", () => {
  const findings = [];

  for (const code of ["de", "en"]) {
    for (const field of readLanguage(code)) {
      const value = stringValue(field.value);
      // Ein nicht lesbarer Wert wird von Zusicherung 3 gemeldet; hier noch
      // einmal zu meckern verdoppelte nur die Meldung.
      if (value === null) continue;
      if (unbalancedApostrophes(value).length === 0) continue;
      findings.push(`${displayPath(field.path)}: „${field.name}" = „${value}"`);
    }
  }

  assert.deepEqual(
    findings,
    [],
    "Einzelnes Anführungszeichen in einem Wert. ICU behandelt es als Maskierung — der Text " +
      "käme verstümmelt an, ohne dass irgendetwas rot wird. Wer ein Anführungszeichen " +
      "braucht, VERDOPPELT es: aus 'Hub' wird ''Hub''.\n" + findings.join("\n")
  );
});

// ── Zusicherung 5: jeder Schlüssel wird benutzt ─────────────────────────────
//
// FÄNGT: den Schlüssel, den keine Stelle unter `web/src/` mehr nennt.
//
// WARUM SIE SONST NIEMAND FÄNGT: ein unbenutzter Schlüssel ist gültiges
// TypeScript, gültiges ICU und ein grüner Lauf. Er kostet nichts und niemand
// merkt ihn — bis er zu zehnt daliegt und die Sprachdatei nicht mehr sagt, was
// die Oberfläche kann. Beim Umbau eines Bildschirms bleiben genau diese
// Leichen zurück, und der Umbauende ist der Einzige, der in dem Moment noch
// wüsste, welche.
//
// ⚠️ SECHS STELLEN STEHEN AUF MODULEBENE und können `useTranslations()` nicht
// rufen — ein Hook läuft nur in einer Komponente. Sie tragen deshalb SCHLÜSSEL
// STATT TEXTE, als schlichte Zeichenketten. Hier stand „VIER"; eine Zahl ist
// nur so viel wert wie der Befehl, mit dem man sie nachzählt, deshalb steht er
// dabei. FÜNF führen den Schlüssel in einem eigenen Typ —
//
//   grep -rlE "keyof Messages|TranslationKey" web/src --include=*.ts --include=*.tsx
//
//   - `web/src/app/shell/navigation.ts` — `labelKey` statt `label`,
//   - `web/src/app/shell/AppSidebar.tsx` — zwei `Record`-Zuordnungen,
//   - `web/src/domain/hosts/host-status.tsx`, `.../HostRow.tsx` und
//     `web/src/screens/OverviewScreen.tsx` — Schlüssel in einem `Record`.
//
// — und die SECHSTE trägt keinen solchen Typ, fällt also durch den Befehl:
// `web/src/features/hosts/host-errors.ts` ist keine Komponente und bekommt `t`
// als Argument von seinen Aufrufern (`grep -n "Translate" darauf`).
//
// Das ist GÜLTIGE BENUTZUNG. Deshalb sucht diese Zusicherung nicht nach
// `t("<schlüssel>")`, sondern nach der ZEICHENKETTE `"<schlüssel>"` an
// beliebiger Stelle — `t("x")` ist davon ein Sonderfall. Ein engeres Muster
// meldete diese sechs Stellen als tot und wäre auf der ersten korrekten
// Umsetzung rot; ein Fehlalarm ist hier teurer als die Lücke, dass ein
// Schlüssel auch dann als benutzt gilt, wenn seine Zeichenkette zufällig
// anderswo steht.
const STRING_LITERAL = /(["'])((?:[^"'\\\n]|\\.)*)\1/g;

test("jeder Schlüssel der Sprachdateien wird unter web/src benutzt", () => {
  const german = readLanguage("de");

  requireDirectory(WEB_SOURCE_ROOT);
  const modules = collectFiles(WEB_SOURCE_ROOT)
    .filter(isModule)
    // Die Sprachdateien selbst benutzen ihre Schlüssel nicht, sie führen sie.
    // Ohne diesen Ausschluss gälte jeder Schlüssel als benutzt, weil er in
    // `en.ts` noch einmal dasteht — die Zusicherung wäre eine Behauptung.
    .filter((path) => !messageRoots(MESSAGES_ROOT, FEATURES_ROOT).some((root) => path.startsWith(`${root}/`)));

  assert.ok(
    modules.length > 0,
    `Keine .ts/.tsx-Datei unter ${displayPath(WEB_SOURCE_ROOT)} außerhalb von ` +
      `${displayPath(MESSAGES_ROOT)} — der Wächter liefe ins Leere`
  );

  const used = new Set();
  for (const path of modules) {
    const body = stripComments(readFileSync(path, "utf8"));
    for (const match of body.matchAll(STRING_LITERAL)) used.add(match[2]);
  }

  // Auch hier: nicht grün werden, weil nichts gelesen wurde. Eine Oberfläche
  // ohne eine einzige Zeichenkette gibt es nicht.
  assert.ok(
    used.size > 0,
    `Keine einzige Zeichenkette unter ${displayPath(WEB_SOURCE_ROOT)} gelesen — der Wächter ` +
      "sieht damit jeden Schlüssel als tot und meldet gleich alle. Das ist ein Befund am " +
      "Wächter, nicht an den Sprachdateien."
  );

  const unused = german.filter((field) => !used.has(field.name)).map((field) => `${field.name} (${displayPath(field.path)})`);

  assert.deepEqual(
    unused,
    [],
    `Schlüssel, die unter ${displayPath(WEB_SOURCE_ROOT)} nirgends genannt werden. Das sind ` +
      "die Leichen, die beim Umbau eines Bildschirms zurückbleiben — gesucht wurde die " +
      `Zeichenkette „<schlüssel>", also auch t(„<schlüssel>"), labelKey und die Schlüssel in ` +
      `den Record-Zuordnungen:\n${unused.join("\n")}`
  );
});

// ── Zusicherung 6: der zweite Titel steht nicht allein ──────────────────────
//
// FÄNGT: einen `<title>` in `web/index.html`, der von `appTitle` in
// `messages/de.ts` abweicht.
//
// WARUM SIE SONST NIEMAND FÄNGT: es sind ZWEI Titel, und keiner der übrigen
// Wächter hält sie gegeneinander. `ui-texts.test.mjs` liest `index.html`
// ausdrücklich nicht (kein JSX) und ohnehin nur `web/src/*.tsx`; der Typcheck
// sieht eine HTML-Datei nicht. Läuft der Text in `messages/de.ts` weg, bleibt
// der alte Titel im HTML stehen, und der Reiter SPRINGT beim ersten Rendern
// sichtbar um. Der Kommentar in `index.html` („Wer den Titel ändern will,
// ändert die Nachricht `appTitle`") ist genau das, was hier gehalten wird —
// bisher hielt es nichts.
//
// ⚠️ WARUM GEGEN „de" UND NICHT GEGEN „en": der Titel in `index.html` ist der
// Stand VOR dem ersten Rendern, bevor irgendeine Sprache gewählt ist. Was da
// steht, ist die Vorgabe des Systems, und die ist Deutsch (`html lang="de"`,
// `DEFAULT_LANGUAGE`, `DEFAULT 'de'` in der Migration). Gegen `en` gehalten
// wäre diese Zusicherung auf einem deutschen Startbildschirm rot.
const HTML_TITLE = /<title>([^<]*)<\/title>/i;

test("der Titel in web/index.html ist derselbe wie appTitle in messages/de.ts", () => {
  const html = readOrFail(INDEX_HTML_PATH);
  const match = HTML_TITLE.exec(html);
  assert.ok(
    match !== null,
    `${displayPath(INDEX_HTML_PATH)} trägt kein „<title>…</title>" — der Wächter liest damit ` +
      "KEINEN Titel und prüft an dieser Stelle nichts."
  );

  const german = readMessages(GERMAN_MESSAGES_PATH).find((field) => field.name === "appTitle");
  assert.ok(
    german !== undefined,
    `${displayPath(GERMAN_MESSAGES_PATH)} führt keinen Schlüssel „appTitle" — dann hat dieser ` +
      "Wächter nichts zum Vergleichen und der Titel im Reiter käme aus dem Nichts."
  );

  const expected = stringValue(german.value);
  assert.ok(
    expected !== null,
    `${displayPath(GERMAN_MESSAGES_PATH)}: „appTitle" trägt keine schlichte Zeichenkette — der ` +
      "Vergleich mit dem HTML-Titel ist damit nicht zu führen."
  );

  assert.equal(
    match[1].trim(),
    expected,
    `Der Titel in ${displayPath(INDEX_HTML_PATH)} („${match[1].trim()}") und „appTitle" in ` +
      `${displayPath(GERMAN_MESSAGES_PATH)} („${expected}") laufen auseinander. Der eine steht im ` +
      "Reiter, bis React übernimmt, der andere danach — der Reiter springt beim Laden sichtbar um. " +
      "Wer den Titel ändert, ändert beide."
  );
});

// ── Selbsttest der Leser ────────────────────────────────────────────────────
//
// Ein Wächter ohne eigenen Test ist eine Behauptung — und bei DIESEM Wächter
// ist die Behauptung besonders billig: alle fünf Zusicherungen hängen an
// Lesern, die Text auswerten. Ein Leser, der nichts findet, liefert eine leere
// Menge, und eine leere Menge verletzt nichts. Die Fälle unten laufen ohne
// jede der geprüften Dateien und sind der Grund, warum dieser Test grün ist,
// während die fünf oben auf ihre Dateien warten.
test("die Leser selbst: was sie lesen müssen und was nicht", () => {
  const findings = [];
  const check = (description, actual, expected) => {
    try {
      assert.deepEqual(actual, expected);
    } catch {
      findings.push(`${description}: bekam ${JSON.stringify(actual)}, erwartet ${JSON.stringify(expected)}`);
    }
  };

  const codes = (match) => (match === null ? null : [...match[1].matchAll(QUOTED_CODE)].map((found) => found[2]));

  // Der Leser der Sprachcodes — beide Formen des Vertrags.
  check(
    "LANGUAGES als Literal mit as const",
    codes(LANGUAGE_ARRAY.exec('export const LANGUAGES = ["de", "en"] as const;')),
    ["de", "en"]
  );
  check(
    "LANGUAGES mit Typangabe",
    codes(LANGUAGE_ARRAY.exec("const LANGUAGES: readonly Language[] = ['de', 'en'];")),
    ["de", "en"]
  );
  check(
    "LANGUAGES über mehrere Zeilen",
    codes(LANGUAGE_ARRAY.exec('export const LANGUAGES = [\n  "de",\n  "en"\n] as const;')),
    ["de", "en"]
  );
  // ⚠️ Und der Fall, für den `codesFrom()` überhaupt da ist: ein
  // zusammengesetztes Array ist NICHT lesbar und muss `null` ergeben — nicht
  // eine leere, grüne Liste.
  check(
    "zusammengesetztes Array ist nicht lesbar",
    codes(LANGUAGE_ARRAY.exec("export const LANGUAGES = Object.keys(messages);")),
    null
  );

  // Der Leser der Einschränkung — genau die Zeile aus dem Vertrag.
  check(
    "CHECK der Migration",
    codes(
      singleSqlCheck(
        'ALTER TABLE "user" ADD COLUMN "language" text\n' +
          "  NOT NULL DEFAULT 'de' CHECK (\"language\" IN ('de', 'en'));"
      )
    ),
    ["de", "en"]
  );
  check(
    "CHECK ohne Anführungszeichen um die Spalte",
    codes(singleSqlCheck("check (language in ('de','en'))")),
    ["de", "en"]
  );
  check(
    "Migration ohne CHECK ist nicht lesbar",
    codes(singleSqlCheck('ALTER TABLE "user" ADD COLUMN "language" text NOT NULL DEFAULT \'de\';')),
    null
  );

  // ⚠️ Der Köder, wörtlich: der Prosakopf der echten Migration, um eine dritte
  // Sprache fortgeschrieben, während die Schranke darunter auf zwei steht. Vor
  // `stripSqlComments()` las der Wächter hier „de, en, fr" und war grün.
  const migrationWithBait = [
    "-- ⚠️ Der CHECK ist die Schranke, genau wie bei \"role\" in 002-auth.sql:",
    "-- eine dritte Sprache entsteht nicht durch einen Tippfehler, sondern nur",
    "-- durch eine Migration — CHECK (\"language\" IN ('de', 'en', 'fr')).",
    "",
    'ALTER TABLE "user"',
    "  ADD COLUMN \"language\" text NOT NULL DEFAULT 'de'",
    "  CHECK (\"language\" IN ('de', 'en'));"
  ].join("\n");
  check("der Köder im --Kommentar fällt weg", codes(singleSqlCheck(stripSqlComments(migrationWithBait))), ["de", "en"]);
  check("und ist auch kein zweiter Treffer", sqlChecks(stripSqlComments(migrationWithBait)).length, 1);
  const blockBait = "/* CHECK (\"language\" IN ('de', 'en', 'fr')) */\nCHECK (\"language\" IN ('de', 'en'));";
  check("ein Blockkommentar trägt ihn ebenso wenig herein", sqlChecks(stripSqlComments(blockBait)).length, 1);

  // ⚠️ Die Gegenrichtung: ein `--` INNERHALB einer Zeichenkette ist Text. Wer
  // das nicht unterscheidet, verschluckt eine echte Fundstelle dahinter.
  const withDashesInString = "INSERT INTO t VALUES ('a -- kein Kommentar'); -- doch einer";
  check("ein -- in einer Zeichenkette bleibt stehen", stripSqlComments(withDashesInString).includes("'a -- kein Kommentar'"), true);
  check("der echte Kommentar dahinter fällt weg", stripSqlComments(withDashesInString).includes("doch einer"), false);
  // ⚠️ Die Falle, an der ein aus JavaScript abgeschriebener Entferner
  // scheitert: wer `''` für ein Ende und einen Anfang hält, ist danach um eine
  // Zeichenkette verschoben und fände hinter ihr GAR NICHTS mehr.
  const withDoubledQuote =
    "INSERT INTO t VALUES ('don''t -- kein Kommentar'); -- doch einer\n" +
    "ALTER TABLE \"user\" ADD COLUMN \"language\" text CHECK (\"language\" IN ('de', 'en'));";
  check("das verdoppelte '' beendet die Zeichenkette nicht", stripSqlComments(withDoubledQuote).includes("'don''t -- kein Kommentar'"), true);
  check("und der CHECK dahinter bleibt lesbar", codes(singleSqlCheck(stripSqlComments(withDoubledQuote))), ["de", "en"]);

  // ⚠️ Zwei ECHTE Formen, beide außerhalb jedes Kommentars: der Wächter darf
  // sich nicht für eine entscheiden, liefert `null` und wird oben rot. Dieser
  // Fall erschlägt die ganze Klasse und nicht nur den einen Köder.
  const twoRealChecks =
    "ALTER TABLE \"user\" ADD COLUMN \"language\" text CHECK (\"language\" IN ('de', 'en'));\n" +
    "ALTER TABLE \"user\" ADD CONSTRAINT language_check CHECK (\"language\" IN ('de', 'en', 'fr'));";
  check("zwei echte CHECK-Formen sind zwei Treffer", sqlChecks(stripSqlComments(twoRealChecks)).length, 2);
  check("… und damit kein bestimmter Treffer", singleSqlCheck(stripSqlComments(twoRealChecks)), null);

  // Der Leser der Sprachdatei.
  const messages = [
    "// Deutsch — die erste Sprache.",
    "export const de = {",
    "  appTitle: \"Docker-Verwaltung\",",
    "  // Ein Kommentar, der einen Schlüssel nennt: erfundenerSchluessel: \"x\"",
    "  setupLead:",
    "    \"Ein Satz mit einer geschweiften Klammer { und einem Komma, dazu.\",",
    "  navOverview: \"Übersicht\"",
    "} as const;"
  ].join("\n");
  const literal = messagesLiteral(stripComments(messages));
  check("das Objektliteral wird gefunden", literal !== null, true);
  check(
    "Schlüssel der obersten Ebene",
    collectFields(literal ?? "").map((field) => field.name),
    ["appTitle", "setupLead", "navOverview"]
  );
  check(
    "der Wert auf der nächsten Zeile gehört zu seinem Schlüssel",
    stringValue(collectFields(literal ?? "")[1].value),
    "Ein Satz mit einer geschweiften Klammer { und einem Komma, dazu."
  );
  check(
    "ein zusammengesetztes Objekt ist nicht lesbar",
    messagesLiteral("export const de = buildMessages();"),
    null
  );
  // ⚠️ Die benannte Grenze aus `collectFields()`, hier als Zusage statt als
  // Überraschung: ein ZITIERTER Schlüssel wird nicht gelesen. Er fehlte dann
  // in BEIDEN Mengen und fiele bei Zusicherung 2 nicht auf — die einzige
  // Stelle, an der dieser Leser in die unsichere Richtung fällt. Wer zitierte
  // Schlüssel braucht, erweitert `collectFields()` und diesen Fall zusammen.
  check(
    "ein zitierter Schlüssel wird nicht gelesen (benannte Grenze)",
    collectFields('{ "app-title": "x", plain: "y" }').map((field) => field.name),
    ["plain"]
  );

  // Der Leser des Wertes.
  check("schlichte Zeichenkette", stringValue('"Übersicht"'), "Übersicht");
  check("Leerraum ringsum gehört nicht zum Wert", stringValue('  "Übersicht"  '), "Übersicht");
  check("leerer Wert", stringValue('""'), "");
  check("maskiertes Anführungszeichen", stringValue('"Der \\"Hub\\""'), 'Der "Hub"');
  // ⚠️ Der Fall, ohne den Zusicherung 4 keinen einzigen Treffer hätte: das
  // ANDERE Anführungszeichen steht im Text und macht ihn nicht unlesbar.
  check("Apostroph im Text bleibt lesbar", stringValue("\"Es heißt 'so'\""), "Es heißt 'so'");
  check("Template-Literal ist kein lesbarer Wert", stringValue("`Hallo ${name}`"), null);
  check("Verkettung ist kein lesbarer Wert", stringValue('"Hallo " + name'), null);

  // Der Zähler der Anführungszeichen.
  check("kein Anführungszeichen", unbalancedApostrophes("Übersicht").length, 0);
  check("einzelnes Anführungszeichen", unbalancedApostrophes("Der 'Hub'").length, 2);
  check("verdoppeltes Anführungszeichen ist erlaubt", unbalancedApostrophes("Der ''Hub''").length, 0);
  check("dreifaches Anführungszeichen ist ungerade", unbalancedApostrophes("Der '''Hub").length, 1);

  assert.deepEqual(findings, [], `Ein Leser dieses Wächters liest anders als zugesagt:\n${findings.join("\n")}`);
});
