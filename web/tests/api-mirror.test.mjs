import assert from "node:assert/strict";
import test from "node:test";

import { clientFiles } from "./client-files.mjs";
import { constValue, literalText, rawCalls } from "./raw-calls.mjs";
import { readAllRoutes, routerFiles as routerFilesRaw, spanFrom } from "./router-routes.mjs";
import { stripComments } from "./strip-comments.mjs";

// Wächter über die handgeschriebene Spiegelung der Serverform im Web (#85).
//
// ── DIE LÜCKE ───────────────────────────────────────────────────────────────
//
// Die Dateien unter `web/src/api/` beschreiben die Antwortformen des Servers
// ein zweites Mal, von Hand. Und `request<T>` castet die Antwort BLIND:
//
//     return (await response.json()) as T;
//
// TypeScript prüft danach nichts mehr — weder ein fehlendes Feld noch einen
// falschen Umschlag. Eine Funktion darf hier alles versprechen; der Compiler
// glaubt es ihr.
//
// ── DREI VORFÄLLE, KEIN ZUFALL ─────────────────────────────────────────────
//
//   1. D7a (#82): `createHost` versprach `Promise<DockerHost>`, während
//      `POST /api/hosts` mit `{ host: … }` antwortete. Wer im Dialog einen Arm
//      anlegte, bekam eine Zeile mit `id: undefined` in die Liste, bis er neu
//      lud. Der Fehler war zwei Pakete alt und lief die ganze Zeit durch eine
//      grüne Kette.
//   2. D7b (#84): eine Etappe erweiterte `StackView` nur unter `server/src/`;
//      die nächste konnte nicht bauen. Dort fiel es auf, weil `tsc` an der
//      EIGENEN Seite scheiterte — die umgekehrte Richtung (das Web verspricht
//      ein Feld, das der Server nicht schickt) fällt weiterhin niemandem auf.
//   3. B4b-L (#5, gemessen am 2026-09-07): die Route `logs-stream` einseitig
//      auf `logs-strom` umbenannt, den Pfad im Servertest mitgezogen, den
//      Web-Client unverändert gelassen — die GANZE Kette blieb grün (Servertest
//      12/12, Web 207/207), und der Browser wäre in eine 404 gelaufen.
//      `streamContainerLogs` läuft über keinen der vier Helfer, und dieser
//      Wächter sammelte bis dahin nur, was über sie lief.
//
// Alle drei Fälle stellt der Selbsttest ganz unten als Mutation nach.
//
// ── WAS DIESER WÄCHTER HÄLT ────────────────────────────────────────────────
//
//   1. Jeder Aufruf im Web findet im Router eine Route mit diesem Pfad und
//      dieser Methode. Gesammelt wird auf ZWEI Wegen: über die vier Helfer
//      (`request`, `requestNoContent`, `postJson`, `putJson`) und — seit
//      Etappe B4b-L (#5) — über jeden Aufruf, der den Hub unmittelbar
//      anspricht: `fetch(…)` und, seit #136, `xhr.open(<Methode>, <Pfad>)`.
//   2. Der UMSCHLAG stimmt überein: die obersten Schlüssel, die das Web
//      erwartet, sind genau die, die der Router in seinen erfolgreichen
//      `response.json(…)` sendet.
//
// A third point stood here until #248: a shape BOTH sides kept by hand carried
// the same top-level fields on both sides. Those shapes are schemas in
// `contract/` now, and server and web derive their types from one source;
// the comparison and its list (`mirrored-shapes.mjs`) are gone.
//
// ⚠️ WAS ER NICHT HÄLT, ausdrücklich und nicht als Überraschung später: er
// liest den TEXT beider Seiten und keinen Syntaxbaum. Er vergleicht die
// obersten Schlüssel, nicht die Typen darunter — ein `running: string` gegen
// ein `running: number` bleibt für ihn gleich. Bei einem rohen `fetch` prüft er
// NUR Pfad und Methode und den Umschlag GAR NICHT: der einzige solche Aufruf
// liest einen NDJSON-Strom, ein Strom hat keinen Umschlag, und der Router sendet
// auf dieser Route im Erfolgsfall nie ein `.json(…)`. Das ist keine Bequemlichkeit,
// sondern die Grenze der Frage selbst. Und er sieht nur, was in diesen Dateien
// steht: eine Antwortform, die ein Handler aus einem anderen Modul
// zusammensetzt, kennt er nur an ihrem obersten Schlüssel. Wie seine
// Geschwister hält er die Gewohnheit, nicht die Absicht. Das eigentliche
// Mittel wäre ein gemeinsamer Typ statt einer Abschrift; solange die
// Abschrift steht, ist dies die Sperrklinke.
//
// Seit der Aufteilung von `router.ts` (Etappe B4a-A1, #5) steht eine Route
// nicht mehr zwingend in EINER Datei — `routerFiles()` aus `router-routes.mjs`
// liefert `router.ts` und jede Datei unter `server/src/api/routes/`, und
// dieser Wächter vergleicht gegen alle davon.
//
// Seit Etappe B5-E4 (#5) gilt dieselbe Bewegung für die Web-Seite: ein
// Aufruf muss nicht mehr zwingend in `client.ts` stehen — `clientFiles()`
// aus `client-files.mjs` liest jede `.ts`-Datei unter `web/src/api/` außer
// Testdateien und `.d.ts`. Auf dem heutigen Stand ist das genau eine Datei;
// Paket B5 legt eine Datei-API daneben, weil `client.ts` an der Zeilenmarke
// steht (910/1000). Der Leser sitzt in einer EIGENEN Datei und nicht in
// `router-routes.mjs`: jene liest ROUTEN, die Dateien unter `web/src/api/`
// sind keine — Begründung und Bauart stehen im Kopf von `client-files.mjs`.
//
// Seit #136 steht der ZWEITE LESER daneben, in `raw-calls.mjs` — die Aufrufe,
// die den Hub unmittelbar ansprechen (`fetch` und `xhr.open`). Der Anlass ist
// derselbe wie bei der Liste darunter: diese Datei stand mit ihm bei 1.039
// Zeilen. Sein Selbsttest ist geblieben, wo er hingehört — ganz unten in
// dieser Datei.
//

