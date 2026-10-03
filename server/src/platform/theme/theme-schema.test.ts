import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import {
  DEFAULT_GLOBAL_THEME,
  DEFAULT_HOST_THEME,
  DEFAULT_MARK_THEME,
  DEFAULT_STACK_DISPLAY,
  THEME_KNOBS,
  type ThemeKnobName
} from "contract";

// Wächter über die ZWEI Orte, an denen die erlaubten Stufen stehen.
//
// Sie stehen zweimal, und das ist eine Entscheidung und kein Versehen:
//
//   1. `contract/src/presets.ts` (`THEME_KNOBS`) — dagegen validiert der
//      Server jede Eingabe des Editors, und daraus zeichnet die Oberfläche
//      ihre Auswahl.
//   2. die Migrationen unter `server/src/platform/db/migrations/` — der `CHECK` je
//      Spalte. Er ist die einzige Schranke, die auch einen Handgriff an der
//      Datenbank trifft; ohne ihn hinge die Zusage allein am Code, der gerade
//      läuft.
//
// Zwei Abschriften derselben Liste sind zwei Wahrheiten. Dieses Repo löst das
// nicht, indem es die zweite verbietet, sondern indem eine Maschine sie
// gegeneinander hält — `web/tests/languages.test.mjs` macht es für die
// Sprachcodes seit #70 genauso. Dieser Fall ist dasselbe Verfahren für die
// fünfzehn Stellschrauben aus D7a, D7b (#62) und B6/E4 (#5).
//
// ⚠️ WARUM ER BEI DEN SERVERTESTS STEHT UND NICHT UNTER `web/tests/`: beide
// Orte liegen im Server. Der Wächter kann `presets.ts` deshalb IMPORTIEREN
// statt ihn als Text zu lesen — die eine Seite des Vergleichs ist damit exakt
// und nicht geraten, und die ganze Fehlerklasse „der Leser findet die
// Deklaration nicht und wird grün, weil er nichts gelesen hat" entfällt für
// sie. `server/src/platform/db/auth-schema.test.ts` steht aus demselben Grund hier:
// er braucht eine Abhängigkeit des Servers und gleicht sie gegen die
// Migrationsfolge ab.
//
// GEPRÜFT WIRD, fünf Zusicherungen:
//
//   1. JEDE STELLSCHRAUBE HAT GENAU EINE SPALTE mit genau einem `CHECK` — in
//      der Tabelle, die zu ihrem `scope` gehört.
//   2. DIE STUFEN DES `CHECK` SIND DIE STUFEN AUS `THEME_KNOBS`, in beide
//      Richtungen.
//   3. DER `DEFAULT` DER SPALTE IST DER `fallback` DER STELLSCHRAUBE.
//   4. KEIN `CHECK` OHNE STELLSCHRAUBE: eine Spalte mit Stufenliste, die
//      `THEME_KNOBS` nicht kennt, ist ebenso ein Auseinanderlaufen. Dafür gibt
//      es eine namentliche Ausnahmeliste (`NON_KNOB_CHECKS`), denn `target` in
//      `mark_assignment` trägt eine Stufenliste und ist keine Einstellung.
//   5. DIE VORGABESÄTZE PASSEN ZU DEN STELLSCHRAUBEN: `DEFAULT_GLOBAL_THEME`
//      trägt genau die globalen, `DEFAULT_HOST_THEME` genau die des Arms,
//      `DEFAULT_MARK_THEME` genau die der Marke, `DEFAULT_STACK_DISPLAY`
//      genau die des Stacks.
//
// ⚠️ SEIT D7b IST `scope` EINE LISTE, und `hue` steht in zweien: „host" und
// „mark". Ein Wächter, der `scope === "host"` prüfte, sähe `hue` seitdem gar
// nicht mehr und wäre grün, weil er nichts zu vergleichen fand. Gefiltert wird
// deshalb mit `knobsInScope`, und `hue` hat in beiden Migrationen eine eigene
// Spalte — in `docker_host` und in `hub_mark`, aus derselben Stufenliste.
//
// ⚠️ WELCHE MIGRATIONEN GELESEN WERDEN, und warum das seit B6/E4 (#5) NICHT
// mehr dasteht: bis dahin nannte diese Datei zwei Dateinamen — `006` und
// `007` — und ihr eigener Kopf sagte dazu, eine dritte Migration gehöre hier
// ergänzt. Genau das ist dann passiert und wäre fast durchgerutscht: `012`
// legt die vier Spalten des Terminals an, und ein Wächter mit zwei
// hingeschriebenen Namen hätte für sie GAR NICHTS geprüft und wäre dabei grün
// geblieben — die Zusage „die Stufen im Code sind die Stufen im SQL" hätte für
// vier von fünfzehn Stellschrauben schlicht nicht gegolten.
//
// Gelesen wird deshalb das VERZEICHNIS: jede `*.sql` darin, und daraus jede
// Anweisung mit ihrer Tabelle. Die Zuordnung „welche Reichweite in welcher
// Tabelle" bleibt die einzige Angabe, die dieser Wächter selbst mitbringt.
// Eine vierzehnte Migration, die eine Stufenspalte anlegt oder eine
// bestehende noch einmal deklariert, ist damit von selbst erfasst.
//
// ⚠️ NICHT geprüft und bewusst so:
//   - ob die Migration auf einer echten Datenbank durchläuft. Hier läuft kein
//     Postgres; geprüft wird der TEXT der Migration.
//   - die REIHENFOLGE der Migrationen. Zwei Deklarationen derselben Spalte
//     werden rot statt „die spätere gewinnt" — welche Form die Spalte am Ende
//     trägt, hängt an der Reihenfolge der Anweisungen und ist aus dem Text
//     nicht zu entscheiden. Dieselbe Regel wie bei zwei `CHECK` in einer
//     Datei, nur über das ganze Verzeichnis.

