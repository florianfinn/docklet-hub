import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stripComments } from "./strip-comments.mjs";

// UI-Texte stehen in Sprachdateien, nicht im Code (AGENTS.md).
//
// Dieser Wächter ist GENAU JETZT gratis: es gibt noch keinen einzigen
// Bildschirm. Ab dem ersten fest verdrahteten Text wäre er keine Sperrklinke
// mehr, sondern eine Migration — und die wird erfahrungsgemäß nie vollständig.
//
// GEPRÜFT WIRD: Textknoten in JSX (`>Text<`) und die sechs Eigenschaften, die
// sichtbaren Text tragen — jeweils im Rumpf OHNE KOMMENTARE.
//
// ⚠️ GELESEN WIRD NUR `git ls-files "web/src/*.tsx"` — allein die
// .tsx-Dateien unter `web/src/`, siehe die Schleife unten. Hier stand, die
// Mechanik der i18n-Schicht (`languages.ts`, `index.ts`) halte diese Regel
// „wie jede andere Datei". Nachgemessen war das falsch: eine `.ts`-Datei
// erreicht dieser Wächter überhaupt nicht.
//
// Das ist eine OFFENE LÜCKE, hier benannt statt in einer Behauptung versteckt:
// ein fest verdrahteter deutscher Text in einer `.ts`-Datei fällt durch. Die
// Erweiterung auf `.ts` ist gemessen NICHT folgenlos — `TEXT_NODES` meldet auf
// `web/src/api/client.ts` einen Fehlalarm an der Signatur
// `(path: string, body: unknown): Promise` —, sie braucht also erst Arbeit am
// Erkenner und ist ein eigenes Paket.
//
// ⚠️ DER ERLAUBTE ORT IST `web/src/platform/i18n/messages/`, nicht die ganze
// `i18n`-Schicht. Mit der Sprachumschaltung (#70) zerfällt `web/src/platform/i18n/` in
// zwei Dinge: die Sprachdateien unter `messages/` — dort GEHÖRT der Text hin —
// und die Mechanik daneben (`LanguageProvider.tsx`, `languages.ts`,
// `index.ts`). Wäre `web/src/platform/i18n/` als Ganzes ausgenommen, dürfte
// ausgerechnet im Anbieter der Sprachen ein fester Text legal stehen. Für
// `LanguageProvider.tsx` greift die Regel damit wirklich; für `languages.ts`
// und `index.ts` erst, wenn die Lücke oben geschlossen ist.
//
// ⚠️ NICHT geprüft und bewusst so:
//   - `web/index.html` — kein JSX. Der Seitentitel dort war die einzige
//     Ausnahme im Repo, SOLANGE er der Titel war. Mit #70 setzt
//     `LanguageProvider` `document.title` aus den Sprachdateien; das `title`-
//     Element in `index.html` ist danach nur noch der Stand VOR dem ersten
//     Rendern — das, was im Reiter steht, bis React übernimmt. Es ist damit
//     keine Ausnahme mehr, die mitwandert, sondern ein Startwert, den eine
//     Sprachdatei ablöst, sobald die Oberfläche steht.
//   - über Variablen zusammengesetzte Texte. Wer die Regel umgehen will, kann
//     das; dieser Test hält den Normalfall, nicht den Vorsatz.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Der erlaubte Ort. Als Konstante, weil er in der Ausnahme UND in der Meldung
// derselbe sein muss: laufen die beiden auseinander, nennt der Wächter einen
// Ort, an dem er selbst nicht nachsieht.
const MESSAGES_DIRECTORY = "web/src/platform/i18n/messages/";

