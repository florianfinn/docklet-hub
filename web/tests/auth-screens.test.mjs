import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stripComments } from "./strip-comments.mjs";

// Wächter über die beiden Formularbildschirme aus D4: `AuthCard`,
// `SignInScreen`, `SetupScreen` und die Löschung von `form.tsx`.
// Vertrag: `scratchpad/d4-spec.md`, Abschnitte 2, 3 und 8.
//
// ⚠️ DIESER WÄCHTER IST AUS DEM SCHNITT GESCHRIEBEN, NICHT AUS DEM CODE.
// Die Dateien, die er prüft, entstehen PARALLEL in anderen Bauabschnitten
// (Agent C: `AuthCard`, Agent D: die beiden Bildschirme und die Löschung).
// Sie wurden beim Schreiben dieses Wächters bewusst nicht gelesen. Ein
// Wächter, der vom fertigen Code abgeschrieben ist, prüft nur, dass der Code
// so ist, wie er ist; dieser hier prüft, dass der Code hält, was zugesagt
// war. Solange die Dateien fehlen, MUSS er verständlich rot werden — mit
// einer Meldung, die die fehlende Datei nennt — und NICHT mit einem
// ENOENT-Stapel von Node, der wie ein kaputter Test aussieht. Deshalb steht
// vor jedem Lesen ein eigenes `assert.ok(existsSync(...))`.
//
// GEPRÜFT WIRD, vier Zusicherungen, nicht mehr (Vertrag, Abschnitt 8):
//   1. `web/src/app/screens/form.tsx` existiert nicht mehr, und KEINE Datei
//      importiert `./form` oder `../screens/form`,
//   2. genau ein `<main>` auf jedem Weg: `AuthCard` setzt es, `PlainShell`
//      nicht, und die beiden Bildschirme im Inneren auch nicht,
//   3. KEIN Bildschirm vor der Anmeldung ruft `change` — der Umschalter der
//      Fußzeile ruft `adopt`,
//   4. `LANGUAGE_LABEL_KEYS` wird genau einmal im Baum deklariert.
//
// ⚠️ GELESEN WIRD ÜBER `readdirSync`, NICHT ÜBER `git ls-files`. Die übrigen
// Wächter dieses Repos zählen den Bestand über `git ls-files`; eine Datei,
// die noch nicht mit `git add` erfasst ist, ist für die deshalb UNSICHTBAR
// (gemessen in D2). Genau das ist hier der Normalfall: dieser Wächter läuft
// gleichzeitig mit den Agenten, die seine Dateien erst anlegen, und der
// Leitstand fügt sie erst danach hinzu. Ein Lauf über `git ls-files` zeigte
// in diesem Fenster ein zu freundliches Bild — er fände weder ein neu
// angelegtes `AuthCard.tsx` mit einem zweiten `<main>` noch einen frisch
// geschriebenen Aufruf von `change`. Der Verzeichnisdurchlauf sieht beides.
//
// ⚠️ NICHT geprüft und bewusst so:
//   - ob `AuthCard` seine Bausteine aus D2 nimmt, wie die Fußzeile aussieht,
//     ob die Fassungsnummer ankommt — das ist das Artboard und Abschnitt 4,
//     nicht dieser Test.
//   - ob der Sprachumschalter tatsächlich in der FUSSZEILE steht. Geprüft
//     wird, dass in `AuthCard.tsx` `adopt` steht und `change` nirgends —
//     nicht, an welcher Stelle des Baums die Schaltflächen hängen.
//   - ob `LANGUAGES` statt zweier Literale die Liste liefert (Abschnitt 3).
//     Das wäre eine fünfte Zusicherung; sie steht nicht in Abschnitt 8 und
//     wird hier deshalb nicht behauptet.
//   - ob ein `<main>` über einen fremden Baustein hereinkommt. `AppShell`
//     bezieht seins aus `SidebarInset` (`web/src/platform/ui/shadcn/sidebar.tsx`);
//     dieser Test liest den Quelltext der vier genannten Dateien und keinen
//     Aufrufbaum. Ein `<main>`, das ein Baustein MITBRINGT, sähe er nicht.
//
// ⚠️ VIER LÜCKEN, DIE OFFEN BLEIBEN. Ein Prüfer hat sie am 2026-09-05 mit je
// einer Probe nachgewiesen; die Kette blieb jedes Mal grün. Sie stehen hier,
// weil eine Lücke, die man kennt, etwas anderes ist als eine, die man für
// geschlossen hält — geschlossen werden sie nicht, weil das statisch nur mit
// Fehlalarmen ginge, und ein Fehlalarm kostet am Ende die ganze Regel:
//
//   1. `<main>` AN BELIEBIGER STELLE. Geprüft werden vier Orte. Der Prüfer hat
//      je ein `<main>` in `web/src/App.tsx` und in `web/src/platform/ui/shadcn/card.tsx`
//      untergebracht — beide unsichtbar für diesen Test. Verlässlich wäre nur
//      ein Zählen über alle Renderwege, und das ist statisch nicht zu haben:
//      welcher Baustein unter welcher Bedingung was rendert, weiß erst der
//      Browser.
//   2. `form.tsx` UNTER NEUEM NAMEN ZURÜCK. Prüfung 1 kennt den Pfad, nicht
//      die Sache. Eine `form-fields.tsx` mit demselben rohen Markup ist
//      derselbe Rückschritt und geht durch. Dasselbe gilt für Prüfung 4: eine
//      ZWEITE Sprachzuordnung unter anderem Namen ist keine Kopie von
//      `LANGUAGE_LABEL_KEYS` und fällt nicht auf. Ein Wächter gegen „dieselbe
//      Sache unter anderem Namen" müsste Bedeutung lesen, nicht Text.
//   3. DIE FASSUNG IN `web/vite.config.ts`. Kein Wächter dieses Repos liest
//      die Datei — nachgesehen am 2026-09-05. Der Wert, den `AuthCard` als
//      `__HUB_VERSION__` in der Fußzeile anzeigt, darf dort also frei erfunden
//      werden (`"0.0.0-unbekannt"`), ohne dass etwas rot wird. Das ist keine
//      Aussage über die Anzeige, sondern über ihre Quelle.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const SOURCE_ROOT = "web/src";

