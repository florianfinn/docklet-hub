// Der zweite Leser des API-Wächters: Aufrufe, die den Hub UNMITTELBAR
// ansprechen — `fetch(…)` und `xhr.open(<Methode>, <Pfad>)`.
//
// Warum eine eigene Datei (#136): `api-mirror.test.mjs` stand mit diesem Leser
// bei 1.039 Zeilen und riss damit die Marke aus `source-file-size.test.mjs`
// (LIMIT 1000). Aufgeteilt ist die Datei und nicht die Marke — dieselbe
// Bewegung wie bei `client-files.mjs` und (bis #248) `mirrored-shapes.mjs`: was
// VORRICHTUNG ist und kein Prüfschritt, wandert unter eigenem Namen daneben.
// Der Vergleich gegen den Router und der Selbsttest dieses Lesers stehen
// weiterhin dort.
//
// ⚠️ DER DATEINAME TRÄGT KEIN `.test.` — der Weblauf ist
// `node --import tsx --test "tests/**/*.test.{mjs,tsx}"`, und eine Hilfsdatei,
// die dieses Muster träfe, würde als Testdatei eingesammelt und meldete „keine
// Tests" (dieselbe Erklärung steht am Kopf von `client-files.mjs`).
//
// ⚠️ HIER STEHT KEINE ZUSICHERUNG. Diese Datei liest; sie behauptet nichts.
// Dass sie richtig liest, prüft der Selbsttest in `api-mirror.test.mjs` an
// einem erfundenen Quelltext — eine Vorrichtung, die selbst prüft, prüft in
// jeder Datei mit, die sie einbindet.
//
// ⚠️ SIE BEKOMMT FUNKTIONEN UND KEINE DATEIEN. Der Schnitt an den
// Funktionsköpfen steht im Wächter (`clientFunctions`), und dieser Leser
// arbeitet auf dessen Ergebnis: so gibt es den Schnitt weiterhin genau einmal,
// und der Selbsttest kann beide Leser an demselben erfundenen Quelltext messen.

import { spanFrom } from "./router-routes.mjs";

// Warum es ihn gibt: `streamContainerLogs` liest einen NDJSON-STROM, und
// `request<T>` liest den Rumpf mit `response.json()` am Stück. Ein Strom, der
// erst vollständig gelesen und dann ausgeliefert wird, ist keiner — dieser
// Aufruf kann also gar nicht über die vier Helfer laufen. Der Leser darüber
// sah ihn deshalb nicht, und der Vorfall 3 im Kopf dieser Datei ist das, was
// daraus folgte: eine einseitige Umbenennung der Route lief durch die ganze
// grüne Kette.
//
// ⚠️ ER FRAGT NUR NACH PFAD UND METHODE, nicht nach dem Umschlag. Das ist
// keine halbe Arbeit, sondern die ganze mögliche: ein Strom hat keinen
// Umschlag, und der Router sendet auf dieser Route im Erfolgsfall nie ein
// `.json(…)` — es gäbe auf der Gegenseite nichts zu vergleichen.

/**
 * Die Teile eines Ausdrucks auf OBERSTER Ebene, getrennt an `separator`.
 *
 * ⚠️ `=>` ist kein schließendes `>`. Ohne diese Ausnahme fiele die Tiefe bei
 * einem Parameter wie `onLine: (line: LogLine) => void` unter null, und die
 * Trennung danach wäre falsch.
 */
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let part = "";
  let quote = null;
  let previous = "";
  for (const character of text) {
    if (quote !== null) {
      part += character;
      if (character === quote && previous !== "\\") quote = null;
      previous = character;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      part += character;
      previous = character;
      continue;
    }
    if (character === "{" || character === "[" || character === "(" || character === "<") depth += 1;
    else if (character === "}" || character === "]" || character === ")") depth -= 1;
    else if (character === ">" && previous !== "=") depth -= 1;
    if (depth === 0 && character === separator) {
      parts.push(part);
      part = "";
      previous = character;
      continue;
    }
    part += character;
    previous = character;
  }
  parts.push(part);
  return parts;
}

/** Die Namen der Parameter einer Funktion, in der Reihenfolge des Kopfes. */
function parameterNames(params) {
  const names = [];
  for (const part of splitTopLevel(params, ",")) {
    const name = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)/.exec(part);
    if (name !== null) names.push(name[1]);
  }
  return names;
}