const MIGRATIONS_DIRECTORY = new URL("../db/migrations/", import.meta.url);

// ── Wie dieser Wächter SQL liest ────────────────────────────────────────────
//
// Ersetzt jeden SQL-Kommentar durch Leerzeichen — `--` bis zum Zeilenende und
// `/* … */` — und behält dabei die Zeilenumbrüche.
//
// ⚠️ WOGEGEN ER STEHT, und das ist in diesem Repo schon passiert (#70): der
// Prosakopf von `006-hub-theme.sql` erklärt die Schranke und nennt dabei die
// Form `CHECK (hue IN ( … ))` wörtlich. Ohne diesen Entferner zählte der
// Leser unten ZWEI Treffer für `hue` — einen im Kommentar, einen echten. Beim
// Sprachpaket nahm ein Leser damals den ERSTEN, und der stand im Kommentar;
// die Kette blieb grün, während die Datenbank etwas anderes zuließ.
//
// ⚠️ Der Kommentar-Entferner gehört zur GELESENEN Sprache, nicht zu der, aus
// der er stammt: SQL kennt `--`, und ein Anführungszeichen maskiert es durch
// VERDOPPELUNG (`'don''t'`) und nicht mit einem Backslash. Wer die Regel von
// JavaScript mitbringt, hält das zweite `'` für ein Ende, ist danach um eine
// Zeichenkette verschoben und frisst den Rest der Datei — und ein Wächter,
// der nichts mehr liest, ist grün.
//
// ⚠️ BEFUND, nicht behoben: dieselbe Funktion steht seit #70 in
// `web/tests/languages.test.mjs`. Sie gehört nach `web/tests/strip-comments.mjs`
// (dort steht die Begründung, warum es die Datei gibt) und von dort exportiert.
// Das ginge nur, indem dieser Wächter aus dem Server in den Nachbarworkspace
// griffe — genau die Richtung, die `presets.ts` in seinem Kopf ausschließt —
// oder indem `languages.test.mjs` angefasst wird, was nicht Auftrag dieses
// Pakets ist. Die zweite Abschrift steht deshalb hier und ist gemeldet.
//
// Bekannte Grenze: ein SQL-Parser ist das nicht. Dollar-Quoting (`$$ … $$`)
// und `E'\n'` kennt er nicht; beide stehen in keiner Migration dieses Repos.
export function stripSqlComments(source: string): string {
  let output = "";
  let index = 0;
  let quote: string | null = null;
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

// Jede Schranke der Form `CHECK (<spalte> IN ( … ))`, gleich für welche
// Spalte. Zwei Leser statt einem, und das ist der Kern:
//
//   - Dieser hier ZÄHLT und sagt, WELCHE Spalte eine Stufenliste trägt. Er ist
//     absichtlich weit gefasst, damit ein zweiter `CHECK` auf dieselbe Spalte
//     — als `ADD CONSTRAINT` weiter unten oder als Köder in einem Kommentar —
//     sichtbar wird, statt vom ersten Treffer verdeckt zu werden.
//   - `DECLARATION` weiter unten liest die Stufen und den `DEFAULT` und
//     verlangt dafür die ganze Deklaration.
//
// ⚠️ `g` und `matchAll`: gesucht wird nicht der erste Treffer, sondern ALLE.
// Der erste Treffer WAR die Lücke aus #70.
const ANY_CHECK_IN = /\bCHECK\s*\(\s*"?([a-z_]+)"?\s+IN\s*\(([^)]*)\)/gi;

// Die ganze Deklaration einer Stufenspalte, in der Form, die 006 durchgängig
// benutzt:
//
//     <spalte> text NOT NULL DEFAULT '<vorgabe>' CHECK (<spalte> IN ('a', 'b'))
//
// Sie trägt beides, was Zusicherung 2 und 3 brauchen, und sie trägt es
// NEBENEINANDER — ein `DEFAULT`, der zu einer anderen Spalte gehört, kann
// damit nicht danebengeraten.
//
// Grenze: genau diese Form. Eine Spalte mit `citext`, mit `COLLATE` oder mit
// dem `CHECK` als eigenem `ADD CONSTRAINT` wäre nicht lesbar — und fällt dann
// auf `null`, nicht auf eine leere Liste.
function declarationOf(column: string): RegExp {
  return new RegExp(
    `\\b${column}\\s+text\\s+NOT\\s+NULL\\s+DEFAULT\\s+'([^']*)'\\s+CHECK\\s*\\(\\s*"?${column}"?\\s+IN\\s*\\(([^)]*)\\)`,
    "gi"
  );
}

// Die Zeichenketten innerhalb eines Ausschnitts — die Stufen im `IN (…)`.
const QUOTED = /'([^'\n]*)'/g;

function quotedValues(fragment: string): string[] {
  return [...fragment.matchAll(QUOTED)].map((found) => found[1]);
}

/**
 * Der EINE Treffer — oder `null`, wenn es keinen gibt ODER mehr als einen.
 *
 * ⚠️ Zwei Treffer sind ausdrücklich KEIN Treffer und nicht „der erste
 * gewinnt": welche Form die Spalte am Ende trägt, hängt an der Reihenfolge der
 * Anweisungen und ist aus dem Text nicht zu entscheiden. Ein Ausdruck, der
 * raten könnte, verlangt genau einen Treffer.
 */