const FORM_PATH = "web/src/screens/form.tsx";
const AUTH_CARD_PATH = "web/src/features/account/AuthCard.tsx";
const SIGN_IN_PATH = "web/src/features/account/SignInView.tsx";
const SETUP_PATH = "web/src/features/account/SetupView.tsx";
const SCREENS_ROOT = "web/src/app/screens";
// The two forms before the sign-in live in the feature `account` since #269, so
// the guard of `change` reads it next to the screens.
const ACCOUNT_ROOT = "web/src/features/account";
const APP_SHELL_PATH = "web/src/app/shell/AppShell.tsx";
const LANGUAGE_LABELS_PATH = "web/src/platform/i18n/language-labels.ts";

// Liest eine Datei und meldet FEHLT verständlich, statt mit einer
// Node-eigenen ENOENT-Meldung abzustürzen. Die Dateien dieses Pakets
// entstehen parallel und existieren in diesem Worktree möglicherweise noch
// nicht — das ist der Normalfall, kein Bug in diesem Test.
function readOrFail(relativePath, hint) {
  const absolute = new URL(relativePath, `file://${ROOT}`);
  assert.ok(
    existsSync(absolute),
    `Datei fehlt: ${relativePath} — ${hint}`
  );
  return readFileSync(absolute, "utf8");
}

// ⚠️ `stripComments` kommt aus `./strip-comments.mjs` und wird hier
// gebraucht, nicht nur zum Feinschliff: die Erkenner unten lesen `<main`,
// `change` und `LANGUAGE_LABEL_KEYS`, und alle drei kommen in den deutschen
// Kommentaren dieses Repos ständig vor. Der Vertrag selbst verlangt in
// Abschnitt 3 eine Begründung im Code, warum `adopt` und nicht `change`
// gerufen wird — ein Wächter, der genau diesen Kommentar rot macht, verbietet
// die Sprache seiner eigenen Doku und wird umgangen, nicht befolgt.
// `AppShell.tsx` nennt `PlainShell` heute viermal im Kommentar und einmal in
// der Deklaration; ohne den Entferner träfe die Suche nach dem Rumpf den
// ersten Kommentar.

