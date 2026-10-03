import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stripComments, stripCssComments } from "./strip-comments.mjs";

// Wächter über die Herkunft der Farbe eines Arms (D7a, #62; Vertrag
// docs/design/hub-color-and-structure.md §1, §2 und §6).
//
// ⚠️ WAS DIESER WÄCHTER BIS D6b GEPRÜFT HAT UND WARUM ER NACHGEZOGEN IST.
// Bis D6b hielt er den TONVORRAT: die Liste `HOST_HUES` in
// `web/src/domain/hosts/host-palette.ts` gegen die Regeln in
// `web/src/platform/theme/palette.css`. Diese Liste gibt es nicht mehr — der Vorrat
// steht seit D7a genau einmal im Baum, in `contract/src/presets.ts`, und
// die Deckung zwischen ihm und den beiden Stylesheets prüft seither
// `web/tests/theme-presets.test.mjs`, vollständig und für jede Stellschraube.
// Diesen Teil hier noch einmal zu führen hieße, dieselbe Rechnung zweimal zu
// haben; er ist abgegeben und nicht verloren.
//
// GEBLIEBEN IST DIE FRAGE, DIE NUR HIER GESTELLT WIRD: woher der Wert kommt,
// der an der Karte landet. D7a ersetzt die gerechnete Farbe durch die
// gespeicherte. Das ist der Zweck des Pakets, und es ist genau die Art
// Änderung, die sich lautlos zurückdreht:
//
//   * Ein Rückfall „wenn nichts gespeichert ist, rechne wie früher" sieht auf
//     dem Schirm BESSER aus als das Richtige — die Liste ist bunt statt grau.
//     Er bringt die Doppelfarben zurück, die #75 beziffert hat (bei drei
//     Armen etwa 44 von 100 Läufen), und niemand meldet es, weil bunt nach
//     Fortschritt aussieht.
//   * Eine Karte, die `data-hue` aus irgendetwas anderem als der Ablage
//     setzt, ist gültiges HTML mit einem gültigen Wert. Kein Lint, kein Bau
//     und kein anderer Test dieses Repos sieht den Unterschied.
//
// GEPRÜFT WIRD:
//   1. `host-palette.ts` rechnet nichts mehr aus der Kennung und führt keine
//      eigene Tonliste — die Vorgabe kommt aus `presets.ts`,
//   2. jede Stelle, die `data-hue`/`data-ink` setzt, holt den Wert über
//      `hostDisplay(…)`, und der Name davor ist in derselben Datei aus
//      `hostDisplay(` entstanden,
//   3. die Vorgabe für einen Arm, dem noch niemand eine Farbe gegeben hat
//      (`DEFAULT_HOST_THEME` in `presets.ts`), hat in `palette.css` je eine
//      Regel — sonst stünde der Normalfall des ersten Tages ohne Regel da,
//   4. die Erkenner dieses Wächters selbst.
//
// NICHT geprüft: WELCHEN Ton ein bestimmter Arm trägt. Das entscheidet ab D7a
// der Betreiber im Editor, und was in der Ablage steht, weiß kein Dateitext.
//
// ⚠️ GELESEN WIRD ÜBER `readdirSync`, nicht über `git ls-files`: eine Datei,
// die noch nicht mit `git add` erfasst ist, wäre für `git ls-files`
// unsichtbar — und ein neu angelegter Bildschirm mit einer selbstgerechneten
// Farbe ist genau der Fall, der hier auffallen soll.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Where surfaces live: `app/` (routes, shell, composed screens in `app/screens/`)
// and `features/`, where the views moved one by one (#258 onwards, #270 for the
// composed screens). A surface keeps this guard when it moves.
// Parts with their own tone stay under `web/src/platform/ui/` and are not read here.
const SCREENS_ROOTS = ["web/src/app", "web/src/features"];
const SCREENS_LABEL = SCREENS_ROOTS.map((root) => `${root}/`).join(", ");
const HOST_PALETTE_PATH = "web/src/domain/hosts/host-palette.ts";
const PALETTE_PATH = "web/src/platform/theme/palette.css";
const PRESETS_PATH = "contract/src/presets.ts";

