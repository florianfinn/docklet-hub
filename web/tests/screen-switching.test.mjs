import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stripComments } from "./strip-comments.mjs";

// Wächter über die Routentabelle (D5, #62; auf Routen umgestellt in D6b, #62).
//
// ⚠️ WAS OHNE IHN PASSIERT, IST GEMESSEN UND KEIN GEDANKENSPIEL: bis D5 hielt
// die Schale den aktiven Eintrag selbst und schrieb ihn in die Brotkrume,
// während der Inhalt als `children` von außen kam und immer derselbe war. Mit
// GENAU EINEM Eintrag fiel das nicht auf — der eine Eintrag zeigte auf den
// einen Bildschirm, und beides stimmte zufällig überein. Der zweite Eintrag
// hätte die Überschrift gewechselt und sonst nichts. Lint, Bau und jeder
// andere Test blieben dabei grün: ein Eintrag ohne Fläche ist kein Typfehler,
// sondern ein Klick, der nichts tut. Mit Routen ist derselbe Fehler eine
// Adresse, unter der die Schale leer dasteht.
//
// Der andere Wächter (`web/tests/shell-navigation.test.mjs`, Zusicherung 1)
// prüft die andere Hälfte: dass der Eintrag ein Feld `screen` UND ein Feld
// `path` trägt und die Datei zu `screen` es wirklich gibt.
//
// GEPRÜFT WIRD, vier Zusicherungen:
//   1. jeder Navigationseintrag hat eine Route — seine `id` steht als
//      Schlüssel in der Zuordnung `screens` in `web/src/app/routes/AppRoutes.tsx`,
//      und sein Pfad ist lesbar. Fehlt eines von beidem, zeigt der Eintrag ins
//      Leere,
//   2. jede Route zeigt auf eine Datei unter `web/src/app/screens/` — die Routen
//      aus der Navigation über deren Feld `screen`, die Routen OHNE
//      Navigationseintrag über ihr eigenes Feld `screen`,
//   3. kein Pfad zweimal — zwei Routen auf demselben Pfad sind ein Streit, den
//      die Reihenfolge im Quelltext entscheidet, und das ist keine Antwort,
//   4. der Startpfad der Anwendung („/") hat eine Route. Er ist die Adresse,
//      unter der der Browser ankommt; fehlte sie, stünde nach dem Anmelden
//      eine leere Fläche.
//
// ⚠️ NICHT MEHR GEPRÜFT und mit Absicht: „jede Fläche hat einen
// Navigationseintrag". Diese Umkehrung stand hier bis D6b und war richtig,
// solange jede Fläche über die Navigation erreicht wurde. Mit Routen ist sie
// falsch: die Stack-Seite ist eine Detailfläche, auf die eine Liste verweist,
// und „Mein Konto" und „Einstellungen" hängen am Profil-Knopf unten links.
// Keine davon gehört in die Navigation. An die Stelle der Umkehrung tritt
// Zusicherung 2 — sie fängt denselben Fehler (eine Route, unter der nichts
// steht), ohne die Detailflächen zu verbieten.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const ROUTES_PATH = "web/src/app/routes/AppRoutes.tsx";
const NAVIGATION_PATH = "web/src/app/shell/navigation.ts";
const SCREENS_DIRECTORY = "web/src/app/screens";

// Der Pfad, unter dem der Browser ankommt. Er steht hier als Zeichenkette und
// wird NICHT aus dem Quelltext gelesen: er ist eine Tatsache der Auslieferung
// (die Wurzel des Hubs), keine Wahl des Codes. Läse der Wächter ihn aus
// derselben Datei, die er prüft, bestätigte er nur sich selbst.
const START_PATH = "/";