// Alle Quelldateien unter `web/src/` — über das DATEISYSTEM, aus dem oben
// genannten Grund. Sortiert, damit die Meldung bei zwei Läufen dieselbe
// Reihenfolge trägt und ein Unterschied ein echter Unterschied ist.
function collectSourceFiles(relativeDirectory, extensions) {
  const absolute = new URL(`${relativeDirectory}/`, `file://${ROOT}`);
  if (!existsSync(absolute)) return [];
  const found = [];
  const entries = readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const entry of entries) {
    const relative = `${relativeDirectory}/${entry.name}`;
    const target = new URL(relative, `file://${ROOT}`);
    if (entry.isDirectory() || statSync(target).isDirectory()) {
      found.push(...collectSourceFiles(relative, extensions));
      continue;
    }
    if (extensions.some((extension) => entry.name.endsWith(extension))) {
      found.push(relative);
    }
  }
  return found;
}

// Zeilennummer zu einer Fundstelle. Ohne sie meldet ein Wächter mehrere
// Treffer in derselben Datei als mehrfach denselben Satz, und niemand weiß,
// wo er nachsehen soll.
function lineOf(content, index) {
  return content.slice(0, index).split("\n").length;
}

// Schneidet den Rumpf einer Deklaration heraus: vom Namen bis zur nächsten
// Deklaration auf Spaltenanfang oder bis zum Dateiende. Kein Parser — es
// reicht, weil in diesem Repo jede Komponente auf Spalte 0 beginnt.
function sliceDeclaration(content, name) {
  const start = content.search(
    new RegExp(`^(?:export\\s+)?(?:function|const)\\s+${name}\\b`, "m")
  );
  if (start === -1) return null;
  const rest = content.slice(start + 1);
  const next = rest.search(/^(?:export\s+)?(?:function|const|class)\s+[A-Za-z_$]/m);
  return next === -1 ? content.slice(start) : content.slice(start, start + 1 + next);
}

// ---------------------------------------------------------------------------
// 1. `form.tsx` ist gelöscht, nicht danebengelegt
// ---------------------------------------------------------------------------
//
// ZWECK: `form.tsx` trug die alten Anmelde- und Erstanmeldeformulare in EINER
// Datei; der Kopfkommentar der Datei sagt selbst, dass sie ersetzt und nicht
// vergrößert werden soll. D4 zerlegt sie in `AuthCard` plus zwei Bildschirme
// (Vertrag, Abschnitt 1 und 7).
//
// FÄNGT: die halbe Löschung. Eine `form.tsx`, die liegen bleibt, weil „sie
// stört ja niemanden", und ein Import, der sie am Leben hält.
//
// OHNE DIESE PRÜFUNG: es gäbe zwei Anmeldeformulare im Baum — eins, das
// gepflegt wird, und eins, das keiner mehr ansieht, aber weiter kompiliert.
// Beim nächsten Fehler in der Anmeldung sucht jemand im falschen. Dazu käme
// der stille Nebeneffekt auf `languages`: die Textschlüssel, die nur
// `form.tsx` benutzt, gälten weiter als benutzt, und ein verwaister Schlüssel
// fiele erst Monate später auf.
test("form.tsx ist gelöscht und wird nirgends mehr importiert", () => {
  const findings = [];

  const formAbsolute = new URL(FORM_PATH, `file://${ROOT}`);
  if (existsSync(formAbsolute)) {
    findings.push(
      `${FORM_PATH} existiert noch — D4 löscht die Datei, es legt keine zweite daneben (Vertrag, Abschnitt 1)`
    );
  }

  const files = collectSourceFiles(SOURCE_ROOT, [".ts", ".tsx"]);
  // Der Wächter darf nicht dadurch grün werden, dass er nichts liest.
  assert.ok(
    files.length > 0,
    `keine einzige .ts/.tsx-Datei unter ${SOURCE_ROOT}/ gefunden — der Wächter liefe ins Leere`
  );

  // Jeder Modulbezeichner der Datei, egal ob statisch oder dynamisch. Gesucht
  // wird nach dem LETZTEN Wegstück: `./form`, `../screens/form`,
  // `@/screens/form` und jede Schreibweise mit Endung sind derselbe Verweis.
  const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;
  const FORM_MODULE = /(^|\/)form(\.tsx?)?$/;

  for (const path of files) {
    if (path === FORM_PATH) continue;
    const content = stripComments(readFileSync(new URL(path, `file://${ROOT}`), "utf8"));
    for (const match of content.matchAll(SPECIFIER)) {
      if (FORM_MODULE.test(match[1])) {
        findings.push(`${path}:${lineOf(content, match.index)}: importiert „${match[1]}"`);
      }
    }
  }

  assert.deepEqual(
    findings,
    [],
    `form.tsx wird gelöscht, nicht danebengelegt (Vertrag, Abschnitt 1):\n${findings.join("\n")}`
  );
});