/**
 * Der Text aller Zeichenketten- und Vorlagenteile eines Ausdrucks,
 * aneinandergehängt. `${…}` bleibt stehen — daraus macht `normalizePath`
 * später `:param`. Alles, was keine Zeichenkette ist (ein `+`, eine
 * Bedingung, ein Klammerpaar), fällt weg.
 *
 * Damit wird aus ``` `/api/a/${x}` + `/b` ``` das Stück `/api/a/${x}/b`, und
 * aus einer Bedingung mit zwei Zweigen die Aneinanderreihung beider — für
 * einen PFAD reicht das, weil die Zweige dort eine Abfrage sind und keine
 * zweite Route (siehe den Schnitt am `?` in `rawCalls`).
 */
export function literalText(expression) {
  let text = "";
  let index = 0;
  while (index < expression.length) {
    const quote = expression[index];
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      index += 1;
      continue;
    }
    index += 1;
    while (index < expression.length && expression[index] !== quote) {
      if (expression[index] === "\\") {
        text += expression[index + 1] ?? "";
        index += 2;
        continue;
      }
      text += expression[index];
      index += 1;
    }
    index += 1;
  }
  return text;
}

/** Die rechte Seite eines `const <name> = …;` in `body`, oder `null`. */
export function constValue(body, name) {
  const head = new RegExp(`\\bconst\\s+${name}\\s*=`).exec(body);
  if (head === null) return null;
  const start = head.index + head[0].length;
  let index = start;
  let depth = 0;
  let quote = null;
  while (index < body.length) {
    const character = body[index];
    if (quote !== null) {
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === quote) quote = null;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") quote = character;
    else if (character === "{" || character === "[" || character === "(") depth += 1;
    else if (character === "}" || character === "]" || character === ")") depth -= 1;
    else if (character === ";" && depth === 0) return body.slice(start, index);
    index += 1;
  }
  return null;
}

/**
 * `${name}` durch den Wert ersetzen, den `const name = …` im selben Rumpf
 * trägt — so wird aus `…/logs-stream${query}` das Stück
 * `…/logs-stream?tail=${…}`, und der Schnitt am `?` kann greifen.
 *
 * `seen` bricht den Ring: ein Name wird höchstens einmal aufgelöst.
 */
function resolveNames(text, body, seen) {
  return text.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (whole, name) => {
    if (seen.has(name)) return whole;
    const value = constValue(body, name);
    if (value === null) return whole;
    seen.add(name);
    return resolveNames(literalText(value), body, seen);
  });
}

/**
 * Jeder Aufruf im Web, der den Hub UNMITTELBAR anspricht — `fetch(…)` wie
 * `xhr.open(<Methode>, <Pfad>)`. Mit Pfad und Methode, ohne Umschlag.
 *
 * ⚠️ `XMLHttpRequest` STEHT SEIT #136 DANEBEN, und der Anlass ist gemessen:
 * `uploadContainerFile` ist von `fetch` auf `XMLHttpRequest` umgestellt, weil
 * `fetch` den Fortschritt des SENDENS nicht meldet (Begründung an der Funktion
 * selbst). Mit einem Leser, der nur `fetch(` kennt, fiel dieser Aufruf aus der
 * Prüfung — die Marke unten meldete vier statt fünf. Angepasst ist deshalb der
 * WÄCHTER und nicht der Bau: eine Bauweise, die richtig ist, macht die Prüfung
 * nach (AGENTS.md, „Der Wächter passt sich dem Code an").
 *
 * ⚠️ DIE TRANSPORTFUNKTIONEN BENUTZEN SELBST `fetch`, und zwar zweimal
 * (`request` und `requestNoContent`). Ohne einen Ausschluss zählte dieser
 * Leser jeden Aufruf des Webs ein zweites Mal — oder meldete zwei Pfade, die
 * er nicht lesen kann.
 *
 * AUSGESCHLOSSEN WIRD ÜBER DEN URSPRUNG DES PFADES: steht im ersten Argument
 * von `fetch` ein Name, der ein PARAMETER dieser Funktion ist, dann bekommt
 * sie ihren Pfad von außen und nennt keinen — sie ist der Weg und nicht der
 * Aufruf. Der Aufruf steht dann bei ihrem Aufrufer, und den sieht entweder
 * `clientCalls()` oder dieser Leser hier.
 *
 * Warum GENAU SO und nicht anders — die beiden naheliegenden Alternativen
 * sind beide schlechter:
 *
 *   • Über den NAMEN der Funktion (`request`, `requestNoContent`): das ist
 *     der zerbrechlichste Weg. Wer den Helfer umbenennt, schaltet diesen
 *     Leser stillschweigend ab — genau die Art von stillem Verfall, gegen die
 *     der ganze Wächter steht.
 *   • Über den FEHLENDEN Literalpfad („kein `"…"` unmittelbar im Aufruf →
 *     übergehen"): das träfe den Aufruf, um den es hier geht, mit. Auch
 *     `streamContainerLogs` schreibt keinen Literalpfad in den `fetch`; es
 *     baut ihn eine Zeile darüber in `const path = …` zusammen. Die Umkehrung
 *     („kein Literal → Befund") machte die beiden Helfer rot.
 *
 * Die benannte Grenze des gewählten Wegs: ein künftiger Aufruf, der seinen
 * Pfad ebenfalls als Parameter bekommt, wäre auch ein Transportweg und würde
 * übergangen. Dass überhaupt noch etwas gefunden wird, hält der Zählstand im
 * Testfall des Wächters fest. `functions` kommt aus `clientFunctions` — dem
 * Schnitt an den Funktionsköpfen, der dort steht und hier nicht wiederholt
 * wird.
 */
