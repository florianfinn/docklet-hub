import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findMojibake, findTransliterations, loadEszettWords, loadWords } from "../../scripts/check-umlauts.mjs";
import { scratchGit, scratchGitEnvironment } from "./scratch-git.mjs";

// Wächter über die Umlaut-Regel aus AGENTS.md, Abschnitt Sprache.
//
// Warum eine Maschine das misst: die Regel ist trivial zu befolgen und ebenso
// trivial zu verletzen — eine Umgebung ohne deutsches Tastaturlayout, ein
// hastig getippter Kommentar, ein Text, der durch ein Werkzeug gelaufen ist.
// Beim Schreiben fällt es niemandem auf, beim Lesen jedem. Genau diese Klasse
// gehört nicht in eine Datei mit Regeln, sondern in einen Test, der fällt.
//
// Die Prüfung selbst steht in scripts/check-umlauts.mjs, damit der
// commit-msg-Haken dieselbe benutzt: der Commit-Text liegt in keiner Datei,
// die dieser Test sehen könnte.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Textdateien, die dieses Repo selbst schreibt. Alles unter dist/ und der
// Lockfile sind erzeugt und gehören niemandem hier.
//
// `*.json` covers the tsconfig files of every workspace: they are JSONC and
// carry German and English comments. Measured on 2026-10-01 (#285): a
// mojibake dash sat in `server/tsconfig.build.json` from `4a0a61f` (#244)
// on, because this list had no JSON pattern. All JSON, not just
// `tsconfig*.json`: at that date the repo tracked 13 JSON files, that dash
// was the only finding among them, and a tsconfig-only pattern would leave
// the next JSONC file with a comment unseen. The dependency-cruiser baseline
// is generated, but it only carries paths and rule names from tracked sources
// and is checked along with them; `pnpm-lock.yaml` stays in `EXEMPT`.
// CSS, HTML, JavaScript and hooks carry our text too (#286). The staged
// fixtures below check selection and both recognisers for every added kind.
const PATTERNS = ["*.md", "*.ts", "*.tsx", "*.mjs", "*.js", "*.json", "*.css", "*.html", "*.sh", "*.sql", "*.yml", "*.yaml", "Dockerfile", ".githooks/*", "*.txt"];

// The files this guard reads in a working copy: tracked, matching
// `PATTERNS`, not in `EXEMPT`. A function so the broken sample below runs
// through the same selection as the real tree.
function guardedFiles(root) {
  // Without the `GIT_*` variables of a hook, so `root` decides which index is
  // read, also for the sample repository below (#286).
  return execFileSync("git", ["ls-files", ...PATTERNS], { cwd: root, encoding: "utf8", env: scratchGitEnvironment() })
    .split("\n")
    .filter(Boolean)
    .filter((path) => !EXEMPT.has(path));
}

// Dateien, die Umschreibungen als DATEN tragen statt als Text — jede mit ihrem
// Grund. Diese Liste ist kurz zu halten: sie ist die Tür, durch die die Regel
// verschwindet.
const EXEMPT = new Map([
  // Die Wortliste dieses Wächters. Sie nennt die Umschreibungen, um sie zu
  // finden, und würde sich sonst selbst melden.
  ["web/tests/umlaut-words.txt", "die Liste dieses Wächters"],
  // Der Status-Wächter führt seine Wendungen ABSICHTLICH doppelt: einmal mit
  // Umlaut, einmal umgeschrieben. Ein Dokument, das die umgeschriebene Form
  // verwendet, soll dort trotzdem als Statusaussage auffallen — die beiden
  // Regeln greifen an derselben Zeile und dürfen einander nicht aufheben.
  ["web/tests/documents-without-status.test.mjs", "führt Statuswendungen in beiden Schreibweisen"],
  // Die Wortliste des Bezeichner-Wächters. Sie führt deutsche Wörter als
  // Suchbegriffe, damit sie als Bezeichner auffallen — dieselbe Lage wie oben.
  ["eslint-rules/german-words.txt", "die Liste des Bezeichner-Wächters"],
  // Erzeugt, gehört niemandem hier.
  ["pnpm-lock.yaml", "erzeugte Datei"]
]);