function single<T>(found: readonly T[]): T | null {
  return found.length === 1 ? found[0] : null;
}

// ── Von der Datei zur Anweisung ─────────────────────────────────────────────
//
// Eine Stellschraube gehört nach ihrem `scope` in EINE bestimmte Tabelle. Ohne
// diese Zuordnung wäre „die Spalte gibt es irgendwo" die ganze Aussage — und
// `hue` in `hub_theme` statt in `docker_host` bliebe unbemerkt.
//
// Bis B6/E4 schnitt dieser Wächter dafür zwei Rümpfe aus zwei benannten
// Dateien heraus (`CREATE TABLE <name> (` bis `\n);` und `ALTER TABLE <name>`
// bis `;`). Das trug genau so weit, wie die Namen der Dateien hier standen.
// Stattdessen wird jede Datei jetzt in ihre ANWEISUNGEN zerlegt, und jede
// Anweisung nennt ihre Tabelle selbst — dieselbe Trennschärfe, ohne einen
// einzigen Dateinamen im Code.

/** Eine Anweisung einer Migration mit der Tabelle, an der sie arbeitet. */
interface Statement {
  readonly file: string;
  readonly table: string;
  readonly sql: string;
}

/**
 * Zerlegt eine Migration an ihren Semikola.
 *
 * ⚠️ Nicht `split(";")`: ein Semikolon in einer Zeichenkette
 * (`DEFAULT 'a;b'`) zerschnitte sonst eine Anweisung mitten im Wert, und die
 * zweite Hälfte trüge keine Tabelle mehr. Die Zeichenketten sind hier noch da
 * — `stripSqlComments` entfernt Kommentare und lässt Werte stehen —, also
 * werden sie beim Zerlegen genauso übersprungen wie dort, mit der
 * VERDOPPELUNG als Maskierung.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: string | null = null;
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];
    if (quote !== null) {
      if (character === quote && next === quote) {
        current += character + next;
        index += 2;
        continue;
      }
      if (character === quote) quote = null;
      current += character;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      index += 1;
      continue;
    }
    if (character === ";") {
      statements.push(current);
      current = "";
      index += 1;
      continue;
    }
    current += character;
    index += 1;
  }
  if (current.trim().length > 0) statements.push(current);
  return statements.filter((statement) => statement.trim().length > 0);
}

// Der Kopf einer Anweisung, die an einer Tabelle arbeitet. Alles andere
// (`CREATE INDEX`, `INSERT`, `COMMENT`) trägt keine Spaltendeklaration und
// fällt hier heraus.
const TABLE_STATEMENT = /^\s*(?:CREATE|ALTER)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_]+)"?/i;

/** Jede Anweisung jeder Migration, die eine Tabelle nennt. */
export function tableStatements(file: string, sql: string): Statement[] {
  const found: Statement[] = [];
  for (const statement of splitStatements(sql)) {
    const head = TABLE_STATEMENT.exec(statement);
    if (head === null) continue;
    found.push({ file, table: head[1].toLowerCase(), sql: statement });
  }
  return found;
}

const MIGRATION_FILES = readdirSync(MIGRATIONS_DIRECTORY)
  .filter((name) => name.endsWith(".sql"))
  .sort();

const STATEMENTS: Statement[] = MIGRATION_FILES.flatMap((file) =>
  tableStatements(file, stripSqlComments(readFileSync(new URL(file, MIGRATIONS_DIRECTORY), "utf8")))
);

/** Eine Spalte mit Stufenliste, so wie sie in einer Migration steht. */
interface StepColumn {
  readonly file: string;
  readonly table: string;
  readonly column: string;
  /** Der `DEFAULT`, oder `null`, wenn die Deklaration nicht lesbar ist. */
  readonly fallback: string | null;
  /** Die Stufen des `CHECK`, oder `null` — siehe `fallback`. */
  readonly steps: readonly string[] | null;
}

/**
 * Jede Schranke der Form `CHECK (<spalte> IN ( … ))` im ganzen Verzeichnis,
 * mit ihrer Datei und ihrer Tabelle.
 *
 * ⚠️ Ein Eintrag JE TREFFER und nicht je Spalte: zwei Schranken auf dieselbe
 * Spalte — in derselben Anweisung, in einer zweiten Anweisung oder in einer
 * späteren Migration — sind zwei Einträge und damit sichtbar. Der Fall unten
 * verlangt genau einen.
 */
const STEP_COLUMNS: StepColumn[] = STATEMENTS.flatMap((statement) =>
  [...statement.sql.matchAll(ANY_CHECK_IN)].map((found) => {
    const column = found[1].toLowerCase();
    const declaration = single([...statement.sql.matchAll(declarationOf(column))]);
    return {
      file: statement.file,
      table: statement.table,
      column,
      fallback: declaration === null ? null : declaration[1],
      steps: declaration === null ? null : quotedValues(declaration[2])
    };
  })
);

// Welche Tabelle welchen `scope` trägt. Das ist die einzige Zuordnung, die
// dieser Wächter selbst mitbringt — sie steht nicht in `presets.ts`, weil eine
// Datei mit Daten ohne Logik nichts über Tabellennamen wissen soll.
const SCOPE_TABLE = {
  global: "hub_theme",
  host: "docker_host",
  mark: "hub_mark",
  stack: "stack_display"
} as const;

type Scope = keyof typeof SCOPE_TABLE;

const SCOPES: readonly Scope[] = ["global", "host", "mark", "stack"];

