import assert from "node:assert/strict";
import test from "node:test";

import {
  HIGHLIGHT_BYTE_CAP,
  classOfKind,
  flattenTokens,
  highlightLines
} from "../src/features/compose/yaml-highlight.ts";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Der Einfärber sieht harmlos aus: er macht Text bunt. Er ist es nicht — der
// Editor (E6a) legt ein UNSICHTBARES TEXTFELD über genau diese Ausgabe, und
// beide müssen zeichengenau dasselbe zeigen. Geht dabei ein Zeichen verloren,
// sieht der Betreiber nicht etwa eine falsche Farbe, sondern einen anderen
// Text als den, den er gleich anwendet.
//
// Deshalb steht hier eine EIGENSCHAFT und nicht eine Liste von Beispielen: was
// hineingeht, muss unverändert wieder herauskommen. Sie hält auch für die
// YAML-Formen, an die beim Schreiben niemand denkt.

/** Setzt die Ausgabe wieder zu einem Text zusammen. */
function rejoin(lines) {
  return lines.map((pieces) => pieces.map((piece) => piece.text).join("")).join("\n");
}

const SAMPLES = [
  "",
  "\n",
  "services:\n  sonarr:\n    image: sonarr:1\n",
  // Blockskalare — die Stelle, an der ein selbst geschriebener Zerleger fällt.
  "services:\n  web:\n    command: |\n      echo eins\n      echo zwei\n",
  "services:\n  web:\n    labels: >\n      ein langer\n      umbrochener Text\n",
  // Anker und Verweise.
  "x-common: &common\n  restart: always\nservices:\n  a:\n    <<: *common\n",
  // Interpolation, Kommentare, Anführungszeichen beider Arten.
  'services:\n  a:\n    image: "${REGISTRY:-docker.io}/a:1" # ein Kommentar\n    env: \'roh\'\n',
  // Umlaute und ein ß — zwei Bytes je Zeichen.
  "# Größe der Straße\nservices:\n  müll:\n    image: a:1\n",
  // Leerzeilen mitten im Text und am Ende.
  "services:\n\n  a:\n    image: a:1\n\n\n",
  // Kein YAML, sondern halb getippter Unsinn. Der Editor läuft, WÄHREND jemand
  // tippt — das ist der Normalzustand und kein Sonderfall.
  "services:\n  a:\n    image: \"unfertig\n  b: [ {{{\n"
];

test("kein Zeichen geht verloren, in keiner der elf Formen", () => {
  for (const sample of SAMPLES) {
    assert.equal(rejoin(highlightLines(sample)), sample, `verändert: ${JSON.stringify(sample)}`);
  }
});

test("die Zahl der Zeilen ist die des Textes — auch bei leeren und am Ende", () => {
  for (const sample of SAMPLES) {
    assert.equal(
      highlightLines(sample).length,
      sample.split("\n").length,
      `falsche Zeilenzahl bei ${JSON.stringify(sample)}`
    );
  }
});

test("ein zu großer Text kommt ohne Farbe, aber vollständig zurück", () => {
  // ⚠️ Der Deckel schützt das TIPPEN, nicht die Richtigkeit: Prism zerlegt bei
  // jedem Tastendruck den ganzen Text. Was er kostet, darf er nicht an der
  // Vollständigkeit sparen.
  const line = "  # eine Zeile, die den Deckel füllt\n";
  const huge = line.repeat(Math.ceil(HIGHLIGHT_BYTE_CAP / line.length) + 10);
  assert.ok(new TextEncoder().encode(huge).length > HIGHLIGHT_BYTE_CAP);

  const lines = highlightLines(huge);
  assert.equal(rejoin(lines), huge);
  const kinds = new Set(lines.flat().map((piece) => piece.kind));
  assert.deepEqual([...kinds], [null], "über dem Deckel wird nichts eingefärbt");
});

