import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readRoutes, readAllRoutes, routerFiles, ROUTE_LOOSE, routeBody } from "./router-routes.mjs";
import { stripComments } from "./strip-comments.mjs";

// The list of GET routes with an effect, read from the source text of the
// server and not imported: `web/` does not import `server/`
// (docs/design/feature-architecture.md, section 3, rule 4). Until #271 this
// import was one of the known violations of the boundary check. The list
// stays a security decision of the server and does not move to `contract/`;
// `server/src/platform/http/request-origin.test.ts` pins its entries, and the
// reader below is checked against a minimum so it cannot read nothing.
const REQUEST_ORIGIN_FILE = fileURLToPath(new URL("../../server/src/platform/http/request-origin.ts", import.meta.url));

function readGetRoutesWithEffect(source) {
  const text = stripComments(source);
  const start = text.search(/export\s+const\s+GET_ROUTES_WITH_EFFECT\b[^=]*=\s*\[/);
  if (start < 0) return null;
  const open = text.indexOf("[", text.indexOf("=", start));
  const close = text.indexOf("]", open);
  if (close < 0) return null;
  return [...text.slice(open + 1, close).matchAll(/"([^"\\]*)"/g)].map((match) => match[1]);
}

const GET_ROUTES_WITH_EFFECT = readGetRoutesWithEffect(readFileSync(REQUEST_ORIGIN_FILE, "utf8")) ?? [];

test("the list of GET routes with an effect is read from the server source", () => {
  // Eleven on 2026-10-02 (#271), the entries `request-origin.test.ts` pins.
  // Below that the reader lost entries, and every case built on the list
  // would check less without turning red.
  assert.ok(
    GET_ROUTES_WITH_EFFECT.length >= 11,
    `GET_ROUTES_WITH_EFFECT aus server/src/platform/http/request-origin.ts gelesen: ${GET_ROUTES_WITH_EFFECT.length} Einträge, erwartet mindestens 11`
  );
  assert.ok(GET_ROUTES_WITH_EFFECT.every((path) => path.startsWith("/hosts/") || path === "/live-events"));
  assert.deepEqual(readGetRoutesWithEffect('export const GET_ROUTES_WITH_EFFECT: readonly string[] = [\n  // "/not/this"\n  "/a",\n  "/b/:id"\n];'), [
    "/a",
    "/b/:id"
  ]);
  assert.equal(readGetRoutesWithEffect("export const OTHER = [];"), null);
});

// Wächter über die schreibenden Routen der API.
//
// Bis Phase 4a stand hier die Zusage „die API des Hubs ist LESEND" — jede
// Route ein GET, weil der erste Schreibzugriff die Stelle ist, an der eine
// Rechteprüfung stehen muss. Mit dem Anlegen und Entfernen eines Arms fällt
// diese Zusage (docs/design/phase-4-bootstrap-and-registration.md §4). Sie
// wird nicht abgeschaltet, sondern ersetzt: an ihre Stelle tritt die Zusage,
// dass jede dieser Routen hinter `requireAdmin` steht — und zwar als ERSTE
// Zwischenschicht, vor jedem Handler.
//
// Warum das eine Maschine prüft und kein Mensch: eine Zwischenschicht wirkt
// nur dort, wo sie angemeldet ist. Die vergessene sieht im Diff aus wie die
// vorhandene, die Route ist danach nicht halb geschützt, sondern offen, und
// kein Testlauf einer Funktion zeigt das — er ruft die Route mit einer
// Sitzung auf, die ohnehin Admin ist (`server/src/platform/auth/require-admin.ts`).
//
// ⚠️ Drei Dinge, die dieser Wächter ausdrücklich mitträgt:
//
//   1. `GET /hosts/:hostId/archive` ist ein GET und ändert trotzdem den
//      Zustand: jeder Aufruf rotiert Schlüssel, Secret und Token (§4). Die
//      Methode allein sagt hier also nichts; die Route steht deshalb unten
//      namentlich in `GET_ROUTES_WITH_EFFECT`
//      (`server/src/platform/http/request-origin.ts`), die dieser Wächter von dort
//      liest.
//
//      ⚠️ Jene Liste führt seit Etappe B4b-K (#5) ZWEI Sorten GET: den, der
//      den Zustand ändert, und den, der eine gedeckelte, geteilte Ressource
//      des Arms belegt und dort eine Spur unter fremdem Namen hinterlässt.
//      Für die Herkunftsprüfung sind beide dasselbe; für die Rollenfrage
//      nicht. Die zweite Sorte steht deshalb hier in
//      `SESSION_ONLY_GET_WITH_EFFECT` und wird gegen `withSession` geprüft
//      statt gegen `requireAdmin` — siehe dort.
//   2. Die Stellung zählt, nicht das Vorkommen. `requireAdmin` NACH dem
//      Handler liefe zu spät — die Wirkung wäre eingetreten, und die Antwort
//      sagte 403.
//   3. Seit #70 gibt es eine schreibende Route, die NICHT Admin verlangt:
//      `PUT /session/language` ändert eine Anzeigeeinstellung am eigenen
//      Konto und an nichts sonst, und ein Benutzer ohne Adminrechte muss
//      seine Sprache umstellen können. Sie steht namentlich in
//      `SESSION_ONLY_WRITE`.
//
//      ⚠️ Diese Ausnahme ist keine Tür. Eine Route in dieser Liste ist nicht
//      ungeprüft, sie ist ANDERS geprüft: für sie verlangt derselbe Fall
//      `withSession(` an genau der Stelle, an der die anderen `requireAdmin(`
//      tragen. Wer einen Pfad hier einträgt und die Zwischenschicht weglässt,
//      wird trotzdem rot. Und ein Eintrag, dessen Route es nicht mehr gibt,
//      wird ebenfalls rot — sonst bliebe eine Ausnahme stehen, die niemand
//      mehr liest.
//
//      ⚠️ Seit der Prüfung des Sprachpakets kommt die dritte Hälfte dazu, und
//      sie ist die eigentliche: `withSession` sagt nur, DASS jemand angemeldet
//      ist, nicht, an WESSEN Konto geschrieben wird. Der Fall „jede Route aus
//      SESSION_ONLY_WRITE schreibt am eigenen Konto und an keinem anderen"
//      unten verlangt deshalb, dass der Handler `user.id` nennt und KEINE
//      Kennung aus dem Rumpf der Anfrage zieht. Ohne ihn lief die Kette grün
//      durch, wenn man `user.id` durch eine `userId` aus dem Rumpf ersetzte.
//
// ⚠️ Er liest den TEXT der Dateien und nicht den Syntaxbaum. Das reicht für
// den Normalfall und nicht gegen Vorsatz — wie der UI-Text-Wächter hält er
// die Gewohnheit, nicht die Absicht.
//
// Seit der Aufteilung von `router.ts` (Etappe B4a-A1, #5) steht eine Route
// nicht mehr zwingend in EINER Datei — `routerFiles()` aus `router-routes.mjs`
// liefert `server/src/app/router.ts` und jedes `routes.ts` der Features, und
// dieser Wächter prüft sie alle. Jede Fehlermeldung nennt deshalb die Datei,
// in der der Fund steht: „unbewacht: PUT /marks" allein schickte den nächsten
// Leser erst auf die Suche.
//
// Der Anmeldeweg von better-auth ist nicht gemeint: er hängt unter /api/auth,
// bringt seine eigenen POST-Routen mit und prüft die Herkunft selbst. Der
// Anmeldeweg der Arme ebenso wenig — er ist eine eigene Anwendung mit genau
// einer Route (SECURITY.md, Grundsatz 2). Deshalb sieht dieser Wächter nur den
// eigenen Router.
//
// ⚠️ Seit Etappe B4a-E (#5) steht am Ende dieser Datei ein zweiter
// Gegenstand: die STELLUNG der Herkunftsprüfung in `server/src/app/router.ts`.
// Warum hier und nicht in `web/tests/server-wiring.test.mjs`, das den
// Stellungswächter für die Content-Security-Policy trägt: jener Wächter hat
// `server/src/index.ts` zum Gegenstand und begründet seine Existenz damit,
// dass es zu jener Datei keine Testdatei gibt. `router.ts` ist der Gegenstand
// DIESER Datei — sie liest ihn ohnehin über `routerFiles()` —, und die
// Fehlerklasse ist wörtlich die, die im Kopf hier schon steht: eine
// Zwischenschicht wirkt nur dort, wo sie angemeldet ist, und die vergessene
// sieht im Diff aus wie die vorhandene. Die Stellung zählt, nicht das
// Vorkommen — Punkt 2 oben, nur für eine router-weite Schicht statt für eine
// je Route.

// Lesende Routen, die trotzdem Admin verlangen, weil sie etwas verändern.
//
// ⚠️ DIESE LISTE STEHT NICHT MEHR HIER. Sie hieß bis Etappe B1 (#5)
// `ADMIN_ONLY_GET` und war eine eigene Konstante in dieser Datei; seit der
// Herkunftsprüfung braucht der Server dieselbe Liste, um zu wissen, welcher
// GET trotz GET etwas bewirkt. Zwei Orte laufen auseinander — wer den einen
// pflegt, pflegt den anderen nicht, und jeder bleibt für sich grün. Genau
// daraus entstand Befund S1 des Agenten. Sie steht deshalb im Server
// (`server/src/platform/http/request-origin.ts`, `GET_ROUTES_WITH_EFFECT`), und dieser
// Wächter liest sie VON DORT.
//
// Der Grund je Eintrag („denn er rotiert bei jedem Aufruf Schlüsselpaar,
// Agent-Secret und Token") ist dabei nicht verloren: er steht als Kommentar
// unmittelbar neben dem Eintrag in jener Datei. Die Fehlermeldungen unten
// zeigen deshalb dorthin statt den Grund abzuschreiben — eine abgeschriebene
// Begründung wäre die zweite Kopie, die dieser Umbau gerade beseitigt.
//
// ⚠️ WIE er dorthin kommt: als echter `import` aus einer `.ts`-Datei, nicht
// als Textabgleich. Gemessen am 2026-09-07 in dieser Umgebung — der Weblauf
// ist `node --import tsx --test "tests/**/*.test.{mjs,tsx}"`, und `tsx`
// übersetzt die importierte `.ts` mit; ein Wegwerf-Skript in `web/tests/`
// gab `IMPORT OK ["/hosts/:hostId/archive"]` aus. Ein Textabgleich hätte den
// Wert erst aus dem Quelltext klauben müssen und wäre damit wieder ein
// Verfahren, das an einer Umformatierung zerbricht, ohne dass sich etwas
// geändert hat.

// Schreibende Routen, die KEIN Admin verlangen — und was stattdessen für sie
// gilt. Jede Zeile hier ist eine Ausnahme von „schreiben heißt Admin" und
// trägt ihren Grund daneben.
//
// ⚠️ Sie sind damit nicht ungeprüft: derselbe Fall unten verlangt für sie
// `withSession(` als erste Zwischenschicht. Ohne Anmeldung gibt es kein
// eigenes Konto, an dem sich etwas einstellen ließe.
const SESSION_ONLY_WRITE = new Map([
  ["/session/language", "denn sie ändert eine Anzeigeeinstellung am eigenen Konto und an nichts sonst"]
]);

// GET-Routen aus `GET_ROUTES_WITH_EFFECT`, die KEIN Admin verlangen — und was
// stattdessen für sie gilt. Dieselbe Bauart wie `SESSION_ONLY_WRITE` darüber,
// und aus demselben Grund: eine Ausnahme mit ihrem Grund daneben, nicht ein
// stillschweigend übersprungener Fall.
//
// ⚠️ WARUM ES DIESE LISTE ÜBERHAUPT GIBT (Etappe B4b-K, #5). Bis dahin trug
// `GET_ROUTES_WITH_EFFECT` genau eine Sorte Route: einen GET, der den ZUSTAND
// ändert, und der verlangt Admin. Seither trägt sie eine zweite: einen GET,
// der nichts ändert und trotzdem eine gedeckelte, GETEILTE Ressource des Arms
// belegt und in dessen Audit-Log eine Spur unter dem Namen des angemeldeten
// Menschen hinterlässt. Für die HERKUNFTSPRÜFUNG sind beide dasselbe —
// prüfpflichtig, und genau dafür liest sie die Liste. Für die ROLLENFRAGE sind
// sie es nicht: Logs lesen ist eine Fähigkeit der Rolle User (§4), und
// `requireAdmin` davor wäre keine schärfere Prüfung, sondern eine andere und
// falsche Zusage.
//
// ⚠️ Diese Ausnahme ist keine Tür — wörtlich dieselbe Zusicherung wie bei
// `SESSION_ONLY_WRITE`: für einen Pfad in dieser Liste verlangt der Fall unten
// `withSession(` an genau der Stelle, an der die anderen `requireAdmin(`
// tragen. Wer einen Pfad hier einträgt und die Zwischenschicht weglässt, wird
// trotzdem rot. Und ein Eintrag, der nicht (mehr) in `GET_ROUTES_WITH_EFFECT`
// steht, wird ebenfalls rot: sonst bliebe eine Ausnahme stehen, die niemand
// mehr liest.
const SESSION_ONLY_GET_WITH_EFFECT = new Map([
  ["/live-events", "denn der Strom belegt eine begrenzte Hub-Verbindung; Live-Zustände lesen dürfen angemeldete User"],
  [
    "/hosts/:hostId/containers/:containerId/logs-stream",
    "denn sie ändert nichts — sie belegt einen der begrenzten Ströme des Arms und schreibt in dessen Audit-Log; " +
      "Logs lesen ist eine Fähigkeit der Rolle User (§4)"
  ],
  [
    "/hosts/:hostId/containers/:containerId/stats",
    "denn sie ändert nichts — die Einzelansicht des Agenten schreibt nur bei einer Ablehnung in dessen " +
      "Audit-Log; Messwerte lesen ist eine Fähigkeit der Rolle User wie die Übersicht"
  ]
]);

// Der Routenleser liegt in `router-routes.mjs` — eine Fassung für diesen
// Wächter und für `api-mirror.test.mjs` (#85). Zwei Abschriften desselben
// Klammerzählers wären zwei Wahrheiten; siehe den Kopf jener Datei.
function routes() {
  return readAllRoutes(routerFiles());
}

test("der Wächter sieht jede angemeldete Route", () => {
  // Ohne diesen Abgleich fiele eine Route, die anders geschrieben ist (Pfad in
  // einem Template-Literal, Methode über eine Variable), stillschweigend aus
  // der Prüfung — und genau die wäre die ungeschützte. Geprüft wird JE DATEI,
  // damit eine Abweichung sofort sagt, wo sie steht.
  const failures = [];
  for (const { file, content } of routerFiles()) {
    const declared = [...content.matchAll(ROUTE_LOOSE)].length;
    const found = readRoutes(content).length;
    if (found !== declared) {
      failures.push(
        `${file}: liest ${found} von ${declared} angemeldeten Routen — der Pfad gehört als ` +
          "einfache Zeichenkette direkt hinter die Methode."
      );
    }
  }
  assert.deepEqual(
    failures,
    [],
    "Eine angemeldete Route ist für diesen Wächter nicht lesbar. Er prüft sie damit nicht:\n" +
      failures.join("\n")
  );
});

// Every file under `server/src` that registers a route, read from disk and not
// through `git ls-files`, so a file not yet staged counts too. During the
// rebuild (#249 and after) route groups move from `api/routes/` into
// `features/<name>/`; a route in a file `routerFiles()` does not read escapes
// every case in this file, including the one for `GET_ROUTES_WITH_EFFECT`
// (#125), and the chain stays green.
const SERVER_SRC = fileURLToPath(new URL("../../server/src/", import.meta.url));

function filesRegisteringRoutes() {
  return readdirSync(SERVER_SRC, { recursive: true })
    .map((name) => name.split(sep).join("/"))
    .filter((name) => name.endsWith(".ts") && !name.includes(".test.") && !name.includes("test-support"))
    .filter((name) => [...stripComments(readFileSync(join(SERVER_SRC, name), "utf8")).matchAll(ROUTE_LOOSE)].length > 0)
    .map((name) => `server/src/${name}`)
    .sort();
}

test("jede Datei, die eine Route anmeldet, liest dieser Wächter mit", () => {
  const read = new Set(routerFiles().map(({ file }) => file));
  const registering = filesRegisteringRoutes();
  assert.ok(registering.length > 0, "Keine Datei unter server/src meldet eine Route an — der Fall prüft dann nichts.");
  const unread = registering.filter((file) => !read.has(file));
  assert.deepEqual(
    unread,
    [],
    "Diese Dateien melden Routen an, die routerFiles() (web/tests/router-routes.mjs) nicht liest. " +
      "Keiner der Fälle hier prüft sie — weder requireAdmin noch GET_ROUTES_WITH_EFFECT. " +
      "Die Datei gehört in routerFiles()."
  );
});

test("jede schreibende Route trägt requireAdmin als erste Zwischenschicht", () => {
  const writing = routes().filter((route) => route.method !== "get");

  // Der Wächter darf nicht dadurch grün werden, dass es nichts zu prüfen gibt.
  assert.ok(
    writing.length > 0,
    "Der Router meldet keine einzige schreibende Route an — dieser Wächter liefe ins Leere. " +
      "Ist die API wieder vollständig lesend, gehört an seine Stelle die frühere Zusage."
  );

  const unguarded = writing
    .filter((route) => !SESSION_ONLY_WRITE.has(route.path))
    .filter((route) => !route.firstArgument.startsWith("requireAdmin("))
    .map((route) => `${route.file}: ${route.method.toUpperCase()} ${route.path}`);

  assert.deepEqual(
    unguarded,
    [],
    "Schreibende Routen ohne requireAdmin unmittelbar hinter dem Pfad (#17, §4):\n" + unguarded.join("\n")
  );

  // Die Ausnahme tauscht `requireAdmin` gegen `withSession` — sie tauscht es
  // nicht gegen nichts. Ohne diesen zweiten Teil wäre die Liste oben die Tür,
  // die dieser Wächter gerade verhindert.
  const unauthenticated = writing
    .filter((route) => SESSION_ONLY_WRITE.has(route.path))
    .filter((route) => !route.firstArgument.startsWith("withSession("))
    .map((route) => `${route.file}: ${route.method.toUpperCase()} ${route.path} — ${SESSION_ONLY_WRITE.get(route.path)}`);

  assert.deepEqual(
    unauthenticated,
    [],
    "Schreibende Routen aus SESSION_ONLY_WRITE ohne withSession unmittelbar hinter dem Pfad (#70):\n" +
      unauthenticated.join("\n")
  );
});

test("jede Ausnahme in SESSION_ONLY_WRITE hat eine schreibende Route", () => {
  // Wie der Fall für GET_ROUTES_WITH_EFFECT: eine Ausnahme, deren Route längst
  // weg
  // ist, bliebe sonst stehen — und der nächste Pfad, der zufällig so heißt,
  // erbte sie.
  const writing = routes().filter((route) => route.method !== "get");

  for (const [path, reason] of SESSION_ONLY_WRITE) {
    const route = writing.find((candidate) => candidate.path === path);
    assert.ok(
      route,
      `Es gibt keine schreibende Route ${path} mehr — dann gehört sie auch hier heraus (${reason})`
    );
  }
});

test("die GET-Routen mit Wirkung tragen ihre Zwischenschicht ebenso", () => {
  const reading = routes().filter((route) => route.method === "get");

  // Eine Ausnahme, deren Pfad gar nicht (mehr) als GET mit Wirkung geführt
  // wird, bliebe sonst stehen — und der nächste Pfad, der zufällig so heißt,
  // erbte sie. Dieselbe Eigenschaft wie beim Fall für SESSION_ONLY_WRITE.
  for (const [path, reason] of SESSION_ONLY_GET_WITH_EFFECT) {
    assert.ok(
      GET_ROUTES_WITH_EFFECT.includes(path),
      `GET ${path} steht nicht in GET_ROUTES_WITH_EFFECT (server/src/platform/http/request-origin.ts) — ` +
        `dann gehört die Ausnahme auch hier heraus (${reason})`
    );
  }

  // Der Wächter darf nicht dadurch grün werden, dass die Liste leer ist. Eine
  // geleerte `GET_ROUTES_WITH_EFFECT` machte diesen Fall stumm UND öffnete
  // zugleich die Herkunftsprüfung für genau diese Routen.
  assert.ok(
    GET_ROUTES_WITH_EFFECT.length > 0,
    "server/src/platform/http/request-origin.ts führt keinen einzigen GET mit Wirkung mehr — " +
      "dann liefe dieser Fall ins Leere, und die Herkunftsprüfung ließe diese Routen durch."
  );

  for (const path of GET_ROUTES_WITH_EFFECT) {
    const route = reading.find((candidate) => candidate.path === path);
    // ⚠️ Diese Eigenschaft bleibt: ein Eintrag, dessen Route es nicht mehr
    // gibt, wird rot. Sonst bliebe eine Ausnahme stehen, die niemand mehr
    // liest, und der nächste Pfad, der zufällig so heißt, erbte sie.
    assert.ok(
      route,
      `Die Route GET ${path} gibt es nicht mehr — dann gehört sie auch aus ` +
        "GET_ROUTES_WITH_EFFECT in server/src/platform/http/request-origin.ts heraus " +
        "(der Grund dafür steht dort neben dem Eintrag)"
    );
    // Die Ausnahme tauscht `requireAdmin` gegen `withSession` — sie tauscht es
    // nicht gegen nichts.
    const reason = SESSION_ONLY_GET_WITH_EFFECT.get(path);
    if (reason !== undefined) {
      assert.ok(
        route.firstArgument.startsWith("withSession("),
        `${route.file}: GET ${path} steht in SESSION_ONLY_GET_WITH_EFFECT und trotzdem nicht hinter ` +
          `withSession — ${reason}`
      );
      continue;
    }
    assert.ok(
      route.firstArgument.startsWith("requireAdmin("),
      `${route.file}: GET ${path} steht nicht hinter requireAdmin — der Grund, warum dieser GET ` +
        "trotz GET etwas bewirkt, steht neben seinem Eintrag in server/src/platform/http/request-origin.ts"
    );
  }
});

// ── Die Ausnahme schreibt am EIGENEN Konto ──────────────────────────────────
//
// FÄNGT: eine Route aus `SESSION_ONLY_WRITE`, die das Konto, an dem sie
// schreibt, aus dem RUMPF DER ANFRAGE nimmt statt aus der Sitzung.
//
// WARUM DAS DIE EINE EIGENSCHAFT IST, die hier zählt: die Zusage der Liste
// oben lautet wörtlich „sie ändert etwas am EIGENEN Konto und an nichts
// sonst". Genau daran hängt, dass diese Routen ohne `requireAdmin` auskommen
// dürfen. Eine Kennung aus dem Rumpf ist das Gegenteil dieser Zusage: aus
// `PUT /session/language` würde damit der Weg, über den ein beliebiger
// angemeldeter Benutzer die Oberfläche eines ANDEREN umstellt — und
// `withSession` sagte weiterhin ja, denn angemeldet ist er ja.
//
// WARUM SIE SONST NIEMAND FÄNGT: gemessen läuft die ganze Kette grün durch,
// wenn man in `server/src/app/router.ts` das `user.id` durch eine `userId` aus
// dem Rumpf ersetzt — `lint 0`, `test` auf der Grundlinie, `build 0`. Unter
// `server/src/api/` (heute `server/src/app/`) gab es damals keine einzige Testdatei; der Kommentar drei Zeilen
// über der Route nennt genau diesen Fall als Grund der Regel, und ein
// Kommentar hält nichts.
//
// ⚠️ WAS DAS HIER IST, ehrlich gesagt: dieser Wächter hält wie seine
// Geschwister in dieser Datei DIE GEWOHNHEIT, NICHT DIE ABSICHT. Er liest den
// TEXT des Routers und keinen Syntaxbaum — wer die Kennung über einen
// Zwischenschritt aus dem Rumpf holt (`const who = pick(body); …
// writeUserLanguage(pool, who, …)`), kommt an ihm vorbei. Das eigentliche
// Mittel wäre ein AUSFÜHRUNGSTEST des Routers, der die Route mit einer fremden
// Kennung im Rumpf aufruft und einen 400 oder ein unverändertes fremdes Konto
// erwartet. Den gibt es noch nicht: er bräuchte Attrappen für `better-auth`
// und den Verbindungspool und ist ein eigenes Paket. Bis dahin ist diese
// Zusicherung die Sperrklinke gegen den Normalfall — nicht der Beweis.

// Die Namen, die ein Handler AUS DEM RUMPF DER ANFRAGE zieht: aus einer
// Zerlegung (`const { language } = body as Record<string, unknown>;`) und aus
// einem direkten Zugriff (`(body as Record<string, unknown>).userId`).
//
// Bei einer Zerlegung zählt der Name LINKS vom Doppelpunkt — `{ id: who }`
// zieht `id` aus dem Rumpf, wie auch immer die Variable danach heißt.
const BODY_DESTRUCTURING = /\{([^{}]*)\}\s*=\s*(?:\(\s*)?(?:request\.)?body\b/g;
const BODY_MEMBER = /\bbody\b(?:\s+as\b[^;\n]*?)?\)?\s*\.\s*([A-Za-z_$][\w$]*)/g;

function bodyKeys(text) {
  const names = new Set();
  for (const match of text.matchAll(BODY_DESTRUCTURING)) {
    for (const part of match[1].split(",")) {
      const name = /^\s*([A-Za-z_$][\w$]*)/.exec(part);
      if (name !== null) names.add(name[1]);
    }
  }
  for (const match of text.matchAll(BODY_MEMBER)) names.add(match[1]);
  return [...names];
}

// Was als KENNUNG gilt. Eine Route, die etwas am eigenen Konto ändert, hat
// keinen Grund, irgendeine Kennung aus dem Rumpf zu ziehen — deshalb ist die
// Form hier breit gefasst und nicht auf `userId` verengt: `user_id`, `id`,
// `sub`, `accountId` und `ownerId` sind dieselbe Tür mit einem anderen Schild.
const IDENTIFIER_SHAPED = /^(?:id|ids|sub|subject)$|[a-z0-9](?:Id|ID|Ids|IDs)$|_ids?$|[Uu]ser|[Aa]ccount|[Oo]wner|[Pp]rincipal/;

test("jede Route aus SESSION_ONLY_WRITE schreibt am eigenen Konto und an keinem anderen", () => {
  const writing = routes().filter((route) => route.method !== "get");
  const findings = [];

  for (const [path, reason] of SESSION_ONLY_WRITE) {
    const route = writing.find((candidate) => candidate.path === path);
    // Dass es die Route überhaupt gibt, meldet der Fall darüber; hier nur
    // nicht mit einem Node-Stapel abstürzen.
    if (route === undefined) continue;

    // Kein grünes Ergebnis aus einem blinden Leser: kann der Abgrenzer den
    // Rumpf dieser Route nicht bestimmen, prüft dieser Fall NICHTS.
    assert.ok(
      route.body !== null && route.body.trim() !== "",
      `${route.file}: ${route.method.toUpperCase()} ${path}: der Wächter kann den Rumpf dieser Route ` +
        "nicht abgrenzen — die Klammern hinter `router." + route.method + "(` gehen für ihn nicht auf. " +
        "Er prüft sie damit NICHT; das ist ein Befund am Wächter oder an der Form der Datei."
    );

    if (!/\buser\.id\b/.test(route.body)) {
      findings.push(
        `${route.file}: ${route.method.toUpperCase()} ${path}: der Handler nennt „user.id" nicht — ` +
          `${reason}. Das Konto, an dem geschrieben wird, ist das der SITZUNG und kommt von ` +
          "`withSession`; kommt es von woanders her, ist diese Route der Weg, über den ein Benutzer " +
          "die Oberfläche eines anderen umstellt."
      );
    }

    for (const name of bodyKeys(route.body)) {
      if (!IDENTIFIER_SHAPED.test(name)) continue;
      findings.push(
        `${route.file}: ${route.method.toUpperCase()} ${path}: der Handler zieht „${name}" aus dem ` +
          `Rumpf der Anfrage — ${reason}. Eine Kennung aus dem Rumpf ist genau das Gegenteil dieser ` +
          "Zusage."
      );
    }
  }

  assert.deepEqual(
    findings,
    [],
    "Eine Route aus SESSION_ONLY_WRITE schreibt nicht erkennbar am eigenen Konto (#70). Sie steht " +
      "ohne `requireAdmin` da, und die Zusage, die das trägt, ist genau diese:\n" + findings.join("\n")
  );
});

test("der Abgrenzer und der Rumpfleser selbst: was sie sehen müssen und was nicht", () => {
  // Ein Wächter ohne eigenen Test ist eine Behauptung — und diese beiden Leser
  // sind die riskanten: der eine zählt Klammern, der andere rät aus Namen.
  const findings = [];
  const check = (description, actual, expected) => {
    try {
      assert.deepEqual(actual, expected);
    } catch {
      findings.push(`${description}: bekam ${JSON.stringify(actual)}, erwartet ${JSON.stringify(expected)}`);
    }
  };

  const cut = (text) => routeBody(text, text.indexOf("("));

  check("die Route endet an ihrer eigenen Klammer", cut('router.put("/a", h(x));\nrouter.put("/b", g());'), '"/a", h(x)');
  check("eine Klammer in einer Zeichenkette zählt nicht", cut('router.put("/a (§4)", h);'), '"/a (§4)", h');
  check("eine Klammer in einem Kommentar zählt nicht", cut('router.put("/a", /* ) */ h);'), '"/a", /* ) */ h');
  check("eine Klammer in einem Zeilenkommentar zählt nicht", cut('router.put("/a", // )\n h);'), '"/a", // )\n h');
  check("eine offene Klammer ergibt keinen Rumpf", cut('router.put("/a", h;'), null);

  check("die Zerlegung aus dem Rumpf", bodyKeys("const { language } = body as Record<string, unknown>;"), ["language"]);
  check(
    "der Name LINKS vom Doppelpunkt zählt",
    bodyKeys("const { id: who } = body as Record<string, unknown>;"),
    ["id"]
  );
  check("der direkte Zugriff", bodyKeys("(body as Record<string, unknown>).userId"), ["userId"]);
  check("ein anderer Rumpf zählt nicht", bodyKeys("const { language } = other;"), []);

  check('„language" ist keine Kennung', IDENTIFIER_SHAPED.test("language"), false);
  check('„userId" ist eine', IDENTIFIER_SHAPED.test("userId"), true);
  check('„user_id" ist eine', IDENTIFIER_SHAPED.test("user_id"), true);
  check('„id" ist eine', IDENTIFIER_SHAPED.test("id"), true);
  check('„accountId" ist eine', IDENTIFIER_SHAPED.test("accountId"), true);

  assert.deepEqual(findings, [], `Ein Leser dieses Wächters liest anders als zugesagt:\n${findings.join("\n")}`);
});

// The expected import line for `requireAdmin`, depending on the depth of the
// file under `server/src/`: `app/router.ts` imports from `../platform/auth/…`,
// a file under `api/routes/` or `features/<name>/` from
// `../../platform/auth/…`; one level deeper in the tree means one more `../`
// back to `platform/`.
function requireAdminImportLine(file) {
  const rest = file.slice("server/src/".length);
  const depth = rest.split("/").length - 1; // "app/router.ts" → 1, "features/logs/routes.ts" → 2
  const up = "../".repeat(depth);
  return `import { requireAdmin } from "${up}platform/auth/require-admin.js";`;
}

test("requireAdmin kommt aus der einen Zwischenschicht und nicht aus einer Kopie", () => {
  // Eine zweite, „schnell selbst gebaute" Prüfung wäre der Fehler, den dieser
  // Wächter gerade verhindern soll: sie sähe im Diff genauso aus.
  //
  // Seit der Aufteilung (#5) steht `requireAdmin` nicht mehr zwingend in
  // EINER Datei — jede Datei, die eine requireAdmin-pflichtige Route anmeldet
  // (schreibend und nicht in SESSION_ONLY_WRITE, oder ein GET mit Wirkung aus
  // GET_ROUTES_WITH_EFFECT und nicht in SESSION_ONLY_GET_WITH_EFFECT), muss
  // den einen Importsatz tragen, mit dem
  // Pfad, der zu ihrer eigenen Tiefe im Baum passt.
  const files = routerFiles();
  const allRoutes = readAllRoutes(files);

  const needsRequireAdmin = new Set();
  for (const route of allRoutes) {
    if (route.method === "get") {
      // Wie bei den schreibenden Routen: die Ausnahme aus
      // SESSION_ONLY_GET_WITH_EFFECT verlangt kein `requireAdmin` und braucht
      // seinen Importsatz deshalb auch nicht. Dass sie stattdessen
      // `withSession(` trägt, hält der Fall darüber nach.
      if (GET_ROUTES_WITH_EFFECT.includes(route.path) && !SESSION_ONLY_GET_WITH_EFFECT.has(route.path)) {
        needsRequireAdmin.add(route.file);
      }
      continue;
    }
    if (!SESSION_ONLY_WRITE.has(route.path)) needsRequireAdmin.add(route.file);
  }

  const missing = [];
  for (const file of needsRequireAdmin) {
    const entry = files.find((candidate) => candidate.file === file);
    const expected = requireAdminImportLine(file);
    if (!entry.content.includes(expected)) {
      missing.push(`${file}: erwartet den Importsatz \`${expected}\``);
    }
  }

  assert.deepEqual(
    missing,
    [],
    "Eine Datei meldet eine requireAdmin-pflichtige Route an, importiert requireAdmin aber nicht " +
      "auf dem einen vorgesehenen Weg:\n" + missing.join("\n")
  );
});


// ── Die Stellung der Herkunftsprüfung ───────────────────────────────────────
//
// FÄNGT: `router.use(requireTrustedOrigin)` in `server/src/app/router.ts`,
// verschoben HINTER einen `register…Routes(`-Aufruf.
//
// WARUM DAS DIE EINE EIGENSCHAFT IST: Express hängt Zwischenschichten in der
// Reihenfolge ihrer Anmeldung. Eine als `use` NACH einer Route angemeldete
// Schicht läuft für diese Route nicht mehr — sie steht dann nicht mehr vor dem
// GANZEN Router, sondern nur noch vor seiner zweiten Hälfte. Wer die eine
// Zeile um eine einzige Position nach unten schiebt, öffnet die Routen aus
// `features/account/routes.ts` und darunter `PUT /session/language`: die einzige
// schreibende Route dieses Routers ohne `requireAdmin` (`SESSION_ONLY_WRITE`
// oben), also gerade die, die auch der andere Wächter dieser Datei
// durchwinkt.
//
// WARUM SIE SONST NIEMAND FÄNGT — gemessen am 2026-09-07 (Etappe B4a-E, #5),
// zweimal unabhängig voneinander: mit genau dieser Verschiebung blieb die
// volle Kette VOLLSTÄNDIG grün — `lint 0`, Server
// `# tests 530 / # pass 528 / # fail 2`, Web `# tests 187 / # pass 187 /
// # fail 0`, Zeichen für Zeichen wie ohne sie. Der Grund lag nicht an der
// Bauart der Fälle, sondern an ihrer Auswahl: jeder Ablehnungsfall in
// `server/src/app/request-origin-routing.test.ts` fuhr damals auf `/hosts…`,
// und die Host-Routen werden als DRITTE angemeldet — sie stehen auch nach der
// Verschiebung noch hinter der Schranke.
//
// ⚠️ DIESER WÄCHTER IST DIE ZWEITE HÄLFTE, NICHT DIE ERSTE. Der eigentliche
// Nachweis ist seit derselben Etappe ein VERHALTENSFALL: „PUT
// /session/language mit cross-site ist 403, und geschrieben wurde nicht" in
// `server/src/app/request-origin-routing.test.ts` fährt eine echte Anfrage
// durch den echten `createApiRouter` und greift unabhängig davon, wie jemand
// diese Datei formatiert. Der Textwächter hier steht daneben, weil er die
// Absicht BENENNT: er sagt beim Verschieben sofort, warum die Zeile oben
// steht, statt den nächsten Leser mit einer unerwarteten 403 an einer
// Sprachroute allein zu lassen.
//
// ⚠️ Er liest den KOMMENTARFREIEN Text. Ohne das genügte die blosse ERWÄHNUNG
// der Anmeldung in einem Kommentar, und der Kopf von `router.ts` schreibt über
// genau diese Zwischenschicht mehrere Absätze Prosa. (Gemessen am 2026-09-05
// an einem Geschwisterwächter dieses Repos: dort zählte die Erwähnung mit.)
// Beide Muster lassen zwischen allen Bestandteilen beliebigen Leerraum zu,
// also auch einen Zeilenumbruch und eine andere Einrückung.

// Die Anmeldung selbst. Router-weit und ohne Pfad — eine auf einen Pfad
// gemountete Fassung wäre eine ANDERE Zusage („vor dieser Fläche") als die aus
// §1 („vor dem ganzen Router") und soll hier auffallen.
const TRUSTED_ORIGIN_USE = /\brouter\s*\.\s*use\s*\(\s*requireTrustedOrigin\s*\)/;

// Ein AUFRUF einer Registrierfunktion. Die öffnende Klammer unmittelbar hinter
// dem Namen trennt ihn vom Importsatz, der oben in derselben Datei steht: dort
// folgt auf den Namen ein `}`.
const REGISTER_CALL = /\bregister[A-Za-z]*Routes\s*\(/;

// Since #249 the groups are registered by a loop over the feature list
// (`server/src/app/features.ts`), and `router.ts` calls no `register…Routes(`
// itself: the loop is the first group. `of FEATURES` keeps out the import
// line, which names `FEATURES` as well.
const FEATURE_LOOP = /\bof\s+FEATURES\b/;

// The position of the first route group, a direct call or the loop,
// whichever comes first; -1 if neither is there.
function firstGroupIn(text) {
  const positions = [text.search(REGISTER_CALL), text.search(FEATURE_LOOP)].filter((position) => position >= 0);
  return positions.length === 0 ? -1 : Math.min(...positions);
}

const ROUTER_FILE = "server/src/app/router.ts";

function routerSource() {
  const entry = routerFiles().find((candidate) => candidate.file === ROUTER_FILE);
  assert.ok(entry, `${ROUTER_FILE} liegt nicht mehr dort, wo routerFiles() sie sucht.`);
  return stripComments(entry.content);
}

test("die Herkunftsprüfung hängt VOR der ersten Routengruppe", () => {
  const text = routerSource();
  const guard = text.search(TRUSTED_ORIGIN_USE);
  const firstGroup = firstGroupIn(text);

  // Kein grünes Ergebnis aus einem blinden Leser: findet dieser Fall eine der
  // beiden Stellen nicht, prüft er NICHTS.
  assert.ok(
    guard >= 0,
    `In ${ROUTER_FILE} steht kein \`router.use(requireTrustedOrigin)\` mehr. Dann hängt die ` +
      "Herkunftsprüfung an keiner Stelle vor dem Router, und jede schreibende Route dieses Routers " +
      "ist von einer fremden Seite aus auslösbar (docs/design/phase-5-write-access.md §1)."
  );
  assert.ok(
    firstGroup >= 0,
    `In ${ROUTER_FILE} wird keine Routengruppe mehr aufgerufen (\`register…Routes(\` oder ` +
      "`for (… of FEATURES)`) — dieser Fall " +
      "prüft damit nichts. Das ist ein Befund an ihm oder an der Form der Datei, nicht ein grünes " +
      "Ergebnis."
  );

  assert.ok(
    guard < firstGroup,
    `In ${ROUTER_FILE} steht \`router.use(requireTrustedOrigin)\` HINTER dem ersten Aufruf einer ` +
      "Routengruppe. Express hängt Zwischenschichten in der Reihenfolge ihrer Anmeldung: eine als " +
      "`use` NACH einer Route angemeldete Schicht läuft für diese Route nicht mehr. Offen steht damit " +
      "alles, was vor dieser Zeile angemeldet wird — bei der heutigen Reihenfolge zuerst " +
      "`registerSessionRoutes` (erster Eintrag in `server/src/app/features.ts`) und darin " +
      "`PUT /session/language`, die einzige schreibende Route dieses Routers ohne `requireAdmin`. " +
      "Die Zeile gehört vor die Schleife über `FEATURES` und vor JEDEN `register…Routes(`-Aufruf."
  );
});

test("der Stellungswächter selbst: was seine Muster sehen müssen und was nicht", () => {
  // Ein Wächter ohne eigenen Test ist eine Behauptung — und diese zwei Muster
  // sind die riskante Hälfte: sie sollen eine Umformatierung überleben und
  // trotzdem nicht auf eine blosse Erwähnung hereinfallen.
  const findings = [];
  const check = (description, actual, expected) => {
    if (actual !== expected) findings.push(`${description}: bekam ${String(actual)}, erwartet ${String(expected)}`);
  };

  check("die Zeile, wie sie dasteht", TRUSTED_ORIGIN_USE.test("router.use(requireTrustedOrigin);"), true);
  check("mit Leerraum dazwischen", TRUSTED_ORIGIN_USE.test("router . use( requireTrustedOrigin );"), true);
  check(
    "über zwei Zeilen umgebrochen und anders eingerückt",
    TRUSTED_ORIGIN_USE.test("  router.use(\n      requireTrustedOrigin\n  );"),
    true
  );
  check("eine andere Zwischenschicht zählt nicht", TRUSTED_ORIGIN_USE.test("router.use(express.json());"), false);
  check(
    "das 404-Sammelbecken zählt nicht",
    TRUSTED_ORIGIN_USE.test("router.use((_request, response) => { response.status(404); });"),
    false
  );
  check(
    "der blosse Import zählt nicht",
    TRUSTED_ORIGIN_USE.test('import { requireTrustedOrigin } from "./request-origin-guard.js";'),
    false
  );

  check("der Aufruf einer Gruppe", REGISTER_CALL.test("registerSessionRoutes(router, { auth, pool });"), true);
  check("mit Leerraum vor der Klammer", REGISTER_CALL.test("registerHostRoutes (router, {"), true);
  check(
    "der Importsatz derselben Funktion zählt nicht",
    REGISTER_CALL.test('import { registerHostRoutes } from "./routes/host-routes.js";'),
    false
  );
  check("eine andere Funktion zählt nicht", REGISTER_CALL.test("registerSomethingElse(router);"), false);

  check(
    "die Schleife über die Feature-Liste",
    FEATURE_LOOP.test("for (const registerFeature of FEATURES) registerFeature(router, options);"),
    true
  );
  check("der Importsatz der Feature-Liste zählt nicht", FEATURE_LOOP.test('import { FEATURES } from "../features.js";'), false);
  const loopAfterGuard = stripComments(
    'import { FEATURES } from "../features.js";\n' +
      "  router.use(requireTrustedOrigin);\n" +
      "  for (const registerFeature of FEATURES) registerFeature(router, options);\n"
  );
  check(
    "die Schleife hinter der Schranke ist richtig, auch mit dem Import davor",
    loopAfterGuard.search(TRUSTED_ORIGIN_USE) < firstGroupIn(loopAfterGuard),
    true
  );
  const loopBeforeGuard = stripComments(
    "  for (const registerFeature of FEATURES) registerFeature(router, options);\n" +
      "  router.use(requireTrustedOrigin);\n"
  );
  check(
    "die Schleife vor der Schranke ist falsch",
    loopBeforeGuard.search(TRUSTED_ORIGIN_USE) < firstGroupIn(loopBeforeGuard),
    false
  );

  // ⚠️ Der Fall, an dem sich entscheidet, ob dieser Wächter etwas taugt: die
  // Zeile steht in einem Kommentar OBEN und im Code UNTEN. Ohne den
  // Kommentar-Entferner läse die Prüfung die Erwähnung als Anmeldung, fände
  // sie vor der ersten Gruppe und wäre grün — bei offener Sprachroute.
  const moved = stripComments(
    "  // ⚠️ Die Herkunftsprüfung: router.use(requireTrustedOrigin);\n" +
      "  registerSessionRoutes(router, { auth, pool });\n" +
      "  router.use(requireTrustedOrigin);\n"
  );
  check(
    "eine Erwähnung im Kommentar rettet die verschobene Zeile nicht",
    moved.search(TRUSTED_ORIGIN_USE) < moved.search(REGISTER_CALL),
    false
  );

  const inOrder = stripComments(
    "  router.use(requireTrustedOrigin);\n  registerSessionRoutes(router, { auth, pool });\n"
  );
  check(
    "die richtige Reihenfolge wird auch als richtig gelesen",
    inOrder.search(TRUSTED_ORIGIN_USE) < inOrder.search(REGISTER_CALL),
    true
  );

  assert.deepEqual(findings, [], `Ein Muster dieses Wächters liest anders als zugesagt:\n${findings.join("\n")}`);
});