// SINGLE words a file may carry in quotes or backticks — not as German text.
//
// ⚠️ Why this stands next to `EXEMPT` and not in it: an exemption for the
// whole file would also spare its comments the check. Exempting a word is an
// exception; exempting a 400-line file would be the door the paragraph on
// `EXEMPT` warns about. This list is therefore the narrower door and not the
// second one.
//
// ⚠️ The only reason for an entry: THE WORD IS NOT OURS TO SPELL. Since #278
// every value hub and agent exchange is English, so the agent is no longer
// such a counterpart (`web/tests/agent-contract-language.test.mjs` holds its
// schemas). What remains is a word an older party fixed: a file name an agent
// of the previous version reads during its own swap, a value the changelog
// records as it was sent back then, and the files that explain this rule. A
// word WE write never belongs here.
//
// ⚠️ IT ONLY APPLIES IN QUOTES OR BACKTICKS, and that is measured: before, it
// applied per file and word, so also in free prose. A real German line ran
// through the hub's former contract file (removed in #274) — the file with
// the most German comments of the package. A fixed word stands in the source
// as a literal or in prose as a code span; it never stands bare in a sentence.
const EXEMPT_WORDS = new Map([
  // ⚠️ This file EXPLAINS the rule and has to name the transliterations for
  // it. They stand there only in backticks, as examples.
  ["scripts/check-umlauts.mjs", ["aenderung", "gross"]],
  // The self-update state directory on the host's `/state` volume: the job
  // and its status go through files that the agent of the PREVIOUS version
  // writes and the new one reads after the swap. Their names stay as they
  // are (#278); a rename would lose the outcome of exactly the update that
  // brings it. The README names the files for the operator.
  ["agent/src/self-update-state.ts", ["laeuft", "verfuegbar"]],
  // This file names every exception to justify it.
  [
    "web/tests/german-umlauts.test.mjs",
    ["aenderung", "ausserhalb", "groesse", "gross", "gueltig", "laeuft", "loeschen", "oeffentlich", "pruefen", "pruefung", "schliessen", "schluessel", "ungueltig", "verfuegbar"]
  ]
]);

// The words a file may carry in quotes: its `EXEMPT_WORDS`.
function allowedWordsOf(path) {
  return EXEMPT_WORDS.get(path) ?? [];
}

// Die Spannen einer Zeile, die zwischen Anführungszeichen oder Backticks
// stehen.
//
// ⚠️ Nur die drei Zeichen des Quelltextes — die deutschen Anführungszeichen
// dieses Repos umschließen PROSA und dürfen die Ausnahme nicht öffnen. Ein
// unabgeschlossenes Anführungszeichen am Zeilenende ergibt keine Spanne: im
// Zweifel greift die Ausnahme nicht.
function quotedSpans(line) {
  const spans = [];
  let quote = null;
  let start = 0;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === null) {
      if (character === '"' || character === "'" || character === "`") {
        quote = character;
        start = index;
      }
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === quote) {
      spans.push([start, index]);
      quote = null;
    }
  }
  return spans;
}

// Ob die Ausnahme diese Fundstelle deckt: ob also JEDES Vorkommen des Wortes in
// dieser Zeile in einer solchen Spanne steht.
//
// ⚠️ Je Zeile und nicht je Spalte, weil `findTransliterations` Zeile und Wort
// meldet und keine Spalte. Das Erkennen bleibt dort — zwei Umsetzungen wären
// zwei Auslegungen davon, was als Wort zählt. Hier wird nur die Lage bestimmt.
// Steht in einer Zeile ein Vorkommen außerhalb der Anführungszeichen, deckt
// die Ausnahme die ganze Zeile nicht mehr und der Wächter meldet auch das
// zitierte Vorkommen mit: lieber einmal zu laut als einmal zu leise.
function isExemptOccurrence(line, word) {
  const spans = quotedSpans(line);
  const places = [...line.matchAll(new RegExp(`\\b${word}\\b`, "giu"))];
  if (places.length === 0) return false;
  return places.every((place) => spans.some(([open, close]) => place.index > open && place.index < close));
}