// ⚠️ `lead` und `error` sind mit D4 dazugekommen und tragen SICHTBAREN TEXT
// wie die vier davor: `AuthCard` (`web/src/screens/AuthCard.tsx`) rendert
// `lead` als Absatz unter der Überschrift und `error` als `<p role="alert">`
// über den Feldern. Beide sind Eigenschaften eines eigenen Bauteils und
// heißen deshalb nicht nach einem HTML-Attribut — für den, der sie setzt, ist
// das kein Unterschied: ein deutscher Satz darin ist derselbe fest
// verdrahtete Text wie in `title`.
//
// Gemessen am 2026-09-05, beide als Literal in `SignInScreen.tsx` gesetzt
// (`lead="Bitte melden Sie sich an" error="Falsches Kennwort"`): dieser
// Wächter blieb grün (`# tests 2 / # pass 2 / # fail 0`). Ein Textknoten wäre
// gefunden worden, ein Attribut nicht — die Lücke saß genau an der Stelle, an
// der D4 zwei neue Texteigenschaften eingeführt hat.
//
// ⚠️ WARUM `error` DAZUGEHÖRT, obwohl es heute überall `t(…)` oder `null`
// trägt: genau das ist der Grund. Der Wert ist BEREITS ein übersetzter Text —
// ein Literal an dieser Stelle wäre kein anderer Fall, sondern derselbe
// Fehler. Nachgesehen am 2026-09-05: im ganzen Baum steht `error=` zweimal,
// beide Male als Ausdruck (`error={error}`), und `lead=` einmal
// (`lead={t("setupLead")}`). Die Erweiterung kostet also heute keinen
// Fehlalarm und schließt morgen den bequemen Weg.
const TEXT_ATTRIBUTES = /\b(title|placeholder|alt|aria-label|lead|error)=(["'])([^"']*\p{L}[^"']*)\2/gu;

// ⚠️ Die beiden Rückschauen sind kein Feinschliff, sondern schließen einen
// Fehlalarm, der den Wächter sonst untergräbt.
//
// Ohne sie liefert jeder Operator ein öffnendes `>` und jede Typangabe ein
// schließendes `<` — `(a) => a.json() as Promise<Health>` wurde als fest
// verdrahteter Text gemeldet, ebenso `a >= b && c < d`. Ein Fehlalarm ist
// hier teurer als eine Lücke: wer ihn trifft, hat zwei Auswege — den Code
// verbiegen oder den Wächter lockern —, und der zweite kostet die Regel.
//
// Unterschieden wird am Zeichen VOR dem `>`, weil genau dort der Unterschied
// sitzt: ein Tag schließt mit `p>`, `"x">`, `}>` oder `/>`, ein Operator steht
// hinter `=` oder einem Leerzeichen. Der Zeilenumbruch bleibt ausdrücklich
// erlaubt — ein Tag mit vielen Attributen trägt sein `>` allein auf einer
// Zeile, und dessen Text soll weiterhin gefunden werden.
//
// Bekannte Grenze: ein Vergleich ohne Leerzeichen (`a> b`) fällt wieder durch.
// Dieser Wächter hält den Normalfall, nicht den Vorsatz.
const TEXT_NODES = /(?<!=)(?<![^\S\n])>(\s*[^<>{}\n]*\p{L}[^<>{}]*)</gu;

// Zeichen, die in einem sichtbaren Text praktisch nicht vorkommen und in Code
// ständig — sie trennen die beiden Fälle, die die Rückschauen oben nicht
// auseinanderhalten können.
//
// ⚠️ Aufgefallen am ersten echten Bildschirm, und zwar an zwei Stellen, die
// beide gewöhnlicher React-Code sind:
//
//   1. Zwei Zustände hintereinander, deren Typangabe auf `null>` endet:
//      `useState<A | null>(null);` schließt mit `l>`, die nächste Zeile
//      öffnet mit `useState<`, und dazwischen stehen Buchstaben.
//   2. Eine verschachtelte Bedingung zwischen zwei Elementen:
//      `</p>\n ) : a === null ? (\n <p`.
//
// Beide tragen `=` oder `;`, kein echter Textknoten der Sprachdateien tut das.
// Die Grenze davon ist ehrlich zu nennen: ein sichtbarer Text MIT Semikolon
// („Wird geladen; bitte warten") rutscht damit durch. Das ist die kleinere
// Lücke — ein Fehlalarm an gewöhnlichem Code drängt den nächsten dazu, die
// Regel zu lockern, statt ihr zu folgen.
const CODE_CHARACTERS = /[=;]/;