// Der Name, unter dem die Farbe eines Arms aus der Ablage geholt wird.
const ACCESSOR = "hostDisplay";

function readOrFail(path, hint) {
  const absolute = new URL(path, `file://${ROOT}`);
  assert.ok(existsSync(absolute), `Datei fehlt: ${path} — ${hint}`);
  return readFileSync(absolute, "utf8");
}

function collectSourceFiles(relativeDirectory, extensions) {
  const absolute = new URL(`${relativeDirectory}/`, `file://${ROOT}`);
  if (!existsSync(absolute)) return [];
  const found = [];
  const entries = readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const entry of entries) {
    const relative = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory() || statSync(new URL(relative, `file://${ROOT}`)).isDirectory()) {
      found.push(...collectSourceFiles(relative, extensions));
      continue;
    }
    if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(relative);
  }
  return found;
}

function lineOf(content, index) {
  return content.slice(0, index).split("\n").length;
}

// ---------------------------------------------------------------------------
// Die Erkenner
// ---------------------------------------------------------------------------

// Der Ausdruck hinter einem Attribut in JSX: `data-hue={…}`. Geliefert wird
// der Inhalt der geschweiften Klammern samt Fundstelle.
//
// ⚠️ Auch die Form OHNE Klammern (`data-hue="amber"`) wird gefunden. Sie ist
// gültiges JSX und wäre hier der schlimmste Fall — eine fest verdrahtete
// Farbe, die keine Ablage je ändert. Ein Muster, das nur `={` kennt, ginge
// daran vorbei.
export function attributeExpressions(source, attribute) {
  const pattern = new RegExp(`${attribute}\\s*=\\s*(?:\\{([^{}]*)\\}|("[^"]*"|'[^']*'))`, "g");
  return [...source.matchAll(pattern)].map((match) => ({
    value: (match[1] ?? match[2]).trim(),
    index: match.index
  }));
}

// Die Namen, die in dieser Datei aus `hostDisplay(…)` entstanden sind:
// `const display = hostDisplay(entry.host);`.
export function accessorBindings(source, accessor) {
  const pattern = new RegExp(`(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${accessor}\\s*\\(`, "g");
  return new Set([...source.matchAll(pattern)].map((match) => match[1]));
}

// Töne und ihre Zahlenwerte aus `palette.css`.
//
// ⚠️ Beide Schreibweisen: `[data-hue=violet]` ist so gültiges CSS wie
// `[data-hue="violet"]`. Ein Muster, das nur die Form mit Anführungszeichen
// kennt, übersieht die andere still.
export function hueRulesInCss(source) {
  const rules = new Map();
  const pattern = /\[data-hue=(?:"([^"]*)"|'([^']*)'|([^\]'"]+))\]\s*\{([^}]*)\}/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1] ?? match[2] ?? match[3];
    const hue = /--h:\s*([^;]+);/.exec(match[4]);
    rules.set(name, hue === null ? null : hue[1].trim());
  }
  return rules;
}

export function inkNamesInCss(source) {
  return new Set(
    [...source.matchAll(/\[data-ink=(?:"([^"]*)"|'([^']*)'|([^\]'"]+))\]/g)].map(
      (match) => match[1] ?? match[2] ?? match[3]
    )
  );
}

// Ein Feld aus `DEFAULT_HOST_THEME` in `presets.ts`.
//
// ⚠️ Gelesen wird der Dateitext und nicht das Modul: `node --test` läuft hier
// ohne Bauschritt, und ein Import einer .ts-Datei bräuchte tsx (AGENTS.md,
// Abschnitt Tests). Findet das Muster nichts, wird der Aufrufer ROT — ein
// geändertes Dateiformat darf diesen Wächter nicht still leer laufen lassen.
export function defaultHostTheme(source, field) {
  const block = /DEFAULT_HOST_THEME[^=]*=\s*\{([^}]*)\}/.exec(source);
  if (block === null) return null;
  const value = new RegExp(`${field}\\s*:\\s*["']([^"']+)["']`).exec(block[1]);
  return value === null ? null : value[1];
}