test("die Wortliste ist gefüllt und frei von Doppelungen", () => {
  // Ohne diesen Fall liefe der Wächter bei einer leeren oder kaputten Liste
  // ins Leere und meldete Erfolg — die stillste Art, eine Regel zu verlieren.
  const list = loadWords();
  assert.ok(list.length > 20, `Die Wortliste zählt nur ${list.length} Einträge — das sieht nach einem Unfall aus`);
  const duplicates = list.filter((word, index) => list.indexOf(word) !== index);
  assert.deepEqual(duplicates, [], `Doppelt in umlaut-words.txt:\n${duplicates.join("\n")}`);
});

test("der Erkenner selbst: ganze Wörter, unabhängig von der Großschreibung", () => {
  // Ein Wächter ohne eigenen Test ist eine Behauptung.
  //
  // ⚠️ Geprüft wird mit Kunstwörtern, nicht mit echten Umschreibungen. Sonst
  // meldete der Wächter diese Datei selbst — und die Antwort darauf wäre eine
  // Ausnahme für sie gewesen, die sie dauerhaft ungeprüft ließe. Der Erkenner
  // kennt die Liste nicht; für ihn ist jedes Wort gleich.
  const words = ["xaebc", "xoedf"];
  assert.deepEqual(findTransliterations("etwas xaebc alles", words), [{ line: 1, word: "xaebc" }]);
  // Großschreibung ändert nichts — ein Wort am Satzanfang ist dasselbe Wort.
  assert.deepEqual(findTransliterations("Xaebc alles", words), [{ line: 1, word: "Xaebc" }]);
  // Der wichtigste Fall: die Wortgrenzen. Ohne sie schlüge ein kurzer Eintrag
  // mitten in englischen Bezeichnern an, die hier vorgeschrieben sind.
  assert.deepEqual(findTransliterations("const myxaebcValue = 1;", words), []);
  // Die Zeilennummer soll auf die Zeile zeigen, nicht auf den Dateianfang.
  assert.deepEqual(findTransliterations("a\nb\nxoedf", words), [{ line: 3, word: "xoedf" }]);
});

test("der Erkenner selbst: ein ss-Wort in Großbuchstaben ist richtig geschrieben", () => {
  // #99, Punkt 3: dass der Vergleich ohne Rücksicht auf Groß- und
  // Kleinschreibung läuft, behauptet der Wächter über sich selbst — hier steht
  // es belegt, und zwar an der Stelle, an der die Behauptung NICHT gilt.
  //
  // ⚠️ In Großbuchstaben wird das ß als SS geschrieben. Dieses Repo setzt seine
  // Warnzeilen in Großbuchstaben („⚠️ … HEISST …"), und ohne diese Ausnahme
  // meldete der Wächter beim ersten Lauf nach #99 fünfzehn RICHTIG
  // geschriebene Stellen. Ein Wächter mit dieser Fehlalarmquote wird
  // abgeschaltet, nicht befolgt.
  //
  // ⚠️ Wieder Kunstwörter: `xeissen` steht stellvertretend für ein ss-Wort,
  // `xaebc` für eine Umlaut-Umschreibung. Mit echten Wörtern meldete diese
  // Datei sich selbst.
  const words = ["xeissen", "xaebc"];
  const eszett = new Set(["xeissen"]);

  // Klein und am Satzanfang: Befund, wie jedes andere Wort auch.
  assert.deepEqual(findTransliterations("etwas xeissen alles", words, eszett), [{ line: 1, word: "xeissen" }]);
  assert.deepEqual(findTransliterations("Xeissen alles", words, eszett), [{ line: 1, word: "Xeissen" }]);
  // Ganz groß: kein Befund — das ist die Ausnahme.
  assert.deepEqual(findTransliterations("DAS XEISSEN HIER", words, eszett), []);
  // ⚠️ Und die Ausnahme gilt NUR für ss-Wörter. Eine Umlaut-Umschreibung in
  // Großbuchstaben bleibt ein Befund: für sie gibt es keine Schreibweise, in
  // der `ae` statt `ä` richtig wäre.
  assert.deepEqual(findTransliterations("DAS XAEBC HIER", words, eszett), [{ line: 1, word: "XAEBC" }]);
});