// Wo der Router eingehängt ist (`server/src/index.ts`: `app.use("/api", …)`).
// Die Pfade im Web tragen ihn, die im Router nicht.
const MOUNT = "/api";

// Pfade, die dieser Router NICHT anmeldet und die trotzdem hier stehen dürfen.
// Jede Zeile ist eine Ausnahme und trägt ihren Grund daneben.
const FOREIGN_PREFIXES = new Map([
  ["/api/auth/", "denn dahinter liegt better-auth mit eigenen Routen und eigener Herkunftsprüfung (SECURITY.md, Grundsatz 2)"]
]);

// Die vier Wege, auf denen diese Datei den Server anspricht, und die Methode,
// die jeder von sich aus mitbringt. `null` heißt: sie steht im zweiten
// Argument oder es bleibt bei GET.
const HELPERS = new Map([
  ["request", null],
  ["requestNoContent", null],
  ["postJson", "post"],
  ["putJson", "put"]
]);

// Jede Datei der Web-API, roh gelesen — die dritte Sperrklinke unten prüft,
// dass diese Liste nicht auf null fällt.
const clientFileList = clientFiles();

// Dieselben Dateien OHNE Kommentare. Alles, was hier gelesen wird, ist Code —
// ein Pfad in einem Kommentar oder ein `.json({ … })` in einem Beispiel wäre
// sonst ein Fund. `stripComments` ersetzt durch Leerzeichen und behält die
// Zeilenumbrüche, die Stellen bleiben also, wo sie sind.
const strippedClientFiles = clientFileList.map(({ file, content }) => ({ file, content: stripComments(content) }));

// Dieselbe Kommentarbereinigung, aber über ALLE Router-Dateien hinweg —
// `routerFiles()` liest `router.ts` und, sobald es sie gibt, jede Datei unter
// `server/src/api/routes/`.
const routerFiles = () =>
  readAllRoutes(routerFilesRaw().map(({ file, content }) => ({ file, content: stripComments(content) })));

// ── Lesen ───────────────────────────────────────────────────────────────────

/**
 * Die obersten Feldnamen eines Typliterals — `text` ist der INHALT der
 * geschweiften Klammern, ohne Kommentare.
 *
 * Gezählt wird auf der obersten Ebene: ein `{ stats: { cpu: number } }` meldet
 * `stats` und nicht `cpu`.
 */
export function typeKeys(text) {
  const keys = [];
  let depth = 0;
  let member = "";
  let quote = null;
  const take = () => {
    const name = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(member);
    if (name !== null) keys.push(name[1]);
    member = "";
  };
  for (const character of text) {
    if (quote !== null) {
      member += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      member += character;
      continue;
    }
    if (character === "{" || character === "[" || character === "(" || character === "<") depth += 1;
    if (character === "}" || character === "]" || character === ")" || character === ">") depth -= 1;
    if (depth === 0 && (character === ";" || character === ",")) {
      take();
      continue;
    }
    member += character;
  }
  take();
  return keys;
}

/** Der erste Objektteil eines Typausdrucks, oder `null`, wenn er keinen hat. */
function objectPart(text) {
  const open = text.indexOf("{");
  if (open === -1) return null;
  return spanFrom(text, open, "{", "}");
}

/**
 * Die exportierten Typaliase einer Datei: Name → Text der rechten Seite.
 *
 * Die rechte Seite endet am Semikolon der OBERSTEN Ebene — ein Semikolon
 * zwischen den Feldern des Literals beendet sie nicht.
 */