const SCOPE_TABLES: readonly string[] = SCOPES.map((scope) => SCOPE_TABLE[scope]);

/**
 * Der Spaltenname einer Stellschraube.
 *
 * ⚠️ `toLowerCase()` und nicht der Schlüssel selbst, seit B6/E4 (#5): die vier
 * Stellschrauben des Terminals heißen `terminalScheme`, `terminalSurface`,
 * `terminalSize` und `terminalScrollback`, ihre Spalten in 012 dagegen
 * `terminalscheme`, `terminalsurface`, `terminalsize`, `terminalscrollback`.
 * Der Grund steht im Kopf von 012 und ist kein Geschmack: `features/appearance/store.ts`
 * baut seine Anweisungen wörtlich aus den Schlüsseln und OHNE
 * Anführungszeichen, und Postgres faltet einen solchen Bezeichner auf
 * Kleinschreibung. Ein `terminal_scheme` in der Migration wäre die Spalte, die
 * `SELECT terminalScheme` nicht findet.
 */
function columnOf(knob: ThemeKnobName): string {
  return knob.toLowerCase();
}

/** Die Migrationen, in denen die Tabellen dieses Wächters vorkommen. */
const THEME_MIGRATIONS = [
  ...new Set(STATEMENTS.filter((statement) => SCOPE_TABLES.includes(statement.table)).map((s) => s.file))
];

/**
 * Die Stellschrauben, deren `scope` diese Reichweite enthält.
 *
 * ⚠️ `scope` ist seit D7b (#62) eine LISTE: `hue` gilt für den Arm UND für
 * eine Marke. Ein Wächter, der `scope === "host"` prüfte, sähe `hue` seitdem
 * gar nicht mehr — und wäre grün, weil er nichts zu vergleichen fand.
 */
function knobsInScope(scope: string): ThemeKnobName[] {
  return KNOBS.filter((knob) => (THEME_KNOBS[knob].scope as readonly string[]).includes(scope));
}

/**
 * Die Schranken auf EINE Spalte EINER Tabelle, über das ganze Verzeichnis.
 *
 * Genau ein Eintrag ist der erwartete Fall. Keiner heißt „die Spalte gibt es
 * dort nicht", mehr als einer heißt „zweimal deklariert" — in derselben
 * Anweisung, in einer zweiten Anweisung derselben Datei oder in einer
 * späteren Migration. Alle drei sind derselbe Befund: aus dem Text ist nicht
 * zu entscheiden, welche Form am Ende gilt.
 */
function constraintsOn(table: string, column: string): StepColumn[] {
  return STEP_COLUMNS.filter((entry) => entry.table === table && entry.column === column);
}

/** Die Tabellen der vier Reichweiten sind eigene Tabellen, je eine Reichweite. */
function tableOf(scope: Scope): string {
  return SCOPE_TABLE[scope];
}

// Spalten in den Migrationen dieses Wächters, die eine Stufenliste tragen und
// trotzdem KEINE Stellschraube sind. Jede Zeile hier ist eine Ausnahme von
// „ein `CHECK … IN (…)` gehört zu einer Stellschraube" und trägt ihren Grund
// daneben.
//
// ⚠️ Die Liste ist nicht der Weg, unbequeme Treffer loszuwerden: der Fall
// unten verlangt für JEDEN Eintrag, dass es die Spalte auch wirklich gibt.
// Eine Ausnahme, deren Spalte verschwunden ist, wird rot — sonst bliebe sie
// stehen, und die nächste Spalte, die zufällig so heißt, erbte sie.
const NON_KNOB_CHECKS = new Map([
  [
    "target",
    "denn sie sagt, WELCHE ART von Ziel `target_key` benennt (Stack oder Container), " +
      "und ist keine Einstellung des Betreibers"
  ],
  // Die zwei Spalten an `docker_host`, die seit B6/E4 (#5) mit in Sicht sind:
  // dieser Wächter liest jetzt jede Migration, in der eine seiner vier
  // Tabellen vorkommt, und `docker_host` entsteht in 003 und wächst in 004.
  // Beide sind Stufenlisten und beide sind Eigenschaften des Arms, keine
  // Darstellung — sie stehen deshalb hier und nicht in THEME_KNOBS.
  [
    "kind",
    "denn sie sagt, WELCHER ART ein Arm ist (lokal, intern, extern), und das ist " +
      "eine Eigenschaft der Anlage und keine Einstellung des Betreibers"
  ],
  [
    "state",
    "denn sie sagt, wie weit die ANMELDUNG eines Arms gediehen ist (pending, registered), " +
      "und das ist ein Stand und keine Wahl"
  ]
]);

/** Die Namen der Stufen einer Stellschraube. */
function stepsOf(knob: ThemeKnobName): string[] {
  return (THEME_KNOBS[knob].steps as readonly { name: string }[]).map((step) => step.name);
}

const KNOBS = Object.keys(THEME_KNOBS) as ThemeKnobName[];