// Die zweite Ausnahme, und sie ist enger geschnitten als die erste: eine
// Bedingungskette zwischen zwei Elementen, deren mittlerer Zweig WEDER `=`
// NOCH `;` trägt.
//
// ⚠️ Gemessen am 2026-09-05 an `web/src/screens/OverviewScreen.tsx` aus Paket
// D5: aus
//
//     </p>
//     ) : !loaded ? (
//     <p
//
// wird der Textknoten „) : !loaded ? (" — `CODE_CHARACTERS` greift nicht, weil
// eine Verneinung ohne Vergleich auskommt. Der D3-Fall („) : a === null ? (")
// fiel nur deshalb durch die erste Ausnahme, weil dort zufällig ein `===`
// stand.
//
// Erkannt wird am ANFANG des Fundes und nicht an einem Zeichen irgendwo darin:
// eine solche Kette beginnt immer mit der schließenden Klammer des vorigen
// Zweigs, gefolgt von `:` oder `?`. Ein sichtbarer Text beginnt so nicht.
// Deshalb bleibt „Achtung (hier): ein Hinweis" weiterhin ein Befund — die
// Klammer steht dort mitten im Satz, nicht am Anfang. Beide Fälle stehen im
// Selbsttest unten.
const JSX_TERNARY = /^\)\s*[:?]/;

// ⚠️ `stripComments` aus `./strip-comments.mjs` steht hier nicht als
// Feinschliff: die beiden Erkenner oben lesen SPITZE KLAMMERN und
// ANFÜHRUNGSZEICHEN, und beides kommt in einem deutschen Kommentar über JSX
// ständig vor. Zwei echte Fehlalarme aus Paket D3, beide im Selbsttest unten
// wörtlich nachgestellt:
//
//   1. ein Kommentar, der die Landmarke `main` ZWEIMAL in spitzen Klammern
//      nennt — zwischen dem schließenden `>` der ersten Nennung und dem
//      öffnenden `<` der zweiten steht deutsche Prosa, und die sieht für
//      `TEXT_NODES` aus wie ein Textknoten,
//   2. der Herkunftskopf von `web/src/platform/ui/shadcn/breadcrumb.tsx`, der die
//      abgelöste Vorlagenzeile `aria-label="breadcrumb"` ZITIERT — für
//      `TEXT_ATTRIBUTES` ist das Zitat vom Original nicht zu unterscheiden.
//
// Damals wurden beide Male die KOMMENTARE umformuliert. Das war im laufenden
// Paket richtig und als Dauerlösung falsch: es verlangt von jedem, der über
// JSX schreibt, dass er die Erkenner dieses Wächters im Kopf hat. Ein Wächter,
// der die Sprache seiner eigenen Doku verbietet, wird umgangen, nicht befolgt.

// Die Fundstellen einer Datei, als Beschreibung je Treffer.
//
// EINE Funktion für den Wächter UND seinen Selbsttest: standen beide Schleifen
// getrennt da, prüfte der Selbsttest am Ende einen anderen Erkenner als den,
// der läuft. Aus demselben Grund steht `stripComments()` HIER und nicht in der
// Schleife über die Dateien — sonst liefe der Selbsttest über einen Rumpf, den
// es im Betrieb nicht gibt.
function findTexts(source) {
  const content = stripComments(source);
  const findings = [];
  for (const match of content.matchAll(TEXT_NODES)) {
    const text = match[1].trim();
    if (CODE_CHARACTERS.test(text) || JSX_TERNARY.test(text)) continue;
    findings.push({ kind: "node", text });
  }
  for (const match of content.matchAll(TEXT_ATTRIBUTES)) {
    findings.push({ kind: "attribute", attribute: match[1], text: match[3] });
  }
  return findings;
}

function describe(finding) {
  return finding.kind === "node"
    ? `Textknoten „${finding.text}"`
    : `${finding.attribute}="${finding.text}"`;
}