function typeAliases(source) {
  const aliases = new Map();
  for (const match of source.matchAll(/\bexport type ([A-Za-z_$][\w$]*)\s*=/g)) {
    let index = match.index + match[0].length;
    let depth = 0;
    let end = -1;
    while (index < source.length) {
      const character = source[index];
      if (character === "{" || character === "[" || character === "(" || character === "<") depth += 1;
      else if (character === "}" || character === "]" || character === ")" || character === ">") depth -= 1;
      else if (character === ";" && depth === 0) {
        end = index;
        break;
      }
      index += 1;
    }
    if (end !== -1) aliases.set(match[1], source.slice(match.index + match[0].length, end));
  }
  return aliases;
}

// Über alle Dateien hinweg zusammengetragen (heute nur `client.ts`); ein
// doppelter Aliasname gewönne über die später gelesene Datei.
const clientAliases = new Map(strippedClientFiles.flatMap(({ content }) => [...typeAliases(content)]));

/**
 * Der angemeldete Rückgabetyp einer Funktion — `text` beginnt hinter der
 * schließenden Klammer der Parameterliste.
 *
 * ⚠️ Nicht mit einem Ausdruck bis zum ersten `{`: `Promise<{ open: boolean }>`
 * trägt selbst eine geschweifte Klammer, und der Rückgabetyp hörte dort
 * mittendrin auf. Gesucht ist die Klammer, die den RUMPF öffnet — die erste
 * auf oberster Ebene, hinter der keine zweite mehr folgt. (Bei
 * `(): { a: string } {` folgt eine, dann war die erste ein Typliteral.)
 */
function declaredReturnType(text) {
  const colon = /^\s*:/.exec(text);
  if (colon === null) return null;
  let index = colon[0].length;
  let depth = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "<" || character === "(" || character === "[") depth += 1;
    else if (character === ">" || character === ")" || character === "]") depth -= 1;
    else if (character === "}") depth -= 1;
    else if (character === "{") {
      if (depth > 0) {
        depth += 1;
        index += 1;
        continue;
      }
      const inner = spanFrom(text, index, "{", "}");
      if (inner === null) return null;
      const after = index + inner.length + 2;
      // Folgt noch eine Klammer, war diese hier der Typ und nicht der Rumpf.
      if (/^\s*\{/.test(text.slice(after))) {
        index = after;
        continue;
      }
      return text.slice(colon[0].length, index).trim();
    }
    index += 1;
  }
  return null;
}

/**
 * Jede exportierte Funktion EINER Datei als eigener Ausschnitt: Name,
 * angemeldeter Rückgabetyp und Text bis zur nächsten exportierten Funktion
 * DERSELBEN Datei — der Schnitt geht nie über eine Dateigrenze hinweg (wie
 * beim Rumpf einer Route trüge er sonst die nächste Funktion mit herein).
 *
 * `params` ist der ROHE Text der Parameterliste. Der zweite Leser
 * (`rawCalls`) braucht ihn, um eine Transportfunktion von einer
 * Aufruffunktion zu unterscheiden — siehe die Begründung dort.
 */
