import Prism from "prismjs/components/prism-core.js";
import "prismjs/components/prism-yaml.js";

// Die Einfärbung eines YAML-Textes — als reine Rechnung, ohne DOM.
//
// ⚠️ PRISM WIRD HIER NUR ALS ZERLEGER BENUTZT, nicht als Auszeichner.
// `Prism.highlight()` gäbe HTML zurück, das jemand mit
// `dangerouslySetInnerHTML` einhängen müsste — und der Text, um den es geht,
// ist eine Compose-Datei vom Host des Betreibers. Ein Editor, der fremden Text
// als HTML in die eigene Seite hängt, ist genau die Bauweise, gegen die die
// Kopfzeilen dieses Hubs stehen. `Prism.tokenize()` liefert stattdessen einen
// BAUM aus Werten; was daraus wird, entscheidet React, und ein `<` bleibt ein
// `<`.
//
// ⚠️ ES GIBT KEINE ZWEITE FASSUNG DIESER RECHNUNG. Der Editor (E6a) legt ein
// unsichtbares Textfeld über genau diese Ausgabe, und beide müssen dieselben
// Zeilen an denselben Stellen umbrechen. Deshalb ist das hier eine Funktion
// über Zeichenketten und kein Bauteil: was das Textfeld überdeckt, wird einmal
// gerechnet.

/** Ein Stück einer Zeile: Text und, wo Prism eine kennt, seine Art. */
export type CodePiece = { text: string; kind: string | null };

/**
 * Ab wann nicht mehr eingefärbt wird.
 *
 * ⚠️ DAS IST KEINE GRENZE DES AGENTEN und darf mit `MAX_COMPOSE_BYTES` nicht
 * verwechselt werden — jene entscheidet, was hinausgehen darf, diese nur, ob
 * es bunt ist. Der Grund ist gemessen an der Sache selbst: Prism zerlegt bei
 * JEDEM Tastendruck den GANZEN Text, und das ist eine Rechnung über die volle
 * Länge im Hauptstrang des Browsers. Bei einer Datei nahe der Grenze der
 * Gegenseite (256 KB) tippt es sich dann zäh — und ein Editor, der beim
 * Tippen hakt, ist schlechter als einer ohne Farben.
 *
 * 64 KB ist grosszügig gewählt: die Compose-Dateien, um die es hier geht,
 * liegen bei wenigen Kilobyte. Wer darüber liegt, bekommt denselben Text ohne
 * Farbe — und die Zeilennummern bleiben.
 */
export const HIGHLIGHT_BYTE_CAP = 64 * 1024;

/**
 * Zerlegt einen Prism-Baum in flache Stücke.
 *
 * ⚠️ REKURSIV, weil ein Prism-Baum verschachteln KANN: der Inhalt eines Tokens
 * ist entweder eine Zeichenkette oder wieder eine Liste aus Zeichenketten und
 * Tokens. Eine flache Schleife nähme davon nur die oberste Ebene und verlöre
 * den Text darunter — nicht die Farbe, den TEXT. Der Editor legte dann ein
 * Textfeld über eine Anzeige, in der Zeichen fehlen.
 *
 * ⚠️ EXPORTIERT, UND ZWAR AUS EINEM GEMESSENEN GRUND. Ein unabhängiger Prüfer
 * hat am 2026-09-07 belegt, dass die Rekursion durch KEINEN Testfall gedeckt
 * war: er entfernte sie, und alle fünf Fälle blieben grün — auch der, der laut
 * seinem Namen genau sie sichern sollte. Nachgemessen an Prism 1.30.0 mit 16
 * YAML-Formen: 85 Token, davon **null** verschachtelte. Die YAML-Grammatik
 * dieser Fassung verschachtelt schlicht nicht, und ein Test über echtes YAML
 * kann die Rekursion deshalb gar nicht erreichen.
 *
 * Sie bleibt trotzdem stehen — was hier fällt, ist Text und nicht Farbe, und
 * eine Grammatik, die morgen verschachtelt, soll das nicht lautlos tun. Damit
 * die Zusage nicht wieder ungeprüft dasteht, ist sie von außen aufrufbar und
 * wird in `web/tests/yaml-highlight.test.mjs` gegen einen VON HAND GEBAUTEN
 * verschachtelten Baum gehalten. Ein Test, der eine Eigenschaft im Namen führt
 * und sie nicht erreicht, ist schlimmer als keiner: er bestätigt.
 */
export function flattenTokens(nodes: unknown, inherited: string | null, into: CodePiece[]): void {
  if (typeof nodes === "string") {
    if (nodes !== "") into.push({ text: nodes, kind: inherited });
    return;
  }
  if (Array.isArray(nodes)) {
    for (const node of nodes) flattenTokens(node, inherited, into);
    return;
  }
  if (typeof nodes !== "object" || nodes === null) return;
  const token = nodes as { type?: unknown; alias?: unknown; content?: unknown };
  // `alias` hat Vorrang: Prism setzt ihn dort, wo die Art zu grob wäre — ein
  // YAML-Schlüssel kommt als `type: "key", alias: "atrule"`.
  const kind =
    typeof token.alias === "string"
      ? token.alias
      : typeof token.type === "string"
        ? token.type
        : inherited;
  flattenTokens(token.content, kind, into);
}