test("die Marke der ss-Wörter steht in der Liste und trennt sie richtig", () => {
  // FÄNGT: dass jemand die Marke `# ss statt ß` umbenennt oder verschiebt.
  // Ohne sie gälte keine Ausnahme, und mit einer verschobenen Marke gälte sie
  // für die Umlaut-Umschreibungen mit — dann liefe `AENDERUNG` durch.
  const eszett = loadEszettWords();
  const all = new Set(loadWords());

  // ⚠️ AM 2026-09-09 VON 20 AUF 38 NACHGEZOGEN (#145). Die Marke stand 18
  // unter dem Bestand: eine Untergrenze, die erst fällt, wenn fast die Hälfte
  // der Liste verschwunden ist, hält keine verschobene Marke mehr auf. Genau
  // das ist ihre Aufgabe — rutscht `# ss statt ß` um wenige Zeilen nach unten,
  // verlieren die ersten ss-Wörter still ihre Ausnahme, und `HEISST` in einer
  // Warnzeile wird wieder gemeldet.
  //
  // Warum 38: so viele Zeilen stehen heute hinter der Marke in
  // `web/tests/umlaut-words.txt` (ab Zeile 91, ohne Kommentar- und
  // Leerzeilen). Messweg: `sed -i 's/eszett.size >= 38/eszett.size >= 999/'`,
  // dann `cd web && npx tsx --test tests/german-umlauts.test.mjs` meldet
  // „nur 38 ss-Wörter"; zurückgestellt mit `git checkout -- <datei>`.
  //
  // Wer ein ss-Wort einträgt, zieht diese Zahl mit hoch. Wer eines entfernt,
  // setzt sie herunter UND schreibt den Grund daneben — eine Zahl, die ohne
  // Begründung sinkt, ist derselbe lautlose Verfall, der sie hierher gebracht
  // hat.
  assert.ok(eszett.size >= 38, `nur ${eszett.size} ss-Wörter — die Marke sitzt zu weit unten`);
  for (const word of eszett) {
    assert.ok(all.has(word), `„${word}" steht hinter der Marke, aber nicht in der Wortliste`);
  }
  // Die Umlaut-Umschreibungen dürfen NICHT darunterfallen.
  assert.equal(eszett.has("aenderung"), false, "Die Marke steht zu weit oben — `aenderung` gilt als ss-Wort");
  assert.equal(eszett.has("ausserhalb"), true, "Das erste ss-Wort steht nicht hinter der Marke");
});

test("der Mojibake-Erkenner: doppelt kodierte Umlaute, nicht die echten", () => {
  // Die Proben entstehen aus Escape-Folgen, nicht als Zeichen im Quelltext —
  // sonst meldete der Dateiwächter unten diese Datei selbst.
  const uumlaut = "\u00C3\u00BC"; // „ü", als Windows-1252 gelesen und neu kodiert
  const dash = "\u00E2\u20AC\u201D"; // „—", dieselbe Reise
  assert.deepEqual(
    findMojibake(`Betreff R${uumlaut}ckbau`).map((f) => f.line),
    [1]
  );
  assert.deepEqual(findMojibake(`a\nb ${dash} c`).map((f) => f.line), [2]);
  // Echte Umlaute und der echte Gedankenstrich sind kein Befund — sonst wäre
  // der Wächter ein Verbot der Regel, die er hüten soll.
  assert.deepEqual(findMojibake("Rückbau — Prüfkette, §4, Wörter mit ß"), []);
  // Die Probe im Befund nennt die Stelle, damit die Meldung ohne Nachschlagen lesbar ist.
  assert.ok(findMojibake(`x R${uumlaut}ckbau y`)[0].sample.includes("R"));
});