test("der Wächter liest überhaupt etwas — sonst prüft er nichts", () => {
  // Ein Wächter, der grün wird, weil er nichts gelesen hat, sieht aus wie ein
  // Beweis und ist keiner. Deshalb steht vor jeder Aussage die Zusicherung,
  // dass es etwas zu vergleichen gab — und seit B6/E4 gehört dazu die Frage,
  // ob das Verzeichnis überhaupt gelesen wurde.
  assert.ok(
    MIGRATION_FILES.length > 0,
    "Im Migrationsverzeichnis liegt keine einzige .sql — dieser Wächter liefe ins Leere."
  );
  assert.ok(STATEMENTS.length > 0, "Keine Anweisung mit einer Tabelle gelesen — Muster geändert?");
  assert.ok(STEP_COLUMNS.length > 0, "Keine einzige Schranke der Form CHECK (… IN (…)) gelesen — Muster geändert?");

  assert.equal(
    KNOBS.length,
    15,
    `THEME_KNOBS führt ${KNOBS.length} Stellschrauben. Dieser Wächter ist gegen die fünfzehn ` +
      "gebaut, die es nach B6/E4 (#5) gibt (elf global, zwei je Arm, zwei je Marke und eine je " +
      "Stack — `hue` zählt einmal und gilt für Arm UND Marke); kommt eine dazu, gehört sie in eine " +
      "Migration und die Zahl hier nachgezogen. Die Migration selbst findet dieser Wächter allein."
  );

  // Die vier Reichweiten, einzeln nachgezählt. Ohne sie stünde nur die Summe
  // da, und eine Stellschraube, die von „host" nach „global" wandert, bliebe
  // unsichtbar.
  //
  // 11 statt 7 seit B6/E4 (#5): die vier des Terminals tragen `scope:
  // ["global"]`. Nachgezählt mit
  // `grep -c 'scope: \["global"\]' contract/src/presets.ts` → 11.
  assert.equal(knobsInScope("global").length, 11, `elf Stellschrauben mit scope „global" erwartet`);
  assert.equal(knobsInScope("host").length, 2, `zwei Stellschrauben mit scope „host" erwartet`);
  assert.equal(knobsInScope("mark").length, 2, `zwei Stellschrauben mit scope „mark" erwartet: hue und style`);
  assert.equal(knobsInScope("stack").length, 1, `eine Stellschraube mit scope „stack" erwartet: indent`);

  // Und jede der vier Tabellen kommt wirklich vor. Eine Reichweite, deren
  // Tabelle in keiner Anweisung steht, wäre sonst still ungeprüft.
  for (const scope of SCOPES) {
    assert.ok(
      STATEMENTS.some((statement) => statement.table === tableOf(scope)),
      `Keine Anweisung an „${tableOf(scope)}" gefunden — die Reichweite „${scope}" bliebe ungeprüft.`
    );
  }

  // Die Dateien, in denen diese Tabellen vorkommen: heute fünf — 003 und 004
  // legen `docker_host` an und erweitern es, 006 bringt die Darstellung, 007
  // die Marken, 012 das Terminal.
  // ⚠️ Eine UNTERGRENZE und keine Gleichheit — eine spätere Migration an einer
  // dieser Tabellen soll diesen Wächter nicht kosten, sondern von ihm erfasst
  // werden. Genau das war der Fehler, den B6/E4 vorgefunden hat.
  assert.ok(
    THEME_MIGRATIONS.length >= 5,
    `nur ${THEME_MIGRATIONS.length} Migrationen mit einer dieser Tabellen ` +
      `(${THEME_MIGRATIONS.join(", ")}) — erwartet werden mindestens fünf (003, 004, 006, 007, 012).`
  );
});

test("jede Stellschraube hat genau eine Spalte mit genau einem CHECK, in der Tabelle ihres scope", () => {
  const findings: string[] = [];

  for (const scope of SCOPES) {
    for (const knob of knobsInScope(scope)) {
      const column = columnOf(knob);
      const found = constraintsOn(tableOf(scope), column);
      if (found.length !== 1) {
        const where = found.length === 0 ? "nirgends" : found.map((entry) => entry.file).join(", ");
        findings.push(
          `${knob}: ${found.length} Schranken „CHECK (${column} IN ( … ))" an ${tableOf(scope)} ` +
            `(${where}). Erwartet wird genau eine — bei zweien hängt es an der Reihenfolge der ` +
            "Anweisungen, welche gilt, und das ist aus dem Text nicht zu entscheiden. Zwei können " +
            "seit B6/E4 auch in ZWEI Dateien stehen: eine spätere Migration, die dieselbe Spalte " +
            "noch einmal deklariert, ist derselbe Fall."
        );
      }
    }
  }

  // Die Gegenrichtung, und sie ist der eigentliche Grund für die Zuordnung
  // Reichweite → Tabelle: dieselbe Spalte in einer Tabelle, zu der die
  // Stellschraube gar nicht gehört. `scheme` an `docker_host` wäre eine
  // Einstellung, die der Editor nie schreibt und die niemand je bemerkt.
  //
  // ⚠️ `hue` steht erlaubterweise an ZWEI Tabellen — `docker_host` und
  // `hub_mark` —, weil `scope: ["host", "mark"]` genau das sagt. Verglichen
  // wird deshalb die Menge der Tabellen mit der Menge der Reichweiten und
  // nicht „höchstens eine".
  for (const knob of KNOBS) {
    const column = columnOf(knob);
    const tables = [...new Set(STEP_COLUMNS.filter((entry) => entry.column === column).map((e) => e.table))].sort();
    const expected = [...(THEME_KNOBS[knob].scope as readonly Scope[])].map(tableOf).sort();
    if (JSON.stringify(tables) !== JSON.stringify(expected)) {
      findings.push(
        `${knob}: die Spalte „${column}" trägt eine Stufenliste an [${tables.join(", ")}], ` +
          `erwartet nach scope [${(THEME_KNOBS[knob].scope as readonly string[]).join(", ")}] ` +
          `wäre [${expected.join(", ")}].`
      );
    }
  }

  assert.deepEqual(findings, [], `Die Schranken stehen nicht wie erwartet:\n${findings.join("\n")}`);
});