// Die Anker in AppRoutes.tsx. Als Konstanten, weil sie in der Prüfung UND in
// der Meldung dieselben sein müssen: wird eine Tabelle umbenannt, soll die
// Meldung den Namen nennen, nach dem gesucht wurde.
const SCREEN_MAP_DECLARATION = /const\s+screens\s*:\s*Record<[^>]*>\s*=\s*\{/;
const STANDALONE_ROUTES_DECLARATION = /const\s+standaloneRoutes\s*:\s*StandaloneRoute\[\]\s*=\s*\[/;

// Die Liste der Navigationseinträge, ebenfalls über ihren Namen.
const NAVIGATION_LIST_DECLARATION = /navigationItems\s*:\s*NavigationItem\[\]\s*=\s*\[/;

function readOrFail(path) {
  const absolute = new URL(path, `file://${ROOT}`);
  assert.ok(existsSync(absolute), `${path} fehlt`);
  return readFileSync(absolute, "utf8");
}

// Der Text zwischen einer öffnenden Klammer und ihrer PASSENDEN schließenden.
//
// ⚠️ Ein `/\{([^}]*)\}/` täte es hier nicht: die Werte der Zuordnung sind
// JSX-Ausdrücke, und `<HostsScreen role={user.role} />` trägt selbst
// geschweifte Klammern. Das erste `}` beendet also nicht das Literal. Aus
// demselben Grund ist die Klammerart ein Parameter — die Routen ohne Eintrag
// und die Navigationsliste stehen in einer eckigen.
function balancedBlock(source, openIndex, open = "{", close = "}") {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === open) depth += 1;
    if (source[index] === close) {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  return null;
}

// Die Schlüssel der Zuordnung `screens` — nur die der OBERSTEN Ebene.
export function screenKeysInRoutes(source) {
  const content = stripComments(source);
  const match = SCREEN_MAP_DECLARATION.exec(content);
  if (match === null) return null;

  const block = balancedBlock(content, match.index + match[0].length - 1);
  if (block === null) return null;

  const keys = [];
  let depth = 0;
  for (const line of block.split("\n")) {
    // Ein Schlüssel steht auf Tiefe 0 des Literals. Die Zählung läuft VOR der
    // Prüfung über die Zeile hinweg mit, damit ein `role={user.role}` in einer
    // Zeile die nächste nicht verschiebt.
    const key = depth === 0 ? /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line) : null;
    if (key !== null) keys.push(key[1]);
    for (const character of line) {
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
    }
  }
  return keys;
}

// Die Objekte der obersten Ebene innerhalb eines Listentextes, quotenbewusst:
// eine geschweifte Klammer IN einer Zeichenkette eröffnet kein Objekt.
function topLevelObjects(listBody) {
  const found = [];
  let quote = null;
  let depth = 0;
  let start = -1;
  for (let index = 0; index < listBody.length; index += 1) {
    const character = listBody[index];
    if (quote !== null) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") quote = character;
    else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        found.push(listBody.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return found;
}

// Der Wert eines Feldes, wenn er eine schlichte Zeichenkette ist — sonst
// `null`. Ein Bezeichner oder ein zusammengesetzter Ausdruck lässt sich weder
// gegen eine Datei noch gegen einen zweiten Pfad halten; das ist ein Befund
// und kein stiller Durchlass.
function stringField(objectText, name) {
  const match = new RegExp(`(?:^|[{,]\\s*)${name}\\s*:\\s*(["'])([^"']*)\\1`).exec(objectText);
  return match === null ? null : match[2];
}

// Die Einträge aus `navigationItems`, je mit `id`, `path` und `screen`.
export function navigationEntriesInFile(source) {
  const content = stripComments(source);
  const match = NAVIGATION_LIST_DECLARATION.exec(content);
  if (match === null) return null;

  const list = balancedBlock(content, match.index + match[0].length - 1, "[", "]");
  if (list === null) return null;

  return topLevelObjects(list).map((objectText) => ({
    id: stringField(objectText, "id"),
    path: stringField(objectText, "path"),
    screen: stringField(objectText, "screen")
  }));
}

// Die Routen OHNE Navigationseintrag, je mit `path` und `screen`. Eine leere
// Liste ist ein gültiges Ergebnis — heute gibt es keine solche Route.
export function standaloneRoutesInFile(source) {
  const content = stripComments(source);
  const match = STANDALONE_ROUTES_DECLARATION.exec(content);
  if (match === null) return null;

  const list = balancedBlock(content, match.index + match[0].length - 1, "[", "]");
  if (list === null) return null;

  return topLevelObjects(list).map((objectText) => ({
    path: stringField(objectText, "path"),
    screen: stringField(objectText, "screen"),
    area: stringField(objectText, "area")
  }));
}

// Die Zuordnung Adresse→Bereich aus navigation.ts, als Paare.
//
// ⚠️ Sie steht in einer ZWEITEN Datei als die Routen selbst, und das ist kein
// Versehen: `AppShell.tsx` liest den Bereich, darf die Bildschirme aber nicht
// kennen (Begründung an `standaloneRoutesFor` in AppRoutes.tsx). Damit stehen
// dieselben zwei Pfade an zwei Stellen — und genau deshalb gibt es die
// Zusicherung unten. Ohne sie wäre `area` an der Route eine Angabe, die
// niemand liest und die lautlos von der wirksamen Zuordnung abweichen kann.
const MANAGEMENT_PATHS_DECLARATION = /const\s+managementPaths\s*:\s*Record<[^>]*>\s*=\s*\{/;

export function managementPathsInFile(source) {
  const content = stripComments(source);
  const match = MANAGEMENT_PATHS_DECLARATION.exec(content);
  if (match === null) return null;

  const block = balancedBlock(content, match.index + match[0].length - 1, "{", "}");
  if (block === null) return null;

  // Schlüssel und Wert sind beide Zeichenketten-Literale — ein Bezeichner als
  // Wert käme hier nicht durch, und das ist gewollt: der Wächter vergleicht
  // Werte und kann einen Bezeichner nicht auflösen.
  return [...block.matchAll(/"([^"\\]+)"\s*:\s*"([^"\\]+)"/g)].map((pair) => ({
    path: pair[1],
    area: pair[2]
  }));
}

// Beide Tabellen und die Navigationsliste, oder eine benannte Meldung. Steht
// in einer eigenen Funktion, weil alle vier Prüfungen unten damit anfangen —
// und weil ein Wächter, der nichts findet, keiner ist.
function readTables() {
  const entries = navigationEntriesInFile(readOrFail(NAVIGATION_PATH));
  assert.ok(
    entries !== null,
    `${NAVIGATION_PATH}: die Liste navigationItems ist nicht zu finden — umbenannt oder anders geschrieben?`
  );
  assert.ok(entries.length > 0, `${NAVIGATION_PATH}: navigationItems ist leer — der Wächter liefe ins Leere`);

  const routesSource = readOrFail(ROUTES_PATH);

  const keys = screenKeysInRoutes(routesSource);
  assert.ok(
    keys !== null,
    `${ROUTES_PATH}: die Zuordnung „const screens: Record<…> = { … }" ist nicht zu finden. Wer sie ` +
      "umbenennt, benennt auch diesen Wächter um — ein Wächter, der nichts findet, ist keiner"
  );
  assert.ok(keys.length > 0, `${ROUTES_PATH}: die Zuordnung ist leer — der Wächter liefe ins Leere`);

  const standalone = standaloneRoutesInFile(routesSource);
  assert.ok(
    standalone !== null,
    `${ROUTES_PATH}: die Liste „const standaloneRoutes: StandaloneRoute[] = [ … ]" ist nicht zu ` +
      "finden. Sie darf LEER sein — heute gibt es keine Route ohne Navigationseintrag —, aber sie " +
      "darf nicht verschwinden: sonst prüft niemand mehr die Routen, die morgen darin stehen"
  );

  return { entries, keys, standalone };
}

test("jeder Navigationseintrag hat eine Route", () => {
  const { entries, keys } = readTables();

  const findings = [];
  for (const entry of entries) {
    if (entry.id === null) {
      findings.push(`${NAVIGATION_PATH}: ein Eintrag ohne lesbares Feld „id"`);
      continue;
    }
    if (entry.path === null) {
      findings.push(
        `${NAVIGATION_PATH}: Eintrag „${entry.id}" trägt kein lesbares Feld „path" — ohne Pfad gibt ` +
          "es keine Adresse, unter der seine Fläche stünde"
      );
    }
    if (!keys.includes(entry.id)) {
      findings.push(
        `${ROUTES_PATH}: Eintrag „${entry.id}" steht in keiner Route — ein Klick darauf wechselt die ` +
          "Adresse, und darunter steht nichts"
      );
    }
  }

  assert.deepEqual(findings, [], `Navigationseintrag ohne Route:\n${findings.join("\n")}`);
});

test("jede Route zeigt auf eine Fläche unter web/src/app/screens", () => {
  const { entries, standalone } = readTables();

  // Die Routen aus der Navigation nehmen ihre Fläche vom Eintrag, die Routen
  // ohne Eintrag aus ihrem eigenen Feld. Beide landen in derselben Liste —
  // geprüft wird die ROUTE, nicht ihre Herkunft.
  const routes = [
    ...entries.map((entry) => ({ where: NAVIGATION_PATH, name: entry.id, screen: entry.screen })),
    ...standalone.map((route) => ({ where: ROUTES_PATH, name: route.path, screen: route.screen }))
  ];

  const findings = [];
  for (const route of routes) {
    if (route.screen === null) {
      findings.push(
        `${route.where}: Route „${route.name}" trägt kein lesbares Feld „screen" — welche Fläche ` +
          `unter ${SCREENS_DIRECTORY}/ sie zeigt, ist damit ungeprüft`
      );
      continue;
    }
    const relative = `${SCREENS_DIRECTORY}/${route.screen}.tsx`;
    if (!existsSync(new URL(relative, `file://${ROOT}`))) {
      findings.push(`${route.where}: Route „${route.name}" zeigt auf ${relative} — die Datei gibt es nicht`);
    }
  }

  assert.deepEqual(
    findings,
    [],
    `Route ohne Fläche. Eine Adresse, unter der nichts steht, fällt erst beim Aufruf auf:\n${findings.join("\n")}`
  );
});

test("kein Pfad zweimal", () => {
  const { entries, standalone } = readTables();

  const paths = [
    ...entries.filter((entry) => entry.path !== null).map((entry) => entry.path),
    ...standalone.filter((route) => route.path !== null).map((route) => route.path)
  ];

  const seen = new Set();
  const duplicates = [];
  for (const path of paths) {
    if (seen.has(path) && !duplicates.includes(path)) duplicates.push(path);
    seen.add(path);
  }

  assert.deepEqual(
    duplicates,
    [],
    `Derselbe Pfad steht an zwei Routen: ${duplicates.join(", ")}. Welche gewinnt, entscheidet dann ` +
      `die Reihenfolge im Quelltext — gelesen wurden ${NAVIGATION_PATH} und ${ROUTES_PATH}`
  );
});

test("der Bereich einer Route ohne Eintrag steht an beiden Stellen gleich", () => {
  const { standalone } = readTables();

  const declared = managementPathsInFile(readOrFail(NAVIGATION_PATH));
  assert.ok(
    declared !== null,
    `${NAVIGATION_PATH}: die Zuordnung „const managementPaths: Record<…> = { … }" ist nicht zu ` +
      "finden. Wer sie umbenennt, benennt auch diesen Wächter um — ein Wächter, der nichts " +
      "findet, ist keiner"
  );

  // Was die Routen selbst als Verwaltung ausweisen …
  const fromRoutes = standalone
    .filter((route) => route.area === "management" && route.path !== null)
    .map((route) => route.path)
    .sort();

  // … und was `areaForPath` tatsaechlich liest.
  const fromNavigation = declared
    .filter((pair) => pair.area === "management")
    .map((pair) => pair.path)
    .sort();

  assert.deepEqual(
    fromNavigation,
    fromRoutes,
    `Der Bereich einer Route steht an zwei Stellen und sie sind auseinandergelaufen: ` +
      `${ROUTES_PATH} weist ${JSON.stringify(fromRoutes)} als Verwaltung aus, ` +
      `${NAVIGATION_PATH} liest ${JSON.stringify(fromNavigation)}. Gefärbt wird nach der ` +
      "zweiten Liste — die erste wäre dann eine Angabe, die niemand liest und die lügt"
  );

  // Ein Pfad in `managementPaths`, den es als Route gar nicht gibt, ist ein
  // Rest einer Umbenennung: er färbt nie etwas und fällt niemandem auf.
  const knownPaths = new Set([
    ...standalone.filter((route) => route.path !== null).map((route) => route.path),
    ...(readTables().entries.filter((entry) => entry.path !== null).map((entry) => entry.path))
  ]);
  const orphans = declared.map((pair) => pair.path).filter((path) => !knownPaths.has(path));

  assert.deepEqual(
    orphans,
    [],
    `${NAVIGATION_PATH}: managementPaths nennt Adressen, unter denen keine Route steht: ` +
      `${orphans.join(", ")}`
  );
});

test("der Startpfad der Anwendung hat eine Route", () => {
  const { entries, standalone } = readTables();

  const paths = [...entries.map((entry) => entry.path), ...standalone.map((route) => route.path)];

  assert.ok(
    paths.includes(START_PATH),
    `Kein Eintrag und keine Route auf „${START_PATH}" — das ist die Adresse, unter der der Browser ` +
      `ankommt. Ohne sie fiele der Auffang in ${ROUTES_PATH} auf einen Pfad zurück, den es nicht ` +
      `gibt, und die Schale stünde nach dem Anmelden leer da. Gelesen: ${paths.join(", ")}`
  );
});

test("die Leser selbst: was sie lesen müssen und was nicht", () => {
  // Ein Wächter ohne eigenen Test ist eine Behauptung.
  const routes = [
    "function screensFor(user: SessionUser): Record<string, ReactNode> {",
    "  const screens: Record<string, ReactNode> = {",
    "    overview: <OverviewScreen />,",
    "    hosts: <HostsScreen role={user.role} />",
    "  };",
    "  return screens;",
    "}",
    "const standaloneRoutes: StandaloneRoute[] = [",
    '  { path: "/stack/:hostId/:project", screen: "StackScreen", element: <StackScreen /> }',
    "];"
  ].join("\n");

  assert.deepEqual(screenKeysInRoutes(routes), ["overview", "hosts"]);

  // Der Fall, an dem ein Muster mit `[^}]*` zerbricht: die geschweifte
  // Klammer im JSX-Attribut beendet das Literal NICHT.
  assert.ok(screenKeysInRoutes(routes).includes("hosts"));

  // Ein Schlüssel in einem verschachtelten Objekt ist keiner der obersten
  // Ebene und darf nicht mitgelesen werden.
  const nested = [
    "const screens: Record<string, ReactNode> = {",
    "  overview: <Screen options={{ inner: 1 }} />",
    "};"
  ].join("\n");
  assert.deepEqual(screenKeysInRoutes(nested), ["overview"]);

  // Ohne den Anker: `null`, damit die Prüfung oben rot wird, statt still
  // durchzulaufen.
  assert.equal(screenKeysInRoutes("const other = { overview: 1 };"), null);

  // ⚠️ Ein Pfad MIT Parameter muss durchgehen — er ist der Grund, aus dem es
  // die Liste ohne Navigationseintrag überhaupt gibt.
  // `area` fehlt in dieser Probe und ist deshalb `null` — der Leser erfindet
  // keinen Bereich, er meldet, dass keiner dasteht.
  assert.deepEqual(standaloneRoutesInFile(routes), [
    { path: "/stack/:hostId/:project", screen: "StackScreen", area: null }
  ]);

  // Der Leser der Bereichs-Zuordnung: Paare, sonst `null`.
  const management = [
    "const managementPaths: Record<string, AreaId> = {",
    '  "/account": "management",',
    '  "/settings": "management"',
    "};"
  ].join("\n");
  assert.deepEqual(managementPathsInFile(management), [
    { path: "/account", area: "management" },
    { path: "/settings", area: "management" }
  ]);
  assert.equal(managementPathsInFile("const other: Record<string, AreaId> = {};"), null);

  // Die leere Liste ist ein gültiges Ergebnis und ausdrücklich NICHT `null`:
  // heute gibt es keine Route ohne Eintrag, und das ist kein Befund.
  assert.deepEqual(standaloneRoutesInFile("const standaloneRoutes: StandaloneRoute[] = [];"), []);
  assert.equal(standaloneRoutesInFile("const other = [];"), null);

  const navigation = [
    "export const navigationItems: NavigationItem[] = [",
    '  { id: "overview", group: "operations", path: "/", screen: "OverviewScreen", labelKey: "navOverview", icon: LayoutGrid },',
    '  { id: "hosts", group: "operations", path: "/hosts", screen: "HostsScreen", labelKey: "navHosts", icon: Server }',
    "];",
    "export const defaultNavigationPath = navigationItems[0].path;"
  ].join("\n");

  assert.deepEqual(navigationEntriesInFile(navigation), [
    { id: "overview", path: "/", screen: "OverviewScreen" },
    { id: "hosts", path: "/hosts", screen: "HostsScreen" }
  ]);

  // ⚠️ Die Gegenprobe: gelesen werden GENAU diese drei Felder, und ein
  // fehlendes ergibt `null` und keinen geratenen Wert — sonst wäre ein Eintrag
  // ohne Pfad still grün.
  assert.deepEqual(navigationEntriesInFile('const navigationItems: NavigationItem[] = [{ id: "a" }];'), [
    { id: "a", path: null, screen: null }
  ]);
  assert.equal(navigationEntriesInFile("const other = [];"), null);

  // Die Zeile UNTER der Liste gehört nicht mehr dazu: `balancedBlock` endet an
  // der passenden Klammer und nicht am ersten `]` — `navigationItems[0].path`
  // steht darunter und darf keinen dritten Eintrag erfinden.
  assert.equal(navigationEntriesInFile(navigation).length, 2);
});