export function rawCalls(functions) {
  const found = [];
  for (const fn of functions) {
    const parameters = parameterNames(fn.params);

    // Der Pfad eines Aufrufs als Text — `null`, wenn der Leser ihn nicht
    // zusammenbekommt, und `undefined`, wenn dieser Aufruf ein TRANSPORTWEG
    // ist (sein Pfad ist ein Parameter der Funktion) und deshalb übergangen
    // gehört. Die Unterscheidung ist die aus dem Absatz oben, hier einmal
    // aufgeschrieben statt zweimal.
    const pathOf = (expression) => {
      const isName = /^[A-Za-z_$][\w$]*$/.test(expression);
      if (isName && parameters.includes(expression)) return undefined;
      const source = isName ? constValue(fn.text, expression) : expression;
      const text = source === null ? "" : resolveNames(literalText(source), fn.text, new Set([expression]));
      // Die Abfrage gehört nicht zum Pfad: `?tail=…` steht in keiner Route.
      return text === "" ? null : text.split("?")[0];
    };

    // ⚠️ Kein `.fetch(` und kein `prefetch(` — nur der freistehende Aufruf.
    for (const match of fn.text.matchAll(/(?<![\w$.])fetch\s*\(/g)) {
      const open = match.index + match[0].length - 1;
      const args = spanFrom(fn.text, open, "(", ")");
      if (args === null) continue;
      const path = pathOf(splitTopLevel(args, ",")[0].trim());
      if (path === undefined) continue;

      const explicit = /\bmethod:\s*"([a-z]+)"/i.exec(args);
      found.push({
        fn: fn.name,
        // `null` heißt: der Leser bekommt den Pfad nicht zusammen — und der
        // Aufruf wird davon ROT statt still grün.
        path,
        method: (explicit === null ? "get" : explicit[1]).toLowerCase()
      });
    }

    // Der zweite Weg: `xhr.open("PUT", "/api/…")`. Die Methode steht hier im
    // ERSTEN Argument und der Pfad im zweiten — umgekehrt zu `fetch`, wo der
    // Pfad vorn steht und die Methode in den Einstellungen.
    //
    // ⚠️ Gesucht wird `<name>.open(` und nicht `open(`: ein freistehendes
    // `open(` wäre `window.open` und damit eine Navigation, kein Aufruf an den
    // Hub.
    for (const match of fn.text.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*\.open\s*\(/g)) {
      const open = match.index + match[0].length - 1;
      const args = spanFrom(fn.text, open, "(", ")");
      if (args === null) continue;
      const parts = splitTopLevel(args, ",");
      if (parts.length < 2) continue;
      const path = pathOf(parts[1].trim());
      if (path === undefined) continue;

      // `null` wie beim Pfad: eine Methode aus einer Variablen bekommt dieser
      // Leser nicht zusammen, und der Aufruf wird davon ROT statt still grün.
      const method = /^\s*(["'`])([a-zA-Z]+)\1\s*$/.exec(parts[0]);
      found.push({ fn: fn.name, path, method: method === null ? null : method[2].toLowerCase() });
    }
  }
  return found;
}