/**
 * Die Zeilen eines YAML-Textes, je Zeile die Stücke.
 *
 * ⚠️ SIE GIBT IMMER SO VIELE ZEILEN ZURÜCK, WIE DER TEXT HAT — auch leere, und
 * auch die letzte hinter einem abschliessenden Zeilenumbruch. Die
 * Zeilennummern hängen daran, und eine Anzeige, die leere Zeilen wegliesse,
 * zeigte hinter jeder Lücke eine falsche Nummer.
 *
 * ⚠️ SIE WIRFT NIE. Ein Zerleger, der an einem halb getippten Anker
 * stolperte, nähme dem Betreiber die Fläche mitten im Bearbeiten weg. Was
 * nicht zerlegbar ist, wird zu einer Zeile ohne Art — also schwarz statt bunt.
 */
export function highlightLines(text: string): CodePiece[][] {
  const plain = (): CodePiece[][] =>
    text.split("\n").map((line) => (line === "" ? [] : [{ text: line, kind: null }]));

  if (new TextEncoder().encode(text).length > HIGHLIGHT_BYTE_CAP) return plain();

  let pieces: CodePiece[];
  try {
    pieces = [];
    flattenTokens(Prism.tokenize(text, Prism.languages.yaml), null, pieces);
  } catch {
    return plain();
  }

  const lines: CodePiece[][] = [[]];
  for (const piece of pieces) {
    const parts = piece.text.split("\n");
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) lines.push([]);
      if (parts[index] !== "") lines[lines.length - 1].push({ text: parts[index], kind: piece.kind });
    }
  }
  return lines.map(markVariables);
}

/**
 * Hebt Compose-Variablen auch dann hervor, wenn Prism ihre Zeichen auf mehrere
 * YAML-Token verteilt. Kommentare und mit `$$` maskierte Dollarzeichen bleiben
 * unangetastet; alle Stücke behalten ihren ursprünglichen Text und ihre Länge.
 */
function markVariables(pieces: CodePiece[]): CodePiece[] {
  const line = pieces.map((piece) => piece.text).join("");
  const pattern = /\$\$|\$\{[A-Za-z_][A-Za-z0-9_]*[^}\n]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g;
  const ranges: { start: number; end: number }[] = [];
  let tokenIndex = 0;
  let tokenStart = 0;

  for (const match of line.matchAll(pattern)) {
    if (match[0] === "$$") continue;
    const start = match.index;
    while (tokenIndex < pieces.length && tokenStart + pieces[tokenIndex].text.length <= start) {
      tokenStart += pieces[tokenIndex].text.length;
      tokenIndex += 1;
    }
    if (pieces[tokenIndex]?.kind !== "comment") ranges.push({ start, end: start + match[0].length });
  }

  if (ranges.length === 0) return pieces;

  const marked: CodePiece[] = [];
  let position = 0;
  let rangeIndex = 0;
  for (const piece of pieces) {
    let used = 0;
    while (used < piece.text.length) {
      while (rangeIndex < ranges.length && ranges[rangeIndex].end <= position) rangeIndex += 1;
      const range = ranges[rangeIndex];
      const variable = range !== undefined && range.start <= position;
      const boundary = range === undefined ? Infinity : variable ? range.end : range.start;
      const length = Math.min(piece.text.length - used, boundary - position);
      marked.push({ text: piece.text.slice(used, used + length), kind: variable ? "variable" : piece.kind });
      used += length;
      position += length;
    }
  }
  return marked;
}

/**
 * Die Klasse zu einer Art.
 *
 * Die Syntaxfarben stehen in compose-syntax.css. Ihr Farbton folgt der Art des
 * YAML-Stücks und nicht der Host-Palette; nur die Helligkeit folgt dem hellen
 * oder dunklen Hintergrund, damit dieselbe Bedeutung lesbar bleibt.
 *
 * ⚠️ EINE UNBEKANNTE ART BEKOMMT KEINE KLASSE und bleibt damit ungefärbt. Prism
 * kennt für YAML mehr Arten, als hier stehen; sie fallen nicht weg, sie sind
 * nur nicht gefärbt. Ein Rückfall auf eine der fünf Farben wäre schlimmer —
 * dann sähe ein Anker aus wie eine Zeichenkette.
 */
export function classOfKind(kind: string | null): string {
  switch (kind) {
    case "comment":
      return "text-muted-foreground";
    case "atrule":
    case "key":
      return "compose-syntax-key";
    case "string":
      return "compose-syntax-string";
    case "number":
    case "boolean":
    case "null":
    case "datetime":
      return "compose-syntax-literal";
    case "tag":
    case "important":
    case "directive":
      return "compose-syntax-special";
    case "anchor":
      return "compose-syntax-anchor";
    case "variable":
      return "compose-syntax-variable";
    case "punctuation":
      return "text-subtle-foreground";
    default:
      return "";
  }
}