test("die Wort-Ausnahme greift nur in Anführungszeichen oder Backticks", () => {
  // Auch dieser Erkenner bekommt seinen eigenen Fall, und aus demselben Grund
  // wie oben mit Kunstwörtern: eine echte Umschreibung meldete diese Datei
  // selbst.
  //
  // Der Wert der Gegenseite, als Literal und als Code-Ausschnitt in der Prosa:
  assert.equal(isExemptOccurrence('const tier = "xaebc";', "xaebc"), true);
  assert.equal(isExemptOccurrence("// eine Route mit `xaebc` verlangt mehr", "xaebc"), true);
  // Die Zeile, gegen die dieser Erkenner gebaut ist: echte deutsche Prosa.
  assert.equal(isExemptOccurrence("// Dieses Repo ist nicht xaebc, und das hier ist ein Satz.", "xaebc"), false);
  // Ein zitiertes UND ein nacktes Vorkommen in derselben Zeile: die Ausnahme
  // deckt die Zeile dann gar nicht.
  assert.equal(isExemptOccurrence('const tier = "xaebc"; // xaebc als Wort', "xaebc"), false);
  // Die deutschen Anführungszeichen der Prosa öffnen keine Spanne.
  assert.equal(isExemptOccurrence("// der Wert „xaebc“ in Worten", "xaebc"), false);
});

test("keine Wort-Ausnahme steht da, ohne noch gebraucht zu werden", () => {
  // Eine Ausnahme, deren Grund weggefallen ist, ist eine offene Tür ohne
  // Anlass. Sie fiele sonst niemandem auf: der Wächter bliebe grün, und die
  // nächste echte Umschreibung in derselben Datei liefe still hindurch.
  //
  // ⚠️ Gezählt werden nur die Fundstellen, die die Ausnahme überhaupt DECKT —
  // die in Anführungszeichen oder Backticks. Sonst hielte eine Prosazeile, die
  // der Wächter längst meldet, die Ausnahme am Leben, die sie gar nicht deckt,
  // und dieser Fall würde grün, weil er die Fundstellen anders zählt als der
  // Fall darunter.
  const words = loadWords();
  const stale = [];
  for (const [path, allowed] of EXEMPT_WORDS) {
    const content = readFileSync(new URL(path, `file://${ROOT}`), "utf8");
    const lines = content.split("\n");
    const found = new Set(
      findTransliterations(content, words)
        .filter((match) => isExemptOccurrence(lines[match.line - 1], match.word))
        .map((match) => match.word.toLowerCase())
    );
    for (const word of allowed) {
      if (!found.has(word)) stale.push(`${path}: „${word}“ kommt dort nicht mehr vor`);
    }
  }
  assert.deepEqual(stale, [], `Ausnahmen ohne Anlass:\n${stale.join("\n")}`);
});

// Every finding of this guard in the given files, as `path:line — …`.
function findingsIn(root, files, words) {
  const findings = [];
  for (const path of files) {
    const content = readFileSync(join(root, path), "utf8");
    const lines = content.split("\n");
    const allowed = allowedWordsOf(path);
    for (const match of findTransliterations(content, words)) {
      // Die Ausnahme gilt für das Wort UND für die Fundstelle: als Literal oder
      // als Code-Ausschnitt. In freier Prosa gilt sie nicht.
      if (allowed.includes(match.word.toLowerCase()) && isExemptOccurrence(lines[match.line - 1], match.word)) continue;
      findings.push(`${path}:${match.line} — ${match.word}`);
    }
    for (const match of findMojibake(content)) {
      findings.push(`${path}:${match.line} — doppelt kodiert: …${match.sample}…`);
    }
  }
  return findings;
}