function functionsInFile(file, source) {
  // ⚠️ Geschnitten wird an JEDER Funktionsdeklaration, nicht nur an den
  // exportierten. Sonst schlucken die letzten exportierten Funktionen die
  // internen Helfer darunter (`postJson`, `putJson`) — und `hostArchiveUrl`,
  // das gar keine Anfrage stellt, sähe für den Leser aus wie eine.
  // ⚠️ Der Typparameter gehört in den Kopf (`postJson<T>(`). Ohne ihn wären
  // genau die vier Transportfunktionen keine Grenze, und die Ausschnitte ihrer
  // Vorgänger schluckten sie mit.
  const heads = [...source.matchAll(/\b(export )?(?:async )?function ([A-Za-z_$][\w$]*)\s*(?:<[^(]*>)?\s*\(/g)];
  return heads.map((head, position) => {
    const next = heads[position + 1];
    const text = source.slice(head.index, next === undefined ? source.length : next.index);
    // Hinter der Parameterliste steht `: <Rückgabetyp> {`. Die Parameterliste
    // endet an der Klammer, die zum `(` des Kopfes gehört.
    const params = spanFrom(source, head.index + head[0].length - 1, "(", ")");
    const afterParams = params === null ? "" : text.slice(head[0].length + params.length + 1);
    return {
      file,
      name: head[2],
      exported: head[1] !== undefined,
      text,
      params: params ?? "",
      declared: declaredReturnType(afterParams)
    };
  });
}

/**
 * `functionsInFile`, aber über MEHRERE Dateien hinweg — `files` ist eine
 * Liste aus `{ file, content }`-Einträgen mit bereits kommentarbereinigtem
 * Inhalt, voreingestellt der ganze gelesene Bestand unter `web/src/api/`.
 * Der Parameter steht hier, damit der Selbsttest ganz unten dieselben Leser
 * an einem erfundenen Quelltext messen kann statt an einer zweiten Abschrift.
 */
function clientFunctions(files = strippedClientFiles) {
  return files.flatMap(({ file, content }) => functionsInFile(file, content));
}

/** `${…}` wird zu `:param`; der Abfrageteil gehört nicht zur Route. */
function normalizePath(path) {
  return path.split("?")[0].replace(/\$\{[^}]*\}/g, ":param").replace(/:[A-Za-z_$][\w$]*/g, ":param");
}

/** Jeder Aufruf an den Server, den dieser Leser im Web versteht. */
function clientCalls(files = strippedClientFiles) {
  const calls = [];
  for (const fn of clientFunctions(files)) {
    const pattern = /\b(request|requestNoContent|postJson|putJson)\s*(<[\s\S]*?>)?\s*\(/g;
    for (const match of fn.text.matchAll(pattern)) {
      const open = match.index + match[0].length - 1;
      const args = spanFrom(fn.text, open, "(", ")");
      if (args === null) continue;
      const literal = /^\s*(["`])([^"`]*)\1/.exec(args);
      // A path held in a `const` of the same function (#248): a function that
      // parses its response names the path twice, for the request and for the
      // error, and keeps it in one place. The value must be a literal path;
      // anything else is not read.
      const named = literal === null ? /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(args) : null;
      const value = named === null ? null : constValue(fn.text, named[1]);
      const resolved = value === null ? null : literalText(value);
      const path = literal !== null ? literal[2] : resolved !== null && resolved.startsWith("/api/") ? resolved : null;
      // Kein Zeichenketten-Pfad: das ist der Durchgriff in `postJson`/`putJson`
      // (`request<T>(path, …)`) und keine eigene Anfrage.
      if (path === null) continue;

      const helper = match[1];
      const fromHelper = HELPERS.get(helper);
      const explicit = /\bmethod:\s*"([a-z]+)"/i.exec(args);
      calls.push({
        fn: fn.name,
        helper,
        path,
        method: (explicit !== null ? explicit[1] : (fromHelper ?? "get")).toLowerCase(),
        generic: match[2] === undefined ? null : match[2].slice(1, -1),
        declared: fn.declared,
        // Does the function check the response against a contract schema
        // (`parseResponse(…, <name>Schema, …)`, #247)?
        parsed: /\bparseResponse\s*\([^,]*,\s*[A-Za-z_$][\w$]*Schema\s*,/.test(fn.text),
        // Packt die Funktion den Umschlag aus (`const { host } = await …`)?
        // Nur der Text VOR dem Aufruf zählt — dahinter steht die Rückgabe.
        unwraps: /\bconst\s*\{[^}]*\}\s*=\s*await\s*$/.test(fn.text.slice(0, match.index))
      });
    }
  }
  return calls;
}


/**
 * Die obersten Schlüssel, die das Web von einer Antwort erwartet.
 *
 * Zuerst der Typparameter am Aufruf (`request<{ marks: … }>`), sonst der
 * angemeldete Rückgabetyp der Funktion. `null` heißt: der Leser kann es nicht
 * bestimmen — und der Aufrufer wird davon ROT statt still grün.
 */
function expectedKeys(call) {
  if (call.helper === "requestNoContent") return [];
  const source = call.generic ?? call.declared;
  if (source === null || source === undefined) return null;

  // `Promise<…>` auspacken, wenn es der angemeldete Rückgabetyp ist.
  const promise = /^\s*Promise\s*</.exec(source);
  const inner = promise === null ? source : spanFrom(source, source.indexOf("<"), "<", ">");
  if (inner === null) return null;
  const text = inner.trim();

  if (text === "void" || text === "unknown") return [];
  const literal = objectPart(text);
  if (literal !== null) return typeKeys(literal);

  // Ein benannter Typ dieser Datei — der Umschlag steht dann dort.
  const alias = clientAliases.get(text);
  if (alias !== undefined) {
    const part = objectPart(alias);
    if (part !== null) return typeKeys(part);
  }
  return null;
}

/** Die obersten Schlüssel der ERFOLGREICHEN Antworten einer Route. */
function routerKeys(body) {
  const keys = new Set();
  for (const match of body.matchAll(/(?:\.status\((\d{3})\))?\s*\.json\s*\(/g)) {
    const status = match[1] === undefined ? 200 : Number(match[1]);
    if (status < 200 || status > 299) continue;
    const open = match.index + match[0].length - 1;
    const argument = spanFrom(body, open, "(", ")");
    if (argument === null) continue;
    const literal = objectPart(argument);
    if (literal === null) continue;
    for (const key of shorthandKeys(literal)) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * Die obersten Schlüssel eines Objekt-LITERALS im Code — anders als im Typ
 * gibt es hier die Kurzform (`{ host, agent }`) ohne Doppelpunkt.
 */
export function shorthandKeys(text) {
  const keys = [];
  let depth = 0;
  let member = "";
  let quote = null;
  const take = () => {
    const name = /^\s*\.{0,3}\s*([A-Za-z_$][\w$]*)\s*(:|$)/.exec(member.trim());
    if (name !== null && member.trim() !== "") keys.push(name[1]);
    member = "";
  };
  for (const character of text) {
    if (quote !== null) {
      member += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      member += character;
      continue;
    }
    if (character === "{" || character === "[" || character === "(") depth += 1;
    if (character === "}" || character === "]" || character === ")") depth -= 1;
    if (depth === 0 && character === ",") {
      take();
      continue;
    }
    member += character;
  }
  take();
  return keys;
}

const routes = routerFiles();
const calls = clientCalls();
const foreign = (path) => [...FOREIGN_PREFIXES.keys()].some((prefix) => path.startsWith(prefix));
const own = calls.filter((call) => !foreign(call.path));
const rawOwn = rawCalls(clientFunctions()).filter((call) => call.path === null || !foreign(call.path));

function findRoute(call) {
  const wanted = normalizePath(call.path.slice(MOUNT.length));
  return routes.find((route) => route.method === call.method && normalizePath(route.path) === wanted);
}

// ── Die Sperrklinke ─────────────────────────────────────────────────────────

test("der Wächter sieht jeden Aufruf des Webs", () => {
  // Ohne diese drei Zahlen wäre jeder Fall unten grün, sobald der Leser
  // nichts mehr findet. Die dritte, `clientFileList.length` (seit B5-E4, #5),
  // fängt speziell einen Leser ab, der auf eine leere Dateiliste fällt — ohne
  // sie sähe das wie ein einzelner entfallener Aufruf aus, nicht wie ein
  // Leser, der gar nichts mehr liest.
  assert.ok(
    clientFileList.length >= 1,
    `Der Leser findet keine Datei mehr unter web/src/api/ und web/src/platform/http/ (erwartet mindestens 1, gemessen 1 am ` +
      "2026-09-07, dem Stand vor Paket B5)."
  );
  assert.ok(
    own.length >= 33,
    `Der Leser findet nur ${own.length} eigene Aufrufe unter web/src/api/ und web/src/platform/http/ (erwartet mindestens 33, ` +
      "gemessen 33 am 2026-09-08 per Mutationsprobe own.length >= 999, nach Etappe B6-E6: 30 auf " +
      "`90fb084` plus die drei kurzen Exec-Routen aus `exec.ts` — der Strom daneben zählt im Fall " +
      "darunter). Entweder ist ein Aufruf " +
      "entfallen — dann gehört die Zahl hier heruntergesetzt und der Grund daneben — oder der " +
      "Leser versteht ihn nicht mehr, und dann prüft dieser Wächter ihn stillschweigend nicht mehr."
  );
  // ⚠️ HIER STAND 28, UND DER BESTAND WAR SCHON VOR DIESER ETAPPE BEI 30.
  // Gemessen am 2026-09-08 auf `90fb084` mit derselben Mutationsprobe: zwei
  // Aufrufe hätten wegfallen können, ohne dass etwas rot wird. Dieselbe
  // Fehlerklasse wie die vier Marken, die in Paket B5 unter dem Bestand lagen
  // — eine `>= N`-Marke verfällt nicht gelegentlich, sondern als Regel, und
  // sie wird beim Wachsen NACHGEZOGEN.

  // Eine Funktion, die einen der vier Wege benutzt, deren Pfad aber nicht als
  // Zeichenkette dasteht, fiele stillschweigend aus der Prüfung. Sie wäre
  // genau die, die niemand mehr gegen den Router hält.
  // Die vier Transportfunktionen selbst nennen ihren eigenen Namen und
  // reichen einen Pfad durch, statt einen zu nennen — sie SIND der Weg.
  // Dass es sie noch gibt, prüft der Fall darunter; verschwände eine
  // wortlos, führe dieser Wächter mit einer Ausnahme für nichts.
  const seen = new Set(clientFunctions().map((fn) => fn.name));
  for (const helper of HELPERS.keys()) {
    assert.ok(
      seen.has(helper),
      `Die Transportfunktion „${helper}" gibt es unter web/src/api/ und web/src/platform/http/ nicht mehr — dann gehört sie ` +
        "auch aus HELPERS heraus, und der Wächter braucht den neuen Namen."
    );
  }

  const blind = clientFunctions()
    .filter((fn) => !HELPERS.has(fn.name))
    .filter((fn) => [...HELPERS.keys()].some((helper) => new RegExp(`\\b${helper}\\s*[<(]`).test(fn.text)))
    .filter((fn) => !calls.some((call) => call.fn === fn.name))
    .map((fn) => fn.name);

  assert.deepEqual(
    blind,
    [],
    "Diese Funktionen sprechen den Server an, aber ihr Pfad steht nicht als Zeichenkette " +
      "unmittelbar hinter dem Aufruf — der Wächter prüft sie damit NICHT:\n" + blind.join("\n")
  );
});

test("jeder Aufruf des Webs findet seine Route im Router", () => {
  const missing = own
    .filter((call) => findRoute(call) === undefined)
    .map((call) => `${call.fn}: ${call.method.toUpperCase()} ${call.path}`);

  assert.deepEqual(
    missing,
    [],
    "Diese Aufrufe treffen keine angemeldete Route — sie enden in einer 404, die wie ein " +
      "Serverfehler aussieht:\n" + missing.join("\n")
  );
});

test("jeder rohe Aufruf des Webs findet seine Route im Router", () => {
  // Dieselbe Sperrklinke wie oben, und aus demselben Grund: fände der Leser
  // nichts mehr, wäre der Rest dieses Falles still grün — und niemand hielte
  // den Strom-Aufruf noch gegen den Router.
  assert.ok(
    rawOwn.length >= 5,
    `Der zweite Leser findet nur ${rawOwn.length} rohe Aufrufe unter web/src/api/ und web/src/platform/http/ (erwartet ` +
      "mindestens 5, gemessen 5 am 2026-09-09 per Mutationsprobe rawOwn.length >= 999: " +
      "`streamContainerLogs` in client.ts, `saveFileText` und `uploadContainerFile` in files.ts " +
      "— die beiden schicken einen rohen Rumpf mit eigenem content-type, weil `express.json` " +
      "sonst vor dem Router zuschlägt —, dazu der vierte, der auf `90fb084` schon da war und den " +
      "die alte Marke von drei nicht mehr traf, und seit B6-E6 `streamContainerExec` in exec.ts). " +
      "Die Zahl steht unverändert bei fünf, seit `uploadContainerFile` über `xhr.open` läuft " +
      "statt über `fetch` (#136) — gezählt wird der AUFRUF und nicht sein Werkzeug. " +
      "Entweder läuft einer davon jetzt " +
      "über einen der vier Helfer — dann gehört diese Zahl heruntergesetzt und der Grund daneben — " +
      "oder der Leser versteht ihn nicht mehr, und dann prüft dieser Wächter ihn stillschweigend " +
      "nicht mehr."
  );

  // ⚠️ DIE METHODE STEHT HIER NEBEN DEM PFAD, und das ist seit #136 nötig: bei
  // `fetch` fällt sie auf `get` zurück, bei `xhr.open` steht sie im ersten
  // Argument und kann fehlen. Ein Aufruf ohne lesbare Methode fände unten
  // stillschweigend keine Route und sähe wie ein fehlender Pfad aus.
  const unreadable = rawOwn.filter((call) => call.path === null || call.method === null).map((call) => call.fn);
  assert.deepEqual(
    unreadable,
    [],
    "Diese Funktionen sprechen den Server unmittelbar an, aber der Leser bekommt ihren Pfad oder " +
      "ihre Methode nicht zusammen — er prüft sie damit NICHT:\n" + unreadable.join("\n")
  );

  const missing = rawOwn
    .filter((call) => call.path !== null && call.method !== null && findRoute(call) === undefined)
    .map((call) => `${call.fn}: ${call.method.toUpperCase()} ${call.path}`);

  assert.deepEqual(
    missing,
    [],
    "Diese rohen Aufrufe treffen keine angemeldete Route — sie enden in einer 404, die im " +
      "Browser wie ein Serverfehler aussieht, während die ganze Testkette grün bleibt (#5):\n" +
      missing.join("\n")
  );
});

test("jede Ausnahme in FOREIGN_PREFIXES trägt noch einen Aufruf", () => {
  // Wie bei den Ausnahmelisten des Nachbarwächters: eine Ausnahme, deren Fall
  // es nicht mehr gibt, bliebe sonst stehen, und der nächste Pfad, der
  // zufällig so beginnt, erbte sie.
  for (const [prefix, reason] of FOREIGN_PREFIXES) {
    assert.ok(
      calls.some((call) => call.path.startsWith(prefix)),
      `Kein Aufruf beginnt mehr mit „${prefix}" — dann gehört die Ausnahme hier heraus (${reason})`
    );
  }
});

test("der Umschlag stimmt: das Web erwartet genau die Schlüssel, die der Router sendet", () => {
  const findings = [];

  for (const call of own) {
    const route = findRoute(call);
    // Dass es die Route gibt, meldet der Fall darüber; hier nicht abstürzen.
    if (route === undefined) continue;

    assert.ok(
      route.body !== null,
      `${route.file}: ${call.method.toUpperCase()} ${call.path}: der Abgrenzer bekommt den Rumpf ` +
        "dieser Route nicht auf — sie wird damit NICHT geprüft."
    );

    // ⚠️ A response parsed against a schema from `contract` is held by that
    // schema and not by this reader (#248): the server test parses the real
    // route answer against it, the web parses every answer, and `tsc` ties the
    // declared type to the schema. The reader cannot follow a type imported
    // from `contract` anyway — it sees text, not types. Route and method stay
    // checked above for these calls too.
    if (call.parsed) continue;

    const expected = expectedKeys(call);
    assert.ok(
      expected !== null,
      `${call.fn}: der Wächter kann nicht bestimmen, welche Form diese Funktion erwartet. ` +
        "Ein Typparameter am Aufruf (`request<{ … }>`) sagt es ihm; ohne ihn prüft er sie NICHT."
    );

    const sent = routerKeys(route.body);
    const wanted = [...expected].sort();
    if (JSON.stringify(wanted) === JSON.stringify(sent)) continue;

    findings.push(
      `${call.fn} (${call.method.toUpperCase()} ${call.path}, ${route.file}): das Web erwartet ` +
        `{ ${wanted.join(", ") || "—"} }, der Router sendet { ${sent.join(", ") || "—"} }`
    );
  }

  assert.deepEqual(
    findings,
    [],
    "Eine Funktion unter web/src/api/ verspricht eine andere Form, als ihre Route sendet. `request<T>` " +
      "castet blind — TypeScript sieht das nicht, und die Oberfläche bekommt `undefined` statt " +
      "einer Fehlermeldung (#82, #85):\n" + findings.join("\n")
  );
});

// ── Die Leser selbst ────────────────────────────────────────────────────────

test("die Leser dieses Wächters: was sie sehen müssen und was nicht", () => {
  // Ein Wächter ohne eigenen Test ist eine Behauptung. Die beiden
  // Schlüsselleser sind die riskanten — der eine liest Typen, der andere Code.
  const findings = [];
  const check = (description, actual, expected) => {
    try {
      assert.deepEqual(actual, expected);
    } catch {
      findings.push(`${description}: bekam ${JSON.stringify(actual)}, erwartet ${JSON.stringify(expected)}`);
    }
  };

  check("die obersten Felder eines Typliterals", typeKeys("a: string; b: number"), ["a", "b"]);
  check("ein verschachteltes Feld zählt nicht", typeKeys("stats: { cpu: number; mem: number }; id: string"), [
    "stats",
    "id"
  ]);
  check("ein optionales Feld zählt", typeKeys("agent?: Health | null"), ["agent"]);
  check("ein Komma trennt so gut wie ein Semikolon", typeKeys("a: string, b: string"), ["a", "b"]);
  check("ein Doppelpunkt in einer Vereinigung verwirrt nicht", typeKeys('kind: "a" | "b"; id: string'), [
    "kind",
    "id"
  ]);

  check("die Kurzform im Objektliteral", shorthandKeys("host, agent"), ["host", "agent"]);
  check("die lange Form", shorthandKeys("host: toHostView(record, null)"), ["host"]);
  check("ein Aufruf mit Komma darin zählt einmal", shorthandKeys("host: f(a, b), agent"), ["host", "agent"]);
  check("gemischt", shorthandKeys("host, agent, containers: null, error: agent.error"), [
    "host",
    "agent",
    "containers",
    "error"
  ]);

  check("der Pfad mit Platzhalter", normalizePath("/hosts/${encodeURIComponent(hostId)}/containers"), "/hosts/:param/containers");
  check("der Pfad des Routers", normalizePath("/hosts/:hostId/containers"), "/hosts/:param/containers");
  check("der Abfrageteil", normalizePath("/hosts/:hostId/containers?plaintext=1"), "/hosts/:param/containers");

  // ── Der zweite Leser, an einem erfundenen Quelltext ────────────────────────
  //
  // Nachgestellt ist genau die Lage in `client.ts`: zwei Transportfunktionen,
  // die ihren Pfad als PARAMETER bekommen und `fetch` selbst aufrufen, und
  // eine Aufruffunktion, die ihren Pfad eine Zeile über dem `fetch`
  // zusammenbaut. Ohne den Ausschluss über den Ursprung des Pfades wären hier
  // drei Treffer statt einem.
  const sample = [
    "async function request<T>(path: string, init: RequestInit = {}): Promise<T> {",
    '  const response = await fetch(path, { credentials: "include", ...init });',
    "  return (await response.json()) as T;",
    "}",
    "async function requestNoContent(path: string, init: RequestInit = {}): Promise<void> {",
    '  const response = await fetch(path, { credentials: "include", ...init });',
    "}",
    "export async function streamNowhere(id: string, options: { tail?: number }): Promise<void> {",
    '  const query = options.tail === undefined ? "" : `?tail=${options.tail}`;',
    "  const path = `/api/hosts/${encodeURIComponent(id)}/gibt-es-nicht${query}`;",
    '  const response = await fetch(path, { credentials: "include" });',
    "}"
  ].join("\n");
  const sampleCalls = rawCalls(clientFunctions([{ file: "sample.ts", content: sample }]));

  // (1) Ein roher fetch auf einen Pfad, den der Router nicht anmeldet — und
  // (3) die beiden fetch IN den Transportfunktionen, die nicht mitzählen
  // dürfen: beides steckt in dieser einen Erwartung.
  check(
    "ein roher fetch wird gesehen, die fetch in den Transportfunktionen nicht",
    sampleCalls.map((call) => `${call.fn} ${call.method.toUpperCase()} ${call.path}`),
    ["streamNowhere GET /api/hosts/${encodeURIComponent(id)}/gibt-es-nicht"]
  );
  check(
    "und dieser Pfad ist im Router nicht angemeldet — der Leser meldet ihn",
    sampleCalls.map((call) => findRoute(call) !== undefined),
    [false]
  );
  check(
    "die beiden fetch in den Transportfunktionen von client.ts zählen nicht mit",
    rawCalls(clientFunctions())
      .filter((call) => HELPERS.has(call.fn))
      .map((call) => call.fn),
    []
  );

  // ── Derselbe Leser am zweiten Weg: `xhr.open` (seit #136) ─────────────────
  //
  // Nachgestellt ist die Lage in `files.ts`: ein Aufruf, der die Methode als
  // Literal und den Pfad als Ausdruck mit angehängter Abfrage nennt — und
  // daneben ein Transportweg, der seinen Pfad als PARAMETER bekommt und
  // deshalb NICHT mitzählen darf. Ohne den zweiten Fall wäre der Ausschluss
  // über den Ursprung des Pfades nur für `fetch` geprüft.
  const xhrSample = [
    "export function sendNowhere(id: string, file: File): Promise<void> {",
    "  const xhr = new XMLHttpRequest();",
    '  xhr.open("PUT", `/api/hosts/${encodeURIComponent(id)}/gibt-es-nicht` + `?name=${file.name}`);',
    "  xhr.send(file);",
    "}",
    "export function sendAnywhere(path: string, file: File): Promise<void> {",
    "  const xhr = new XMLHttpRequest();",
    '  xhr.open("PUT", path);',
    "  xhr.send(file);",
    "}"
  ].join("\n");
  check(
    "ein xhr.open wird mit Methode und Pfad gelesen, der Transportweg daneben nicht",
    rawCalls(clientFunctions([{ file: "xhr-sample.ts", content: xhrSample }])).map(
      (call) => `${call.fn} ${String(call.method).toUpperCase()} ${call.path}`
    ),
    ["sendNowhere PUT /api/hosts/${encodeURIComponent(id)}/gibt-es-nicht"]
  );

  // (2b) Kein Fehlalarm am echten Bestand: der Upload wird gesehen UND findet
  // seine Route. Er ist der einzige Aufruf dieser Art im Web.
  const upload = rawCalls(clientFunctions()).filter((call) => call.fn === "uploadContainerFile");
  check(
    "der Upload wird über xhr.open gelesen und findet seine Route",
    upload.map((call) => `${String(call.method).toUpperCase()} ${findRoute(call) !== undefined}`),
    ["PUT true"]
  );

  // (2) Kein Fehlalarm: der bestehende Aufruf auf `logs-stream` wird gesehen
  // UND findet seine Route. Fiele die Route weg oder würde sie einseitig
  // umbenannt, würde der Testfall oben rot — das ist Vorfall 3 im Kopf.
  const stream = rawCalls(clientFunctions()).filter((call) => call.fn === "streamContainerLogs");
  check(
    "der bestehende Strom-Aufruf wird mit Pfad und Methode gelesen",
    stream.map((call) => `${call.method.toUpperCase()} ${call.path}`),
    ["GET /api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/logs-stream"]
  );
  check(
    "und er ist kein Fehlalarm: seine Route gibt es",
    stream.map((call) => findRoute(call) !== undefined),
    [true]
  );

  // ── A path in a `const` and a parsed response (#248) ──────────────────────
  check(
    "a path in a const of the same function is read, the parse is seen",
    clientCalls([
      {
        file: "parsed-sample.ts",
        content: [
          "export async function fetchNowhere(id: string): Promise<Nowhere> {",
          "  const path = `/api/hosts/${encodeURIComponent(id)}/nowhere`;",
          "  return parseResponse(path, nowhereSchema, await request(path));",
          "}",
          "export async function fetchElsewhere(path: string): Promise<void> {",
          "  return request(path);",
          "}"
        ].join("\n")
      }
    ]).map((call) => `${call.fn} ${call.path} parsed=${call.parsed}`),
    ["fetchNowhere /api/hosts/${encodeURIComponent(id)}/nowhere parsed=true"]
  );

  // ── Der Funktionsschnitt über zwei erfundene Dateien (seit B5-E4, #5) ──────
  const twoFiles = [
    { file: "a.ts", content: 'export async function fromA(): Promise<void> {\n  const r = await fetch("/api/a");\n}' },
    { file: "b.ts", content: 'export async function fromB(): Promise<void> {\n  const r = await fetch("/api/b");\n}' }
  ];
  check(
    "zwei Dateien bleiben getrennt: kein Aufruf wandert über die Dateigrenze",
    rawCalls(clientFunctions(twoFiles)).map((call) => `${call.fn} ${call.path}`),
    ["fromA /api/a", "fromB /api/b"]
  );

  assert.deepEqual(findings, [], `Ein Leser dieses Wächters liest anders als zugesagt:\n${findings.join("\n")}`);
});