test("die Arten werden erkannt und nicht bloss durchgereicht", () => {
  const pieces = highlightLines('a: "wert" # dazu\n').flat();
  assert.equal(pieces.map((piece) => piece.text).join(""), 'a: "wert" # dazu');
  assert.ok(
    pieces.some((piece) => piece.kind === "comment"),
    "der Kommentar muss als solcher erkannt sein"
  );
});

test("Compose-Variablen bekommen eine feste Syntaxart auch über Prism-Grenzen hinweg", () => {
  const sample = "image: ${REGISTRY:-docker.io}/app:${TAG} # ${COMMENT}\ncommand: echo $$HOME $USER";
  const lines = highlightLines(sample);
  assert.equal(rejoin(lines), sample);
  assert.equal(
    lines.flat().filter((piece) => piece.kind === "variable").map((piece) => piece.text).join(""),
    "${REGISTRY:-docker.io}${TAG}$USER"
  );
  assert.ok(lines[0].some((piece) => piece.kind === "comment" && piece.text.includes("${COMMENT}")));
  assert.ok(lines[1].some((piece) => piece.kind !== "variable" && piece.text.includes("$$HOME")));
  assert.equal(classOfKind("variable"), "editor-syntax-variable");
  assert.equal(classOfKind("atrule"), "editor-syntax-key");
  assert.equal(classOfKind("string"), "editor-syntax-string");
});

test("ein VERSCHACHTELTER Baum verliert seinen inneren Text nicht", () => {
  // ⚠️ DIESER FALL IST DIE BERICHTIGUNG EINES FEHLERS IN DIESER DATEI. Hier
  // stand ein Fall namens „verschachtelte Token behalten ihren Text", der über
  // echtes YAML lief — und genau das konnte die Rekursion NIE erreichen. Ein
  // unabhängiger Prüfer hat es am 2026-09-07 belegt: er entfernte die Rekursion
  // aus `flattenTokens`, und alle fünf Fälle blieben grün.
  //
  // Nachgemessen an Prism 1.30.0 über 16 YAML-Formen: 85 Token, davon NULL
  // verschachtelte. Die YAML-Grammatik dieser Fassung verschachtelt nicht.
  // Ein Test über echtes YAML kann die Zusage also gar nicht prüfen — er trägt
  // sie nur im Namen, und das ist schlimmer als kein Test: er bestätigt.
  //
  // Deshalb hier ein VON HAND GEBAUTER Baum in der Form, die Prism liefert,
  // wenn eine Grammatik verschachtelt. Wenn die Rekursion fällt, fällt dieser
  // Fall — und zwar unabhängig davon, was die YAML-Grammatik gerade tut.
  const tree = [
    "vor ",
    {
      type: "string",
      content: [
        '"',
        { type: "interpolation", content: ["${", { type: "variable", content: "VAR" }, "}"] },
        '"'
      ]
    },
    " nach"
  ];

  const pieces = [];
  flattenTokens(tree, null, pieces);

  // ⚠️ ZUERST DER TEXT. Was hier fällt, ist nicht die Farbe, sondern der
  // Inhalt: der Editor legt ein Textfeld über diese Ausgabe, und ein fehlendes
  // Zeichen heißt, dass der Betreiber einen anderen Text sieht als den, den
  // er gleich anwendet.
  assert.equal(pieces.map((piece) => piece.text).join(""), 'vor "${VAR}" nach');

  // Und die innerste Art gewinnt über die äussere.
  const variable = pieces.find((piece) => piece.text === "VAR");
  assert.ok(variable, "das innerste Token fehlt ganz");
  assert.equal(variable.kind, "variable");
  assert.equal(pieces.find((piece) => piece.text === "vor ").kind, null);
});

test("eine unbekannte Art bekommt keine Klasse statt einer falschen", () => {
  // ⚠️ Ein Rückfall auf eine der fünf Farben wäre schlimmer als keine Farbe:
  // dann sähe ein Anker aus wie eine Zeichenkette.
  assert.equal(classOfKind("etwas-das-prism-morgen-kennt"), "");
  assert.equal(classOfKind(null), "");
  assert.notEqual(classOfKind("comment"), "");
});