// ---------------------------------------------------------------------------
// 1. Aus der Ablage, nicht aus der Kennung
// ---------------------------------------------------------------------------
//
// FÄNGT: die Rückkehr der gerechneten Farbe — als Rückfall („solange nichts
// gespeichert ist"), als zweite Tonliste im Web, als Streuwert über die `id`.
//
// OHNE DIESE PRÜFUNG: der Rückfall ist die bequemste Änderung im ganzen Paket
// und die einzige, die den Bildschirm SCHÖNER macht. Er kompiliert, er ist
// grün, und er nimmt dem Betreiber genau die Aussage, für die D7a gebaut ist:
// dass die Farbe eines Arms seine ist und nicht die des Zufalls.
test("host-palette.ts liest die Farbe und rechnet sie nicht aus", () => {
  const source = stripComments(
    readOrFail(HOST_PALETTE_PATH, "die Stelle, an der die Farbe eines Arms herkommt")
  );

  const findings = [];

  // Ein Zugriff auf die Kennung wäre der Anfang jeder Rechnung.
  for (const match of source.matchAll(/(?<![\w$])hostId(?![\w$])|\.id(?![\w$])/g)) {
    findings.push(
      `${HOST_PALETTE_PATH}:${lineOf(source, match.index)}: „${match[0]}" — die Farbe hängt seit D7a ` +
        `an der Ablage und nicht mehr an der Kennung (#75: bei drei Armen etwa 44 von 100 Läufen mit doppeltem Ton)`
    );
  }

  // Eine eigene Tonliste im Web wäre die zweite Quelle neben `presets.ts`.
  for (const match of source.matchAll(/=\s*\[\s*["'][^\]]*\]/g)) {
    findings.push(
      `${HOST_PALETTE_PATH}:${lineOf(source, match.index)}: ein Listenliteral aus Zeichenketten — ` +
        `der Vorrat steht seit D7a nur noch in ${PRESETS_PATH}`
    );
  }

  // Und die Gegenprobe: die Datei muss die Vorgabe von dort auch wirklich
  // holen. Ohne sie wäre dieser Wächter allein durch eine leere Datei
  // zufriedenzustellen.
  assert.match(
    source,
    new RegExp(`import\\s*\\{[^}]*DEFAULT_HOST_THEME[^}]*\\}\\s*from\\s*["']contract["']`),
    `${HOST_PALETTE_PATH}: DEFAULT_HOST_THEME kommt nicht aus ${PRESETS_PATH} — dann stünde die Vorgabe zweimal im Baum`
  );
  assert.match(
    source,
    new RegExp(`export\\s+function\\s+${ACCESSOR}\\b`),
    `${HOST_PALETTE_PATH}: ${ACCESSOR} wird nicht mehr ausgegeben — die Karten hängen daran`
  );

  assert.deepEqual(findings, [], `Die Farbe eines Arms wird wieder gerechnet:\n${findings.join("\n")}`);
});

// ---------------------------------------------------------------------------
// 2. Jede Karte holt ihren Wert über den Zugriff auf die Ablage
// ---------------------------------------------------------------------------
//
// FÄNGT: den fest verdrahteten Wert (`data-hue="teal"`), den aus einer
// anderen Quelle gerechneten und den Aufruf, der `hostDisplay` gar nicht erst
// fragt.
//
// OHNE DIESE PRÜFUNG: ein neuer Bildschirm setzt `data-hue` „so wie die
// anderen" — und weil die Ableitungsregel in `palette.css` dort auflöst, wo
// das Attribut steht, sieht die Fläche fertig aus und trägt trotzdem eine
// Farbe, die kein Betreiber vergeben hat.
test("jede Stelle mit data-hue/data-ink nimmt den Wert aus hostDisplay", () => {
  const screens = SCREENS_ROOTS.flatMap((root) => collectSourceFiles(root, [".tsx"]));
  assert.ok(
    screens.length > 0,
    `keine .tsx-Datei unter ${SCREENS_LABEL} gefunden — der Wächter liefe ins Leere`
  );

  const findings = [];
  let checked = 0;

  for (const path of screens) {
    const content = stripComments(readFileSync(new URL(path, `file://${ROOT}`), "utf8"));
    const bindings = accessorBindings(content, ACCESSOR);

    for (const [attribute, field] of [
      ["data-hue", "hue"],
      ["data-ink", "ink"]
    ]) {
      for (const found of attributeExpressions(content, attribute)) {
        checked += 1;
        const direct = new RegExp(`^${ACCESSOR}\\s*\\(.*\\)\\.${field}$`).test(found.value);
        const viaBinding = new RegExp(`^([A-Za-z_$][\\w$]*)\\.${field}$`).exec(found.value);
        const fromStore = direct || (viaBinding !== null && bindings.has(viaBinding[1]));
        if (!fromStore) {
          findings.push(
            `${path}:${lineOf(content, found.index)}: ${attribute}={${found.value}} — der Wert muss über ` +
              `${ACCESSOR}(…).${field} aus der Ablage kommen (D7a). Bekannte Namen aus ${ACCESSOR}: ` +
              `${[...bindings].join(", ") || "(keine)"}`
          );
        }
      }
    }
  }

  // Der Wächter darf nicht dadurch grün werden, dass er nichts findet.
  //
  // ⚠️ Die Marke stand bis D7a auf 8 — vier Flächen aus D5/D6 mal zwei
  // Attribute. Mit der Vorschau im Farbeditor (`screens/settings/`) sind es
  // fünf Flächen und damit zehn Fundstellen, und die alte Marke fing genau
  // das nicht mehr, wofür sie da ist: verschwände eine ganze Fläche, fiele
  // die Zahl von 10 auf 8, die Marke hielte, und nichts würde rot. Eine
  // Marke, über die der Bestand hinauswächst, verfällt lautlos — sie wird
  // deshalb beim Wachsen mit nachgezogen und nicht beim Reißen gesenkt.
  //
  // ⚠️ UND GENAU DAS IST IHR SEITHER PASSIERT. Gemessen am 2026-09-07 in
  // Paket B5 (#5): die Marke stand auf 10, der Bestand auf 12 — sie lag zwei
  // darunter und hätte den Verlust einer ganzen Fläche durchgelassen.
  // Hinzugekommen ist `screens/ContainerScreen.tsx` (D6b); es sind heute
  // SECHS Flächen mal zwei Attribute. Messweg: die Marke vorübergehend auf
  // `>= 999` setzen und die Zahl aus der Fehlermeldung dieses Falls lesen
  // („nur 12 Fundstellen"), danach zurückstellen. Die Herleitung ist
  // nachgezählt und nicht geschätzt: `grep -rn "data-hue\|data-ink"
  // web/src/screens/` nennt die sechs Dateien mit einer Zuweisung
  // (HostColorPanel, HostGroup, HostCard, HostContainers, StackScreen,
  // ContainerScreen); die übrigen Treffer stehen in Kommentaren, die dieser
  // Wächter vorher abräumt.
  assert.ok(
    checked >= 12,
    `nur ${checked} Fundstellen für data-hue/data-ink unter ${SCREENS_LABEL} — erwartet werden mindestens 12 ` +
      `(sechs Flächen × zwei Attribute). Umbenannt, verschoben oder Muster geändert?`
  );

  assert.deepEqual(findings, [], `Farbe an der Karte, die nicht aus der Ablage kommt:\n${findings.join("\n")}`);
});

// ---------------------------------------------------------------------------
// 3. Die Vorgabe des ersten Tages hat eine Regel
// ---------------------------------------------------------------------------
//
// FÄNGT: eine Vorgabe in `presets.ts`, für die `palette.css` keine Regel
// führt. Das ist nach D7a der NORMALFALL auf dem Bildschirm — bestehende Arme
// werden nicht rückwirkend eingefärbt, also trägt am ersten Tag jede Karte
// genau diese beiden Werte.
//
// OHNE DIESE PRÜFUNG: die Karten blieben im Grundton des Hauses stehen, ohne
// dass irgendetwas rot wird, und der Betreiber sähe eine Liste wie vor D0.
test("DEFAULT_HOST_THEME trägt Werte, für die es in palette.css Regeln gibt", () => {
  const presets = readOrFail(PRESETS_PATH, "die eine Quelle der Stufen aus D7a");
  const css = stripCssComments(readOrFail(PALETTE_PATH, "die Ableitungsregeln der Palette"));

  const hue = defaultHostTheme(presets, "hue");
  const ink = defaultHostTheme(presets, "ink");
  assert.ok(hue !== null, `${PRESETS_PATH}: DEFAULT_HOST_THEME.hue nicht gefunden — Format geändert?`);
  assert.ok(ink !== null, `${PRESETS_PATH}: DEFAULT_HOST_THEME.ink nicht gefunden — Format geändert?`);

  const hues = hueRulesInCss(css);
  const inks = inkNamesInCss(css);
  assert.ok(hues.size > 0, `${PALETTE_PATH}: kein [data-hue=…] gefunden — Muster geändert?`);
  assert.ok(inks.size > 0, `${PALETTE_PATH}: kein [data-ink=…] gefunden — Muster geändert?`);

  assert.ok(
    hues.has(hue),
    `DEFAULT_HOST_THEME.hue = „${hue}" hat keine Regel in ${PALETTE_PATH} (vorhanden: ${[...hues.keys()].join(", ")})`
  );
  assert.ok(
    inks.has(ink),
    `DEFAULT_HOST_THEME.ink = „${ink}" hat keine Regel in ${PALETTE_PATH} (vorhanden: ${[...inks].join(", ")})`
  );
});

// ---------------------------------------------------------------------------
// 4. Die Erkenner selbst
// ---------------------------------------------------------------------------
//
// Ein Wächter ohne eigenen Test ist eine Behauptung.
test("die Leser selbst: was sie lesen müssen und was nicht", () => {
  assert.deepEqual(
    attributeExpressions("<Card data-hue={display.hue} data-ink={display.ink} />", "data-hue").map(
      (found) => found.value
    ),
    ["display.hue"]
  );
  assert.deepEqual(
    attributeExpressions('<Card data-hue="teal" />', "data-hue").map((found) => found.value),
    ['"teal"']
  );
  assert.deepEqual(attributeExpressions("<Card data-host={host.id} />", "data-hue"), []);

  assert.deepEqual(
    [...accessorBindings("const display = hostDisplay(entry.host);", "hostDisplay")],
    ["display"]
  );
  assert.deepEqual([...accessorBindings("const display = other(entry.host);", "hostDisplay")], []);

  const css = '[data-hue="a"] { --h: 62; }\n[data-hue=b] { --h: 130; }\n[data-ink="head"] { }';
  assert.deepEqual([...hueRulesInCss(css).keys()], ["a", "b"]);
  assert.deepEqual([...inkNamesInCss(css)], ["head"]);
  // Ein Ton ohne eigenen `--h`-Wert wird gelesen, aber nicht erfunden.
  assert.equal(hueRulesInCss('[data-hue="a"] { --c: 0.1; }').get("a"), null);

  const presets = 'export const DEFAULT_HOST_THEME: HostThemePreset = {\n  hue: "neutral",\n  ink: "head"\n};';
  assert.equal(defaultHostTheme(presets, "hue"), "neutral");
  assert.equal(defaultHostTheme(presets, "ink"), "head");
  assert.equal(defaultHostTheme('export const OTHER = { hue: "x" };', "hue"), null);
});
