// Bezeichner sind englisch — als Schranke, nicht als Bitte.
//
// AGENTS.md, Abschnitt Sprache: Bezeichner und Branch-Namen sind englisch,
// Codekommentare, Doku und Commit-Texte deutsch. Diese Regel setzt die erste
// Hälfte durch. Die zweite bleibt unangetastet: Kommentare und Zeichenketten
// sieht sie nicht, weil sie auf dem Syntaxbaum arbeitet und nicht auf Text.
//
// Warum überhaupt eine Maschine: im Hauptdashboard sind deutsche Bezeichner
// über Jahre in den Bestand gewachsen und werden dort gerade nachträglich
// herausgezogen — genau die Nacharbeit, deretwegen dieses Repo seine Regeln von
// Tag 1 an führt (concept-and-plan.md §3). Nachträglich ist die Umstellung
// teuer und nie vollständig; jetzt kostet sie eine Meldung beim Tippen.
//
// Die Wortliste steht als Datendatei daneben (german-words.txt), damit sie
// sich ergänzen lässt, ohne Code anzufassen — und damit der Umlaut-Wächter sie
// als Daten ausnehmen kann statt als Prosa zu lesen.

import { readFileSync } from "node:fs";

export const GERMAN_WORDS = new Set(
  readFileSync(new URL("./german-words.txt", import.meta.url), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
);

// Zerlegt einen Bezeichner in seine Wörter: camelCase, PascalCase,
// CONSTANT_CASE und snake_case landen alle als kleingeschriebene Einzelwörter.
export function splitWords(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_$]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

export const rule = {
  meta: {
    type: "problem",
    docs: { description: "Bezeichner sind englisch (AGENTS.md, Abschnitt Sprache)" },
    schema: [],
    messages: {
      german:
        "Bezeichner {{name}} enthält das deutsche Wort {{word}}. Bezeichner sind englisch (AGENTS.md); Kommentare und Texte bleiben deutsch."
    }
  },
  create(context) {
    function check(node) {
      for (const word of splitWords(node.name)) {
        if (!GERMAN_WORDS.has(word)) continue;
        context.report({ node, messageId: "german", data: { name: node.name, word } });
        return;
      }
    }
    return {
      Identifier: check,
      // ⚠️ JSX-Namen sind eigene Knoten und KEINE `Identifier`. Ohne diese
      // Zeile bliebe genau die Hälfte ungeprüft, die man am häufigsten sieht:
      // Komponenten- und Attributnamen im Markup. Aufgefallen ist das, weil
      // eine umbenannte Komponente an ihren Verwendungsstellen stehen blieb
      // und der Regel entging.
      JSXIdentifier: check
    };
  }
};

export default { rules: { "english-identifiers": rule } };