// ---------------------------------------------------------------------------
// 2. Genau ein `<main>` auf jedem Weg
// ---------------------------------------------------------------------------
//
// ZWECK: `PlainShell` setzt bewusst kein `<main>`; bisher brachte `FormShell`
// es mit. Nach D4 muss `AuthCard` es mitbringen — sonst hat das Dokument in
// genau den zwei Zuständen „Anmeldung" und „Erstanmeldung" keine
// Hauptlandmarke (Vertrag, Abschnitt 2).
//
// FÄNGT: beide Richtungen desselben Fehlers. Keine Landmarke, weil jeder
// dachte, der andere setzt sie — und zwei Landmarken, weil beide sie setzen.
//
// OHNE DIESE PRÜFUNG: der Ausfall ist für den Sehenden unsichtbar. Die Seite
// sieht in beiden Fällen exakt gleich aus; nur wer mit einem Screenreader
// „zum Hauptteil springen" sagt, landet nirgends oder muss zwischen zwei
// Hauptteilen wählen. Genau deshalb braucht es eine Maschine dafür: ein
// Mensch, der die Seite ansieht, kann diesen Fehler nicht sehen.
//
// ⚠️ Gezählt wird das öffnende Tag `<main`, nicht ein Element, das ein
// Baustein mitbringt. `AppShell` bezieht seins über `SidebarInset` — das ist
// ein anderer Weg und nicht Gegenstand dieses Pakets.
test("genau ein <main>: AuthCard setzt es, PlainShell und die Bildschirme nicht", () => {
  const findings = [];

  const authCard = stripComments(
    readOrFail(
      AUTH_CARD_PATH,
      "der Rahmen beider Formularbildschirme, entsteht parallel (Vertrag, Abschnitt 2)"
    )
  );
  const mainCount = [...authCard.matchAll(/<main[\s>]/g)].length;
  if (mainCount !== 1) {
    findings.push(
      `${AUTH_CARD_PATH}: ${mainCount} × <main> — genau eins ist zugesagt, weil PlainShell keins mitbringt`
    );
  }

  const appShell = stripComments(
    readOrFail(APP_SHELL_PATH, "die Schale aus D3, sollte längst im Baum stehen")
  );
  const plainShell = sliceDeclaration(appShell, "PlainShell");
  if (plainShell === null) {
    findings.push(
      `${APP_SHELL_PATH}: Deklaration von PlainShell nicht gefunden — umbenannt oder verschoben?`
    );
  } else if (/<main[\s>]/.test(plainShell)) {
    findings.push(
      `${APP_SHELL_PATH}: PlainShell setzt ein <main> — dann trägt jeder Weg über AuthCard zwei (Vertrag, Abschnitt 2)`
    );
  }

  // Die beiden Bildschirme liegen INNERHALB von `AuthCard`. Ein `<main>` dort
  // wäre das zweite auf demselben Weg — derselbe Fehler, andere Datei.
  for (const path of [SIGN_IN_PATH, SETUP_PATH]) {
    const content = stripComments(
      readOrFail(path, "einer der beiden Formularbildschirme, entsteht parallel")
    );
    if (/<main[\s>]/.test(content)) {
      findings.push(
        `${path}: setzt ein <main>, obwohl AuthCard es schon mitbringt — zwei Landmarken auf einem Weg`
      );
    }
  }

  assert.deepEqual(
    findings,
    [],
    `Landmarke <main> (Vertrag, Abschnitt 2):\n${findings.join("\n")}`
  );
});