test("die Stufen des CHECK sind die Stufen aus THEME_KNOBS, in beide Richtungen", () => {
  const findings: string[] = [];

  for (const scope of SCOPES) {
    for (const knob of knobsInScope(scope)) {
      const column = columnOf(knob);
      const declaration = single(constraintsOn(tableOf(scope), column));
      if (declaration === null) continue; // Der Fall darüber meldet das bereits.

      // Kein grünes Ergebnis aus einem blinden Leser.
      assert.ok(
        declaration.steps !== null,
        `${declaration.file}: die Deklaration der Spalte „${column}" in ${tableOf(scope)} ist für ` +
          "diesen Wächter nicht lesbar (erwartet: `<spalte> text NOT NULL DEFAULT '…' CHECK " +
          "(<spalte> IN (…))`, genau einmal in ihrer Anweisung). Er vergleicht für sie KEINE " +
          "einzige Stufe — das ist ein Befund am Wächter oder an der Form der Datei, kein grünes " +
          "Ergebnis."
      );
      assert.ok(
        declaration.steps.length > 0,
        `${declaration.file}: aus „CHECK (${column} IN ( … ))" liest dieser Wächter keine Stufe.`
      );

      const expected = [...stepsOf(knob)].sort();
      const actual = [...declaration.steps].sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        findings.push(
          `${knob}: THEME_KNOBS führt [${expected.join(", ")}], ${declaration.file} lässt ` +
            `[${actual.join(", ")}] zu.`
        );
      }
    }
  }

  assert.deepEqual(
    findings,
    [],
    "Die zwei Orte der erlaubten Stufen laufen auseinander. Was der Server annimmt, lehnt die " +
      `Datenbank ab — oder umgekehrt:\n${findings.join("\n")}`
  );
});

test("der DEFAULT der Spalte ist der fallback der Stellschraube", () => {
  const findings: string[] = [];

  for (const scope of SCOPES) {
    for (const knob of knobsInScope(scope)) {
      const declaration = single(constraintsOn(tableOf(scope), columnOf(knob)));
      if (declaration === null || declaration.fallback === null) continue; // Oben gemeldet.

      const fallback = THEME_KNOBS[knob].fallback as string;
      if (declaration.fallback !== fallback) {
        findings.push(
          `${knob}: DEFAULT '${declaration.fallback}' in ${declaration.file}, fallback ` +
            `"${fallback}" in THEME_KNOBS.`
        );
      }
    }
  }

  assert.deepEqual(
    findings,
    [],
    "Ein bestehender Datensatz bekommt bei der Migration einen anderen Wert, als der Code für ihn " +
      `annimmt:\n${findings.join("\n")}`
  );
});

test("kein CHECK ohne Stellschraube, außer den namentlich eingetragenen", () => {
  // Die Gegenrichtung: eine Spalte mit Stufenliste, die THEME_KNOBS nicht
  // kennt, ist dasselbe Auseinanderlaufen von der anderen Seite — der Server
  // schriebe nie hinein, und niemand merkte es.
  //
  // ⚠️ WIE WEIT DIESER FALL REICHT: über die Migrationen, in denen die vier
  // Tabellen dieses Wächters vorkommen (heute 003, 004, 006, 007, 012), und
  // darin über JEDE Stufenliste — auch die an einer anderen Tabelle derselben
  // Datei. Das ist die Reichweite, die dieser Fall vor B6/E4 über zwei
  // hingeschriebene Dateinamen hatte, ohne die Namen und um die zwei
  // Migrationen weiter, in denen `docker_host` entsteht.
  //
  // NICHT über das ganze Verzeichnis: `role` in 002, `language` in 005 und
  // `tail_lines` in 010 sind Stufenlisten und haben mit der Darstellung nichts
  // zu tun. Sie hier einzutragen hieße, jede künftige Migration dieses Repos
  // an diesem Wächter vorbeizuführen — und eine Ausnahmeliste, die alles
  // enthält, sagt nichts mehr.
  const inReach = STEP_COLUMNS.filter((entry) => THEME_MIGRATIONS.includes(entry.file));

  // Der Wächter darf nicht dadurch grün werden, dass er nichts gelesen hat.
  // Nachgezählt auf diesem Stand: 1 in 003 (`kind`), 1 in 004 (`state`), 9 in
  // 006 (sieben an `hub_theme`, `hue` und `ink` an `docker_host`), 4 in 007
  // (`hue`, `style` an `hub_mark`, `target` an `mark_assignment`, `indent` an
  // `stack_display`) und 4 in 012 — zusammen 19.
  assert.ok(
    inReach.length >= 19,
    `nur ${inReach.length} Stufenlisten in ${THEME_MIGRATIONS.join(", ")} gelesen, erwartet werden ` +
      "mindestens 19. Umbenannt, verschoben oder Muster geändert?"
  );

  const knobColumns = new Set(KNOBS.map(columnOf));
  const stray = inReach
    .filter((entry) => !knobColumns.has(entry.column))
    .filter((entry) => !NON_KNOB_CHECKS.has(entry.column))
    .map((entry) => `${entry.file}: ${entry.table}.${entry.column}`);

  assert.deepEqual(
    stray,
    [],
    `Stufenlisten für Spalten, die THEME_KNOBS nicht kennt: ${stray.join(", ")}. ` +
      "Ist das Absicht, gehört die Spalte mit ihrem Grund in NON_KNOB_CHECKS."
  );

  // Die Gegenrichtung: eine Ausnahme, deren Spalte es nicht mehr gibt, bliebe
  // sonst stehen — und die nächste Spalte, die zufällig so heißt, erbte sie.
  for (const [column, reason] of NON_KNOB_CHECKS) {
    assert.ok(
      inReach.some((entry) => entry.column === column),
      `Keine Stufenliste für „${column}" mehr in ${THEME_MIGRATIONS.join(", ")} — dann gehört sie ` +
        `auch aus NON_KNOB_CHECKS heraus (${reason})`
    );
  }
});

