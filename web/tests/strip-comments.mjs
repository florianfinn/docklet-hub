// Die Kommentar-Entferner der Repo-Wächter — eine Fassung für alle.
//
// Warum es diese Datei gibt: `stripComments` lag am 2026-09-05 SIEBENMAL
// byteidentisch im Baum (je 1.199 Zeichen; gemessen mit `awk` auf den Rumpf
// und `md5sum`, Prüfsumme 4500f5b93856baa6efe3cee42580eb0c) und
// `stripCssComments` zweimal (Prüfsumme 0f71eafb2d0d09c19e756601b5a37f97).
// Zwei Abschriften derselben Rechnung sind zwei Wahrheiten: wer die eine
// berichtigt, berichtigt die andere nicht, und der Unterschied fällt nicht
// auf, weil jede Kopie für sich grün bleibt. Genau das war hier schon
// passiert — die Zeilentreue in `stripCssComments` wurde in `dot-wave` und
// `dot-wave-boundary` nachgezogen, in der Namensschwester unter
// `design-tokens` nicht.
//
// ⚠️ DER DATEINAME TRÄGT KEIN `.test.` — der Lauf ist
// `node --test "tests/**/*.test.mjs"`, und eine Hilfsdatei, die dieses Muster
// träfe, würde als Testdatei eingesammelt und meldete „keine Tests".
//
// ⚠️ Hier stand eine Liste der Verwender mit ihrer Anzahl. Sie ist entfallen,
// weil sie veraltete, ohne dass es auffiel: am 2026-09-06 nannte sie 7 und 3,
// tatsächlich waren es 9 und 4 — die Pakete D5, D6 und D6b kamen dazu und
// niemand zählte nach. Eine Buchführung, die nur von Hand stimmt, ist beim
// zweiten Leser schon falsch. An ihrer Stelle steht ein Wächter:
// `strip-comments.test.mjs` hält, dass es KEINE zweite Definition gibt und
// jeder Verwender aus dieser Datei importiert — die Eigenschaft, auf die es
// ankommt, statt der Liste derer, die sie gerade erfüllen.

// Ersetzt jeden Kommentar durch Leerzeichen und behält dabei die
// Zeilenumbrüche — so bleibt der Rest der Datei an seiner Stelle und jede
// Zeilennummer in einer Fundmeldung gilt weiter.
//
// ⚠️ Zeichenweise und NICHT per regulärem Ausdruck: ein `//` steht in diesem
// Repo massenhaft INNERHALB von Zeichenketten — jeder Herkunftskopf unter
// `web/src/platform/ui/shadcn/` trägt eine `https://`-Quelle. Ein Muster wie
// `/\/\/.*$/gm` verschluckte den Rest der Zeile und mit ihm jede echte
// Fundstelle dahinter; der Wächter würde LEISER, statt genauer zu werden.
//
// Zeichenketten bleiben ERHALTEN. Ein Wächter, der eine Farbe als
// `"oklch(…)"` im Code sucht, findet sie hier noch.
//
// Bekannte Grenze: ein vollständiger Parser ist das nicht. Ein
// Anführungszeichen in einem regulären Ausdruck (`/["']/`) oder ein `//`
// innerhalb eines `${…}` in einem Template-Literal kann es verwirren. Steht
// das eines Tages im Code, ist die Meldung falsch — nicht die Prüfung
// überflüssig.
export function stripComments(source) {
  let output = "";
  let index = 0;
  let quote = null;
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (quote !== null) {
      if (character === "\\") {
        output += source.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (character === quote) quote = null;
      output += character;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      output += character;
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
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

// CSS kennt `//` NICHT als Kommentar. Für `.css` deshalb nur der
// Blockkommentar — und ein eigener Entferner statt `stripComments`, weil
// dessen Zeichenketten-Zustand in CSS nichts zu suchen hat (ein `'` in einer
// Prosazeile eines Kommentars gibt es dort ständig).
//
// ⚠️ Der Kommentar wird durch EBENSO VIELE Zeilenumbrüche ersetzt und nicht
// gelöscht — sonst rutscht alles dahinter nach oben und `lineOf` nennt eine
// Zeile, die es so nicht gibt (gemessen am 2026-09-05: Zeile 200 von
// `web/src/platform/theme/tokens.css` wurde als 132 gemeldet). Eine Fundstelle, die
// auf die falsche Zeile zeigt, kostet genau die Zeit, die der Wächter sparen
// soll.
export function stripCssComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    "\n".repeat((comment.match(/\n/g) ?? []).length)
  );
}