// ---------------------------------------------------------------------------
// 3. Der Sprachumschalter der Fußzeile ruft `adopt`, nirgends `change`
// ---------------------------------------------------------------------------
//
// ZWECK: das ist die eigentliche Zusage dieses Pakets (Vertrag, Abschnitt 3).
// Der Umschalter vor der Anmeldung SPEICHERT NICHT. `useLanguage()` liefert
// beides: `adopt` stellt die laufende Ansicht um, `change` schreibt über
// `PUT /session/language` ans Konto und setzt damit eine Sitzung voraus — vor
// der Anmeldung gibt es keine.
//
// FÄNGT: den Griff zum falschen der beiden. `change` ist der Aufruf, den man
// nimmt, wenn man „Sprache umstellen" liest und nicht weiter nachdenkt.
//
// OHNE DIESE PRÜFUNG: beide kompilieren, beide sehen im Code richtig aus,
// beide bestehen jeden anderen Wächter. Der Unterschied zeigt sich nur dem,
// der sich VOR der Anmeldung umstellt und danach in der Browserkonsole eine
// 401 sieht — und der schaut dort nicht hin, weil die Oberfläche die Sprache
// ja gewechselt hat. Der zweite Schaden ist der schleichende: ein zweiter
// gespeicherter Ort wirft die Frage auf, welcher gewinnt.
//
// ⚠️ Gelesen wird OHNE KOMMENTARE. Der Vertrag verlangt die Begründung im
// Code, und die muss `change` beim Namen nennen dürfen — in `AuthCard.tsx`
// steht das Wort genau dort ABSICHTLICH. Ein Wächter, der den begründenden
// Kommentar rot macht, verbietet die Sprache seiner eigenen Doku.
//
// ⚠️ GELESEN WIRD DER GANZE ORDNER `web/src/app/screens/`, nicht nur
// `AuthCard.tsx`. Die Zusage gilt keiner Datei, sondern JEDEM Bildschirm vor
// der Anmeldung: `useLanguage()` liefert `change` an jeden, der den Haken
// ruft, und ein `const { change } = useLanguage()` in `SetupScreen.tsx` ist
// derselbe 401 wie in der Fußzeile. Gemessen am 2026-09-05: genau dieser
// Aufruf, in `SetupScreen.tsx` untergebracht, ließ die ganze Kette grün
// (`# tests 91 / # pass 91 / # fail 0`), solange hier nur `AuthCard.tsx`
// gelesen wurde.
//
// Der Ordner trägt heute auch `OverviewScreen.tsx`, also einen Bildschirm
// NACH der Anmeldung, für den `change` das richtige der beiden wäre. Er ist
// hier trotzdem mitgeprüft, und das ist Absicht: die Alternative wäre eine
// Liste der „Bildschirme vor der Anmeldung", die beim nächsten neuen
// Bildschirm still veraltet. Wer `change` eines Tages nach der Anmeldung
// braucht, ruft es aus der angemeldeten Ansicht (`web/src/app/shell/`) — und
// entscheidet das dort, wo die Sitzung sicher steht, nicht nebenbei.
test("kein Bildschirm ruft change, und der Umschalter ruft adopt", () => {
  const screens = [SCREENS_ROOT, ACCOUNT_ROOT].flatMap((root) => collectSourceFiles(root, [".tsx"]));
  // Der Wächter darf nicht dadurch grün werden, dass er nichts liest.
  assert.ok(
    screens.length > 0,
    `keine .tsx-Datei unter ${SCREENS_ROOT}/ und ${ACCOUNT_ROOT}/ gefunden — der Wächter liefe ins Leere`
  );

  const findings = [];

  // Wortgrenze über Zeichenklassen statt `\b`, damit `onChange`, `handleChange`
  // und `LanguageChange` NICHT treffen: dort steht vor dem „c" ein Wortzeichen.
  // Ein `.change(` oder `{ change }` trifft dagegen, und genau darum geht es.
  const CHANGE_CALL = /(?<![\w$])change(?![\w$])/g;
  const ADOPT_CALL = /(?<![\w$])adopt(?![\w$])/g;

  for (const path of screens) {
    const content = stripComments(readFileSync(new URL(path, `file://${ROOT}`), "utf8"));
    for (const match of content.matchAll(CHANGE_CALL)) {
      findings.push(
        `${path}:${lineOf(content, match.index)}: „change" — dieser Aufruf schreibt über PUT /session/language ans Konto und endet vor der Anmeldung in 401 (Vertrag, Abschnitt 3)`
      );
    }
  }

  const cardContent = stripComments(
    readOrFail(
      AUTH_CARD_PATH,
      "trägt die Fußzeile mit dem Sprachumschalter, entsteht parallel (Vertrag, Abschnitt 3)"
    )
  );
  const adoptions = [...cardContent.matchAll(ADOPT_CALL)];
  if (adoptions.length === 0) {
    findings.push(
      `${AUTH_CARD_PATH}: „adopt" kommt nicht vor — der Umschalter stellt die laufende Ansicht dann über gar nichts um`
    );
  }

  assert.deepEqual(
    findings,
    [],
    `adopt statt change, in jedem Bildschirm (Vertrag, Abschnitt 3):\n${findings.join("\n")}`
  );
});