test("der Anweisungsleser selbst: was er trennt und wem er eine Anweisung zuschreibt", () => {
  // Der zweite riskante Leser dieses Wächters, und der neue: er entscheidet,
  // zu WELCHER Tabelle eine Schranke gehört. Ohne eigenen Fall wäre das eine
  // Behauptung — und ein Leser, der nichts findet, ist grün.
  const findings: string[] = [];
  const check = (description: string, actual: unknown, expected: unknown) => {
    try {
      assert.deepEqual(actual, expected);
    } catch {
      findings.push(`${description}: bekam ${JSON.stringify(actual)}, erwartet ${JSON.stringify(expected)}`);
    }
  };

  const sql =
    "CREATE TABLE a (\n  x text NOT NULL DEFAULT 'p' CHECK (x IN ('p', 'q'))\n);\n" +
    "ALTER TABLE b\n  ADD COLUMN y text NOT NULL DEFAULT 'r' CHECK (y IN ('r'));\n" +
    "CREATE INDEX a_x ON a (x);\n";
  const statements = tableStatements("t.sql", sql);
  check("zwei Anweisungen mit Tabelle, der Index zählt nicht", statements.map((s) => s.table), ["a", "b"]);
  check(
    "die Schranke gehört zur Tabelle ihrer Anweisung",
    statements.filter((s) => /CHECK \(x/.test(s.sql)).map((s) => s.table),
    ["a"]
  );

  // ⚠️ Ein Semikolon IN einer Zeichenkette trennt nicht. Ohne diese Regel
  // zerfiele die Anweisung mitten im Wert, und die zweite Hälfte trüge keine
  // Tabelle mehr — der Leser sähe die Schranke dahinter gar nicht.
  const semicolon = "CREATE TABLE a (\n  x text NOT NULL DEFAULT 'p;q' CHECK (x IN ('p;q', 'r'))\n);\n";
  check("ein Semikolon in einer Zeichenkette trennt nicht", splitStatements(semicolon).length, 1);
  check(
    "und die Schranke dahinter bleibt lesbar",
    quotedValues(single([...tableStatements("t.sql", semicolon)[0].sql.matchAll(declarationOf("x"))])?.[2] ?? ""),
    ["p;q", "r"]
  );

  // Dieselbe Spalte, dieselbe Tabelle, zwei Migrationen: zwei Einträge. Das
  // ist der Fall, für den es dieses Verfahren gibt — vor B6/E4 hätte ihn
  // niemand gesehen, weil die zweite Datei nicht gelesen wurde.
  const first = tableStatements("006.sql", "ALTER TABLE b ADD COLUMN y text NOT NULL DEFAULT 'r' CHECK (y IN ('r'));");
  const second = tableStatements("012.sql", "ALTER TABLE b ADD COLUMN y text NOT NULL DEFAULT 's' CHECK (y IN ('s'));");
  check("zwei Migrationen an derselben Spalte sind zwei Anweisungen", [...first, ...second].length, 2);

  assert.deepEqual(findings, [], `Ein Leser dieses Wächters liest anders als zugesagt:\n${findings.join("\n")}`);
});


test("die Vorgabesätze tragen genau die Stellschrauben ihres scope", () => {
  // Kein zweiter Ort, an dem die Stellschrauben aufgezählt wären: beide Sätze
  // werden gegen THEME_KNOBS gehalten, und nicht gegen eine Liste in diesem
  // Wächter.
  assert.deepEqual(Object.keys(DEFAULT_GLOBAL_THEME).sort(), knobsInScope("global").sort());
  assert.deepEqual(Object.keys(DEFAULT_HOST_THEME).sort(), knobsInScope("host").sort());
  assert.deepEqual(Object.keys(DEFAULT_MARK_THEME).sort(), knobsInScope("mark").sort());
  assert.deepEqual(Object.keys(DEFAULT_STACK_DISPLAY).sort(), knobsInScope("stack").sort());

  // Und die Werte darin sind die `fallback`-Werte — sonst sagte der Vorgabesatz
  // etwas anderes als die Spalte, gegen die dieser Wächter ihn gerade geprüft
  // hat.
  //
  // ⚠️ Die vier Sätze werden hier übereinandergelegt, und das geht nur, weil
  // `hue` in `DEFAULT_HOST_THEME` und `DEFAULT_MARK_THEME` denselben Wert
  // trägt — es IST dieselbe Stellschraube mit demselben `fallback`. Der Fall
  // darunter hält genau das fest, damit ein auseinanderlaufender Vorgabewert
  // hier nicht vom Überschreiben verdeckt wird.
  const preset: Record<string, string> = {
    ...DEFAULT_GLOBAL_THEME,
    ...DEFAULT_HOST_THEME,
    ...DEFAULT_MARK_THEME,
    ...DEFAULT_STACK_DISPLAY
  };
  for (const knob of KNOBS) {
    assert.equal(preset[knob], THEME_KNOBS[knob].fallback as string, `Vorgabewert von „${knob}"`);
  }
});

test("eine Stellschraube mit zwei Reichweiten trägt in beiden Vorgabesätzen denselben Wert", () => {
  // ⚠️ Der Fall, den das Überschreiben oben verdecken würde. `hue` steht in
  // `DEFAULT_HOST_THEME` UND in `DEFAULT_MARK_THEME`; stünde dort einmal
  // „neutral" und einmal „blue", gewönne beim Zusammenlegen der letzte, und
  // der Wächter oben bliebe grün — während der Editor einer Marke einen
  // anderen Vorgabewert zeigte als die Migration setzt.
  const sets: Record<string, Record<string, string>> = {
    global: { ...DEFAULT_GLOBAL_THEME },
    host: { ...DEFAULT_HOST_THEME },
    mark: { ...DEFAULT_MARK_THEME },
    stack: { ...DEFAULT_STACK_DISPLAY }
  };

  const shared = KNOBS.filter((knob) => THEME_KNOBS[knob].scope.length > 1);
  // Ohne diese Zusicherung liefe der Fall leer, sobald jemand `scope` wieder
  // zu einem einzelnen Namen macht — und wäre grün, ohne etwas geprüft zu
  // haben.
  assert.deepEqual(shared, ["hue"], "erwartet wird genau eine Stellschraube mit mehr als einer Reichweite: hue");

  for (const knob of shared) {
    for (const scope of THEME_KNOBS[knob].scope as readonly string[]) {
      assert.equal(
        sets[scope][knob],
        THEME_KNOBS[knob].fallback as string,
        `Vorgabewert von „${knob}" im Satz der Reichweite „${scope}"`
      );
    }
  }
});

test("der SQL-Leser selbst: was er sehen muss und was nicht", () => {
  // Ein Wächter ohne eigenen Test ist eine Behauptung — und dieser Leser ist
  // der riskante: er entfernt Kommentare und zählt Treffer.
  const findings: string[] = [];
  const check = (description: string, actual: unknown, expected: unknown) => {
    try {
      assert.deepEqual(actual, expected);
    } catch {
      findings.push(`${description}: bekam ${JSON.stringify(actual)}, erwartet ${JSON.stringify(expected)}`);
    }
  };

  const counts = (sql: string, column: string) =>
    [...sql.matchAll(ANY_CHECK_IN)].filter((found) => found[1] === column).length;

  const bait =
    "-- ⚠️ Die Form ist CHECK (hue IN ('amber', 'gold')) und steht an der Spalte.\n" +
    "  hue text NOT NULL DEFAULT 'neutral' CHECK (hue IN ('amber', 'neutral'));";
  check("der Köder im --Kommentar fällt weg", counts(stripSqlComments(bait), "hue"), 1);
  check(
    "und die echte Schranke bleibt lesbar",
    quotedValues(single([...stripSqlComments(bait).matchAll(declarationOf("hue"))])?.[2] ?? ""),
    ["amber", "neutral"]
  );

  const blockBait = "/* CHECK (ink IN ('gold')) */\n  ink text NOT NULL DEFAULT 'head' CHECK (ink IN ('head'));";
  check("ein Blockkommentar trägt ihn ebenso wenig herein", counts(stripSqlComments(blockBait), "ink"), 1);

  // ⚠️ Die Verdopplung. Ohne sie wäre der Leser ab hier um eine Zeichenkette
  // verschoben und läse den Rest der Datei als Zeichenkette — also gar nichts.
  const doubled = "INSERT INTO t VALUES ('don''t -- kein Kommentar');\n  ink text NOT NULL DEFAULT 'head' CHECK (ink IN ('head', 'card'));";
  check("ein verdoppeltes Anführungszeichen beendet die Zeichenkette nicht", counts(stripSqlComments(doubled), "ink"), 1);
  check(
    "und die Schranke dahinter bleibt lesbar",
    quotedValues(single([...stripSqlComments(doubled).matchAll(declarationOf("ink"))])?.[2] ?? ""),
    ["head", "card"]
  );

  // Zwei echte Schranken sind zwei Treffer — und damit rot, nicht „die erste
  // gewinnt".
  const twoReal =
    "  ink text NOT NULL DEFAULT 'head' CHECK (ink IN ('head'));\n" +
    "ALTER TABLE t ADD CONSTRAINT c CHECK (ink IN ('head', 'card'));";
  check("zwei echte Schranken sind zwei Treffer", counts(stripSqlComments(twoReal), "ink"), 2);

  // ⚠️ Der Deklarationsleser sieht die zweite NICHT — sie steht als eigenes
  // `ADD CONSTRAINT` und trägt keine Spaltendeklaration. Genau deshalb gibt es
  // den weit gefassten Zähler daneben: er ist die Hälfte, die diesen Fall
  // fängt, und ohne ihn wäre der erste Treffer wieder die Wahrheit.
  check(
    "der Deklarationsleser allein sähe nur die erste",
    quotedValues(single([...stripSqlComments(twoReal).matchAll(declarationOf("ink"))])?.[2] ?? ""),
    ["head"]
  );

  // Zwei Treffer sind KEIN Treffer — das ist die Regel, an der der weit
  // gefasste Zähler hängt.
  check("zwei Treffer sind kein Treffer", single([1, 2]), null);
  check("genau einer ist einer", single([1]), 1);

  check("der DEFAULT wird mitgelesen", single([...stripSqlComments(bait).matchAll(declarationOf("hue"))])?.[1], "neutral");

  assert.deepEqual(findings, [], `Ein Leser dieses Wächters liest anders als zugesagt:\n${findings.join("\n")}`);
});