test("jede tsconfig-Datei jedes Workspaces steht unter dem Wächter", () => {
  // The selection is what failed in #285, not the recognisers: the dash was
  // there, and the guard never opened the file. Asked of the real tree, so a
  // new workspace with its own tsconfig is covered or this case fails.
  const tsconfigs = execFileSync("git", ["ls-files", "*tsconfig*.json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: scratchGitEnvironment()
  })
    .split("\n")
    .filter(Boolean);
  // Six on 2026-10-01: `contract/`, `server/` (each with a build variant),
  // `web/` and `web/tests/`. Measured with `git ls-files '*tsconfig*.json'`.
  assert.ok(tsconfigs.length >= 6, `git ls-files lieferte nur ${tsconfigs.length} tsconfig-Dateien — das Muster trifft nicht mehr`);
  const guarded = new Set(guardedFiles(ROOT));
  const missed = tsconfigs.filter((path) => !guarded.has(path));
  assert.deepEqual(missed, [], `Diese tsconfig-Dateien sieht der Wächter nicht:\n${missed.join("\n")}`);
});

test("der Wächter fällt an kaputten tsconfigs, CSS, HTML, JavaScript und Git-Hooks", () => {
  // The whole path of the guard on a throwaway repository: `git ls-files`
  // with `PATTERNS`, then both recognisers. The samples are built from escape
  // sequences and an artificial word, as in the recogniser cases above;
  // literal mojibake here would make this file report itself.
  const dash = "\u00E2\u20AC\u201D"; // "—" read as Windows-1252 and re-encoded
  const dir = mkdtempSync(join(tmpdir(), "german-umlauts-"));
  try {
    const files = {
      // The case from #285: a JSONC comment in a build tsconfig.
      "server/tsconfig.build.json": `{\n  // resolves to \`dist/*.d.ts\` ${dash} the built files\n  "extends": "./tsconfig.json"\n}\n`,
      // A transliteration in a tsconfig of another workspace.
      "web/tsconfig.json": '{\n  // eine xaebc Zeile\n  "compilerOptions": {}\n}\n',
      // Each previously unseen kind exercises both recognisers, through Git.
      "web/src/theme.css": `/* xaebc ${dash} */\n`,
      "web/index.html": `<!-- xaebc ${dash} -->\n`,
      "scripts/example.js": `// xaebc ${dash}\n`,
      ".githooks/pre-push": `#!/bin/sh\n# xaebc ${dash}\n`,
      // Real umlauts and a real dash in JSON are no finding.
      "package.json": '{\n  "description": "Prüfkette — größer"\n}\n'
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    // Staged, not committed: `git ls-files` sees the index, and an unstaged
    // file is invisible to it (AGENTS.md, trap 1).
    // Without the `GIT_*` variables of a hook: under `pre-push` this `init`
    // hit the real repository (#286, `scratch-git.mjs`).
    scratchGit(dir, ["init", "-q"]);
    scratchGit(dir, ["add", "-A"]);

    // The sample text of a mojibake finding is cut off, not compared.
    const findings = findingsIn(dir, guardedFiles(dir), ["xaebc"]).map((finding) => finding.replace(/….*…$/u, "…"));
    assert.deepEqual(findings, [
      ".githooks/pre-push:2 — xaebc",
      ".githooks/pre-push:2 — doppelt kodiert: …",
      "scripts/example.js:1 — xaebc",
      "scripts/example.js:1 — doppelt kodiert: …",
      "server/tsconfig.build.json:2 — doppelt kodiert: …",
      "web/index.html:1 — xaebc",
      "web/index.html:1 — doppelt kodiert: …",
      "web/src/theme.css:1 — xaebc",
      "web/src/theme.css:1 — doppelt kodiert: …",
      "web/tsconfig.json:2 — xaebc"
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kein deutsches Wort steht in ASCII-Umschreibung, kein Umlaut ist doppelt kodiert", () => {
  const files = guardedFiles(ROOT);
  assert.ok(files.length > 0, "git ls-files lieferte nichts — der Wächter liefe ins Leere");

  const findings = findingsIn(ROOT, files, loadWords());
  assert.deepEqual(
    findings,
    [],
    `Umlaute und ß werden richtig gesetzt (AGENTS.md):\n${findings.join("\n")}`
  );
});