// ---------------------------------------------------------------------------
// 4. `LANGUAGE_LABEL_KEYS` steht genau einmal im Baum
// ---------------------------------------------------------------------------
//
// ZWECK: die Zuordnung Sprache → Textschlüssel stand bis D4 in
// `AppSidebar.tsx`. `AuthCard` braucht sie ebenfalls, für die `aria-label`
// seiner Schaltflächen. Sie wandert deshalb nach
// `web/src/platform/i18n/language-labels.ts`, und beide importieren von dort
// (Vertrag, Abschnitt 3).
//
// FÄNGT: die Kopie. Der bequemste Weg für den zweiten Verwender ist, die vier
// Zeilen zu duplizieren statt einen Import zu schreiben.
//
// OHNE DIESE PRÜFUNG: zwei Kopien wären zwei Wahrheiten. Eine dritte Sprache
// erschiene in der Seitenleiste mit `aria-label` und in der Fußzeile ohne —
// oder umgekehrt —, und niemand fände den Grund, weil beide Stellen für sich
// vollständig aussehen.
//
// ⚠️ Gezählt werden DEKLARATIONEN (`… LANGUAGE_LABEL_KEYS =`), nicht
// Nennungen. Der Import und jede Benutzung sind erwünscht und dürfen so oft
// vorkommen wie nötig.
test("LANGUAGE_LABEL_KEYS wird genau einmal deklariert", () => {
  const files = collectSourceFiles(SOURCE_ROOT, [".ts", ".tsx"]);
  assert.ok(
    files.length > 0,
    `keine einzige .ts/.tsx-Datei unter ${SOURCE_ROOT}/ gefunden — der Wächter liefe ins Leere`
  );

  const DECLARATION = /(?<![\w$])LANGUAGE_LABEL_KEYS\s*(?::[^=;]*)?=/g;

  const declaringFiles = [];
  for (const path of files) {
    const content = stripComments(readFileSync(new URL(path, `file://${ROOT}`), "utf8"));
    const count = [...content.matchAll(DECLARATION)].length;
    for (let index = 0; index < count; index += 1) declaringFiles.push(path);
  }

  assert.deepEqual(
    declaringFiles,
    [LANGUAGE_LABELS_PATH],
    `LANGUAGE_LABEL_KEYS gehört genau einmal in den Baum, nach ${LANGUAGE_LABELS_PATH} — zwei Kopien wären zwei Wahrheiten (Vertrag, Abschnitt 3). Gefunden:\n${declaringFiles.join("\n") || "(keine Deklaration)"}`
  );
});