test("kein UI-Text steht fest im JSX", () => {
  const files = execFileSync("git", ["ls-files", "web/src/*.tsx"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    // Die Sprachdateien SIND der erlaubte Ort — sie allein, nicht die
    // `i18n`-Schicht um sie herum.
    .filter((path) => !path.startsWith(MESSAGES_DIRECTORY));

  // Der Wächter darf nicht dadurch grün werden, dass er nichts liest.
  assert.ok(
    files.length > 0,
    "git ls-files lieferte keine einzige .tsx-Datei unter web/src/ — der Wächter liefe ins Leere"
  );

  const findings = [];
  for (const path of files) {
    const content = readFileSync(new URL(path, `file://${ROOT}`), "utf8");
    for (const finding of findTexts(content)) {
      findings.push(`${path}: ${describe(finding)}`);
    }
  }

  assert.deepEqual(
    findings,
    [],
    `UI-Texte gehören nach ${MESSAGES_DIRECTORY} oder in die Sprachdateien eines Features (web/src/features/<name>/messages/), nicht ins JSX:\n${findings.join("\n")}`
  );
});

test("der Erkenner selbst: was er fangen muss und was nicht", () => {
  // Ein Wächter ohne eigenen Test ist eine Behauptung. Dieser hier hatte einen
  // Fehlalarm, der beim ersten echten Bildschirm auffiel — und ein Fehlalarm
  // ist gefährlicher als eine Lücke: er drängt den nächsten dazu, die Regel zu
  // lockern, statt ihr zu folgen.
  //
  // Die Fälle unten sind deshalb beides: die Lücke UND der Fehlalarm.
  const cases = [
    // [Beschreibung, Code, soll gefunden werden]
    ["einzeiliger Text", "<p>Hallo Welt</p>", true],
    ["mehrzeiliger Text", "<p>\n  Hallo Welt\n</p>", true],
    ["Text nach einem Pfeil ins JSX", "items.map((i) => <li>Hallo</li>)", true],
    ["Text nach einem Attribut", '<a href="/x">Zur Übersicht</a>', true],
    ["Text nach einer Verteilung", "<X {...rest}>Hallo</X>", true],
    ["Tag über mehrere Zeilen, Klammer allein", "<Zeile\n  name={n}\n>\n  Hallo Welt\n</Zeile>", true],
    ["sichtbares Attribut", '<img alt="Ein Bild" />', true],
    // Die beiden Texteigenschaften aus D4, wörtlich der Fall, der grün blieb.
    ["Text in lead", '<AuthCard lead="Bitte melden Sie sich an" />', true],
    ["Text in error", '<AuthCard error="Falsches Kennwort" />', true],
    // Und die Gegenprobe: als Ausdruck geschrieben ist beides richtig.
    ["lead aus der Sprachdatei", '<AuthCard lead={t("setupLead")} />', false],
    ["error als Zustand", "<AuthCard error={error} />", false],
    ["Text aus der Sprachdatei", "<p>{texte.titel}</p>", false],
    ["Typangabe hinter einem Pfeil", "fetch(u).then((a) => a.json() as Promise<Health>)", false],
    ["Typangabe an einem Aufruf", "const [z, setZ] = useState<Zustand>(null);", false],
    ["Größer-gleich, kein Tag", "if (a >= b && c < d) return null;", false],
    ["schlichter Vergleich in JSX-Klammern", "{anzahl > 0 && sichtbar && <Liste />}", false],
    // Die zwei Fehlalarme vom ersten echten Bildschirm. Beide sind
    // gewöhnlicher React-Code und beide tragen `=` oder `;`.
    [
      "zwei Zustände mit Typangabe auf null>",
      "const [a, setA] = useState<X | null>(null);\n  const [b, setB] = useState<Y | null>(null);",
      false
    ],
    ["verschachtelte Bedingung zwischen zwei Elementen", "</p>\n  ) : a === null ? (\n  <p", false],
    // Der Fall aus D5: dieselbe Kette, aber der mittlere Zweig ist eine
    // Verneinung und trägt deshalb weder `=` noch `;`.
    ["Bedingungskette mit einer Verneinung im mittleren Zweig", "</p>\n  ) : !loaded ? (\n  <p", false],
    // Und die Gegenprobe dazu: eine Klammer MITTEN im Satz ist kein Code.
    ["Text mit einer Klammer und einem Doppelpunkt", "<p>Achtung (hier): ein Hinweis</p>", true],
    // ⚠️ Und die Gegenprobe: ein echter Text mit Satzzeichen muss weiterhin
    // fallen. Ohne diesen Fall wäre der Ausschluss oben ein Freibrief.
    ["Text mit Komma und Doppelpunkt", "<p>Achtung, hier: ein Hinweis</p>", true],

    // ── Die zwei echten Fehlalarme aus Paket D3, wörtlich ─────────────────
    //
    // Beide sind der Grund für `stripComments()`. Beide sind mit dem heutigen
    // Erkenner NACHGEMESSEN rot — ein Selbsttestfall, der auch ohne die
    // Änderung grün wäre, sicherte nichts.
    //
    // Fall 1: der Kommentar aus `web/src/screens/OverviewScreen.tsx` in der
    // Fassung, die die Landmarke ZWEIMAL in spitzen Klammern nennt. Zwischen
    // dem `>` der ersten und dem `<` der zweiten Nennung steht deutsche
    // Prosa, und `CODE_CHARACTERS` greift nicht, weil weder `=` noch `;`
    // darin vorkommt. Genau deshalb wurde diese Formulierung damals
    // vermieden, statt den Wächter anzufassen (siehe b5ed2d8).
    [
      "Kommentar, der die Landmarke zweimal in spitzen Klammern nennt",
      "  // Die Schale liefert das `<main>` bereits über `SidebarInset` und dieser\n" +
        "  // Bildschirm trägt deshalb selbst kein zweites `<main>`.",
      false
    ],
    // Fall 2: der Herkunftskopf von `web/src/platform/ui/shadcn/breadcrumb.tsx` in
    // seiner ersten Fassung. Er ZITIERT die abgelöste Vorlagenzeile — und
    // wurde dafür als fest verdrahtetes Attribut gemeldet (e47d4fc).
    //
    // ⚠️ Die beiden Zeilen stehen MIT ihrem Blockkommentar drumherum. Das ist
    // keine Bequemlichkeit: `stripComments()` entfernt Kommentare, nicht
    // Zeilen, die aussehen wie welche. Ein Ausschnitt ohne `/**` und `*/` wäre
    // für den Entferner gewöhnlicher Quelltext — der Fall wäre grün, ohne
    // etwas über den Betrieb zu sagen.
    [
      "Herkunftskopf, der ein abgelöstes aria-label zitiert",
      "/**\n" +
        ' * - Das `aria-label="breadcrumb"` von `Breadcrumb` und der `sr-only`-Text\n' +
        ' *   „More" von `BreadcrumbEllipsis` über `texts.uiBreadcrumbNav` und\n' +
        " */",
      false
    ],
    // ⚠️ Die Gegenprobe zu `stripComments()`: ein `//` INNERHALB einer
    // Zeichenkette ist kein Kommentar. Verschluckte der Entferner die Zeile
    // ab der URL, fiele der echte Textknoten dahinter still aus der Prüfung —
    // der Wächter wäre leiser geworden, nicht genauer. Jeder Herkunftskopf
    // unter `web/src/platform/ui/shadcn/` trägt so eine URL.
    [
      "URL in einer Zeichenkette verdeckt keinen Text dahinter",
      'const quelle = "https://ui.shadcn.com/r/breadcrumb.json"; return <p>Fertig</p>;',
      true
    ],
    // Und derselbe Fall für das Attribut: `aria-label` hinter einer URL in
    // derselben Zeile muss weiterhin fallen.
    [
      "Attribut hinter einer URL in derselben Zeile",
      'const quelle = "https://ui.shadcn.com/r/breadcrumb.json"; <nav aria-label="Brotkrümel" />',
      true
    ],
    // Ein Blockkommentar verdeckt nichts, was hinter ihm steht.
    ["Text nach einem Blockkommentar", "/* ein Hinweis */ <p>Hallo Welt</p>", true],
    // Und ein echter Text IM Blockkommentar bleibt draußen.
    ["Textknoten im Blockkommentar", "/*\n * <p>Hallo Welt</p>\n */", false]
  ];

  const deviations = [];
  for (const [description, code, shouldMatch] of cases) {
    const found = findTexts(code);
    if (found.length > 0 !== shouldMatch) {
      deviations.push(
        `${description}: erwartet ${shouldMatch ? "Treffer" : "keinen Treffer"}, bekam ${JSON.stringify(found)}`
      );
    }
  }
  assert.deepEqual(deviations, [], `Der Erkenner verhält sich anders als zugesagt:\n${deviations.join("\n")}`);
});
