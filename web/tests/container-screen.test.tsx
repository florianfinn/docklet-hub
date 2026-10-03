// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG und keine Formatierung: der DOM
// muss stehen, bevor React geladen wird (siehe `dom-harness.tsx`). Wer hier
// alphabetisch sortiert, bekommt „document is not defined".
import { renderInDom, settle, waitFor } from "./dom-harness.js";

// ⚠️ React steht hier NAMENTLICH, obwohl keine Zeile es aufruft — `tsx`
// übersetzt das JSX dieser Datei mit dem alten Laufzeitmodell
// (`React.createElement`). Die Begründung samt Messung steht im Kopf von
// `language-switch.test.tsx`.
import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRouter, Route, Routes } from "react-router";

import type { MarkView } from "contract";
import type { ExternalManagement, HostOverview, OverviewContainer } from "contract";
import { de, en } from "../src/app/i18n/messages.js";
import { GlobalThemeProvider } from "../src/features/appearance/index.js";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { ContainerScreen } from "../src/app/screens/ContainerScreen.js";
import { ContainersScreen } from "../src/app/screens/ContainersScreen.js";
import { containerPath } from "../src/platform/routes/container-path.js";

// ⚠️ THE LAZY VIEWS ARE LOADED ONCE BEFORE THE FIRST CASE (#258, #261, #263). The
// screen loads them with `React.lazy`; the first `import()` of the module graph takes
// longer than the `settle()` after mounting, and the first case would see the
// loading text instead of the view. Loaded here, every later `import()`
// resolves at once. `import()` and not `import`: a `.lazy.tsx` entry is
// dynamic only (`lazy-only-dynamic`).
await import("../src/features/logs/LogView.lazy.js");
await import("../src/features/shell/ShellView.lazy.js");
await import("../src/features/files/FilesView.lazy.js");

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Die Container-Detailseite (#5, Etappe H3) hat fünf Fehler, die gültiges JSX,
// gültiges TypeScript und eine grüne Prüfkette sind. Kein Wächter über
// Dateitexte, kein `tsc` und kein `vite build` sieht sie:
//
//   1. DER REITER IM ZUSTAND STATT IN DER ADRESSE. Eine Fassung, die den
//      Reiter in einem `useState` führt, besteht jeden Test, der KLICKT — der
//      Klick setzt ja den Zustand. Rot wird sie erst beim NEULADEN, und ein
//      Neuladen ist im Prüfstand ein frisches Einhängen unter der Adresse. Die
//      beiden Fälle unten hängen deshalb je frisch ein und klicken nicht.
//   2. DAS FEHLENDE `encodeURIComponent`. Es ist der teuerste Fehler dieser
//      Fläche, weil er nicht scheitert, sondern LÜGT: ohne Kodierung schneidet
//      ein „#" im Namen den Rest der Adresse ab, die Route trifft trotzdem —
//      und zeigt einen ANDEREN Container, den es tatsächlich gibt. Der Fall
//      unten stellt beide nebeneinander in dieselbe Antwort; mit nur einem von
//      beiden wäre eine unkodierende Fassung grün geblieben, weil sie nichts
//      gefunden und „gibt es nicht" gesagt hätte.
//   3. DER NORMALFALL ALS FEHLER. Ein entfernter Container ist keine Störung.
//      Eine Fassung, die ihn als `containersFailed` meldet, sieht auf dem Bild
//      plausibel aus und schickt den Betreiber auf eine Suche.
//   4. DIE ANFRAGE, DEREN AUSGANG FESTSTEHT. Bei einem fremdverwalteten
//      Container läuft die Log-Route sicher in eine 403 (der Arm führt seine
//      Allowlist selbst). Ein Hinweis ÜBER einem eingehängten `LogView`
//      erklärte den Grund und schickte die Anfrage trotzdem los. ⚠️ Geprüft
//      wird deshalb am AUSGEBLIEBENEN AUFRUF und nicht am Text: ein Test, der
//      nur den Satz liest, bliebe grün, während die 403 im Hintergrund läuft.
//   5. DIE VERSCHACHTELTE BEDIENUNG. Der Griff für die Marken steckt im
//      Deepdive in derselben Zeile wie der neue Verweis. Steckte er IM
//      Verweis, öffnete ein Klick darauf die Detailseite statt das Menü — ein
//      Bedienfehler, kein Formfehler, und kein Browser meldet ihn.
//
// NICHT geprüft: dass der Server so antwortet. In dieser Umgebung läuft weder
// Postgres noch Docker — `fetch` ist unten eine Attrappe, die die Form der
// Routen nachbildet. Dass der Server sie hält, prüft der `server`-Workspace.

// ---------------------------------------------------------------------------
// Attrappen
// ---------------------------------------------------------------------------

const HOST_ID = "host-1";

/**
 * Ein Container in der Antwort der Übersicht.
 *
 * ⚠️ Der Typ wird nicht nachgebaut, sondern erfüllt: `OverviewContainer` kommt
 * über `client.ts` aus dem Servercode. Ein erfundenes Feld wäre ein Typfehler.
 */
function containerOf(options: {
  id: string;
  name: string;
  image?: string;
  marks?: MarkView[];
  externalManagement?: ExternalManagement | null;
}): OverviewContainer {
  return {
    id: options.id,
    name: options.name,
    image: options.image ?? "demo:latest",
    status: "Up 2 hours",
    running: true,
    startedAt: "2026-09-07T08:00:00.000Z",
    health: null,
    compose: null,
    stats: null,
    externalManagement: options.externalManagement ?? null,
    state: "ok",
    marks: options.marks ?? [],
    system: false
  };
}

/** Ein Arm mit diesen Containern, alle ohne Stack. */
function hostWith(containers: OverviewContainer[]): HostOverview[] {
  return [
    {
      host: {
        id: HOST_ID,
        name: "haus",
        agentUrl: "https://agent.test",
        kind: "internal",
        state: "registered",
        status: "online",
        agentVersion: "0.18.1",
        tunnelAddress: null,
        display: { hue: "neutral", ink: "edge" },
        agentUpdate: null,
        lastSeenAt: null
      },
      agent: { reachable: true, version: "0.18.1", contractVersion: null, readOnly: false, entries: null },
      stacks: [],
      loose: containers,
      error: null
    }
  ];
}

type Call = { method: string; url: string };

/**
 * Der Hub als Attrappe.
 *
 * ⚠️ SIE BILDET DIE ROUTEN NACH UND ERFINDET SIE NICHT: `GET /api/overview`
 * gibt `{ hosts }`, `GET /api/marks` gibt `{ marks }` (beides am Router
 * abgelesen, siehe `marks-assign.test.tsx`), und
 * `GET …/containers/:id/logs-stream` gibt einen Rumpf, der nie etwas sagt.
 *
 * ⚠️ DER LOG-RUMPF ENDET BEIM ABBRUCH und hängt nicht ewig. `LogView` bricht
 * beim Aushängen ab; ein Leser, der danach in seinem `read()` stehen bliebe,
 * hielte eine Zusage offen, die nie fällt — im Prüfstand ist das kein Fehler,
 * aber auch kein Bild des Browsers.
 */
function stubHub(hosts: HostOverview[], marks: MarkView[] = []): { calls: Call[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Call[] = [];

  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url });

    if (url.includes("/api/overview")) return Promise.resolve(json({ hosts }));
    if (url.includes("/api/marks")) return Promise.resolve(json({ marks }));
    // Die Messwerte des Reiters „Übersicht" (#213). Ohne Verlauf — was die
    // Fläche daraus zeichnet, prüft `container-metrics.test.tsx`.
    if (url.endsWith("/stats")) return Promise.resolve(json({ stats: null }));

    const signal = init?.signal ?? null;
    let release: ((value: { done: boolean; value?: Uint8Array }) => void) | null = null;
    signal?.addEventListener("abort", () => release?.({ done: true }));
    return Promise.resolve({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () =>
            signal?.aborted === true
              ? Promise.resolve({ done: true })
              : new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
                  release = resolve;
                }),
          cancel: () => Promise.resolve()
        })
      }
    } as unknown as Response);
  }) as typeof fetch;

  return { calls, restore: () => (globalThis.fetch = original) };
}

/**
 * Die Seite unter einer Adresse einhängen — das, was ein NEULADEN tut.
 *
 * ⚠️ Die beiden Routenpfade stehen hier als Literal und sind aus
 * `web/src/app/routes/AppRoutes.tsx` übernommen; die Adressen der Aufrufe baut
 * dagegen `containerPath`. Das ist Absicht: wer am Bauer etwas ändert, ohne
 * die Routentabelle nachzuziehen, trifft hier keine Route mehr, und die Fälle
 * unten finden nichts. Zwei Fassungen derselben Adresse, die gegeneinander
 * laufen — genau dafür stehen sie hier so.
 */
async function mountAt(path: string) {
  return renderInDom(
    // ⚠️ `GlobalThemeProvider` steht seit Paket B6, Etappe E6 (#5) hier. Der
    // Reiter „Shell" liest über `useGlobalTheme()` die Schriftgröße und den
    // Verlauf des Terminals; ohne den Anbieter wirft der Haken, und zwar an
    // JEDEM Fall dieser Datei und nicht nur an dem, der die Shell öffnet. In
    // der Anwendung steht er ohnehin darüber (`web/src/App.tsx`).
    <AppLanguageProvider>
      <GlobalThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/container/:hostId/:name" element={<ContainerScreen tab="overview" />} />
            <Route path="/container/:hostId/:name/logs" element={<ContainerScreen tab="logs" />} />
            <Route path="/container/:hostId/:name/shell" element={<ContainerScreen tab="shell" />} />
          </Routes>
        </MemoryRouter>
      </GlobalThemeProvider>
    </AppLanguageProvider>
  );
}

function at(testId: string): HTMLElement | null {
  const element = document.body.querySelector(`[data-testid="${testId}"]`);
  return element instanceof HTMLElement ? element : null;
}

/** Die Aufrufe an die Log-Route — der Prüfgegenstand von Fall 4. */
function logCalls(calls: Call[]): string[] {
  return calls.filter((call) => call.url.includes("/logs-stream")).map((call) => call.url);
}

// ---------------------------------------------------------------------------
// 1. Der Reiter steht in der ADRESSE und übersteht ein Neuladen
// ---------------------------------------------------------------------------
//
// FÄNGT: den Reiter im Zustand. Eine solche Fassung besteht jeden Test, der
// klickt; rot wird sie erst hier, wo unter der Adresse frisch eingehängt wird.

test("die Adresse mit /logs zeigt nach einem Neuladen das Protokoll", async () => {
  const container = containerOf({ id: "c1", name: "demo-web-1" });
  const server = stubHub(hostWith([container]));
  const mounted = await mountAt(containerPath(HOST_ID, container.name, "logs"));
  await settle();
  await waitFor(() => at("log-view") !== null);

  try {
    assert.ok(at("log-view") !== null, "unter der Adresse mit /logs steht das Protokoll");
    // Und der Strom hängt an der KENNUNG und nicht am Namen: der Arm führt
    // seine Allowlist über Kennungen, ein Name träfe sie nicht.
    assert.deepEqual(
      logCalls(server.calls).map((url) => url.includes(`/containers/${container.id}/logs-stream`)),
      [true],
      `die Log-Route wird mit der Kennung gerufen, gesehen wurde ${JSON.stringify(logCalls(server.calls))}`
    );
    // Der geltende Reiter ist am Baum zu sehen und nicht nur an der Farbe.
    assert.equal(at("container-tab-logs")?.getAttribute("aria-current"), "page");
    assert.equal(at("container-tab-overview")?.getAttribute("aria-current"), null);
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("das Protokoll füllt das Fenster und scrollt in sich, statt die Seite zu verlängern", async () => {
  // ⚠️ DIE LÜCKE DIESES PRÜFSTANDS, benannt: happy-dom rechnet kein Layout.
  // Gemessen am 2026-09-29 in Chromium am Nachbau mit dem gebauten Blatt:
  // bei 1600×900 und 700×900 blieb das Dokument 900 px hoch, und das Feld
  // scrollte in sich (491 px sichtbar von 3616 bzw. 10016 px). Vorher hing die
  // Höhe am Inhalt, und die Seite wurde mit jeder Zeile länger. Dieser Fall
  // hält die Bauweise: die Seite ist so hoch wie das Fenster unter der
  // Kopfzeile, und JEDER Knoten zwischen ihr und dem Feld gibt die Höhe weiter
  // (`flex-1` und `min-h-0`) — einer ohne `min-h-0` wüchse wieder mit dem
  // Inhalt.
  const container = containerOf({ id: "c1", name: "demo-web-1" });
  const server = stubHub(hostWith([container]));
  const mounted = await mountAt(containerPath(HOST_ID, container.name, "logs"));
  await settle();
  await waitFor(() => at("log-lines") !== null);

  try {
    const field = at("log-lines");
    assert.ok(field !== null, "das Feld der Zeilen fehlt");
    assert.ok(/(^|\s)overflow-y-auto(\s|$)/.test(field.className), "das Feld scrollt nicht in sich");
    assert.ok(
      /(^|\s)flex-1(\s|$)/.test(field.className) && !/(^|\s)h-\[/.test(field.className),
      `das Feld hat eine feste Höhe statt der des Fensters („${field.className}")`
    );
    let node = field.parentElement;
    let steps = 0;
    while (node !== null && !node.className.includes("100svh")) {
      assert.ok(
        /(^|\s)flex-1(\s|$)/.test(node.className) && /(^|\s)min-h-0(\s|$)/.test(node.className),
        `ein Knoten zwischen Seite und Feld gibt die Höhe nicht weiter („${node.className}")`
      );
      node = node.parentElement;
      steps += 1;
    }
    assert.ok(node !== null, "keine Seite mit der Höhe des Fensters über dem Protokoll");
    assert.ok(node.className.includes("var(--shell-header-height)"), "die Seite zieht die Kopfzeile nicht ab");
    // Feld → LogView → Karte → Detail → Seite: drei Knoten dazwischen.
    assert.equal(steps, 3);
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("die Adresse ohne /logs zeigt nach einem Neuladen die Übersicht", async () => {
  const container = containerOf({ id: "c1", name: "demo-web-1", image: "demo:2.1" });
  const server = stubHub(hostWith([container]));
  const mounted = await mountAt(containerPath(HOST_ID, container.name));
  await settle();

  try {
    assert.equal(at("log-view"), null, "ohne /logs steht kein Protokoll da");
    // ⚠️ And NO request goes out either. A `LogView` mounted in the hidden tab
    // holds one of the arm's limited streams (`MAX_OPEN_STREAMS`) open while
    // nobody looks.
    assert.deepEqual(logCalls(server.calls), [], "der geschlossene Reiter öffnet keinen Strom");

    assert.match(document.body.textContent ?? "", /demo:2\.1/, "das Abbild steht in der Übersicht");
    // Der Statustext des Agenten steht WÖRTLICH da und wird nicht übersetzt.
    assert.equal(at("container-agent-status")?.textContent, "Up 2 hours");
    assert.equal(at("container-tab-overview")?.getAttribute("aria-current"), "page");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 2. Ein Name mit Sonderzeichen findet SEINEN Container wieder
// ---------------------------------------------------------------------------
//
// FÄNGT: ein fehlendes `encodeURIComponent` beim Bauen der Adresse — und zwar
// in seiner stillen Form. Beide Container stehen in derselben Antwort, und eine
// unkodierende Fassung findet deshalb nicht etwa NICHTS, sondern den FALSCHEN,
// mit einer Fläche, die vollständig aussieht.
test("ein Name mit Rautenzeichen trifft seinen Container und nicht den ähnlichen", async () => {
  const sharp = containerOf({ id: "c-sharp", name: "demo#1", image: "sharp:1" });
  const plain = containerOf({ id: "c-plain", name: "demo", image: "plain:1" });
  const server = stubHub(hostWith([sharp, plain]));

  // ⚠️ OHNE `encodeURIComponent` stünde hier „/container/host-1/demo#1", und
  // das „#" eröffnete den Fragmentteil der Adresse: der Pfad hieße
  // „/container/host-1/demo", die Route träfe — und die Seite zeigte „demo".
  const mounted = await mountAt(containerPath(HOST_ID, sharp.name));
  await settle();

  try {
    const shown = document.body.textContent ?? "";
    assert.match(shown, /sharp:1/, "gezeigt wird der Container, dessen Name das Rautenzeichen trägt");
    assert.doesNotMatch(shown, /plain:1/, "und ausdrücklich nicht der ähnlich benannte daneben");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("ein Name mit Schrägstrich findet seinen Container wieder", async () => {
  const slashed = containerOf({ id: "c-slashed", name: "a/b", image: "slashed:1" });
  const server = stubHub(hostWith([slashed]));

  // ⚠️ Ohne Kodierung machte der Schrägstrich aus einem Abschnitt zwei, und
  // keine der beiden Routen träfe mehr — die Fläche bliebe leer.
  //
  // ⚠️ GEMESSEN AM 2026-09-07 an react-router 8.3.1: der Weg zurück ist ein
  // Ringtausch. `decodePath` dekodiert je Abschnitt EINMAL und ersetzt einen so
  // entstandenen „/" wieder durch „%2F" (utils.js Z. 532); `matchPathImpl`
  // macht daraus am Ende wieder einen „/" (Z. 502). Ein Name mit Schrägstrich
  // kommt deshalb unversehrt an — ein Name, der die drei Zeichen „%2F"
  // WÖRTLICH trägt, dagegen nicht: er käme als „a/b" heraus. Das ist die
  // Grenze der Bibliothek und nicht die dieser Fläche; Docker lässt in einem
  // Container-Namen ohnehin nur `[a-zA-Z0-9][a-zA-Z0-9_.-]*` zu, und die
  // Notiz steht hier, damit sie beim nächsten Sonderzeichen nicht neu gemessen
  // werden muss.
  const mounted = await mountAt(containerPath(HOST_ID, slashed.name));
  await settle();

  try {
    assert.match(document.body.textContent ?? "", /slashed:1/, "der Schrägstrich bleibt EIN Abschnitt der Adresse");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 3. Einen entfernten Container meldet die Seite als solchen
// ---------------------------------------------------------------------------
//
// FÄNGT: den Normalfall, der als Fehler erscheint. Verglichen wird gegen die
// Sprachdateien und nicht gegen einen abgetippten Satz — welche Sprache im Lauf
// gilt, hängt am Browser.
test("einen Container, den es nicht mehr gibt, meldet die Seite als solchen und nicht als Fehler", async () => {
  const server = stubHub(hostWith([containerOf({ id: "c1", name: "demo-web-1" })]));
  const mounted = await mountAt(containerPath(HOST_ID, "weg-seit-gestern"));
  await settle();

  try {
    assert.ok(at("container-not-found") !== null, `der eigene Zustand für „gibt es nicht" steht da`);
    const shown = document.body.textContent ?? "";
    assert.ok(
      [de.containerNotFoundTitle, en.containerNotFoundTitle].some((text) => shown.includes(text)),
      "die Seite sagt, dass es diesen Container nicht gibt"
    );
    assert.ok(
      ![de.containersFailed, en.containersFailed].some((text) => shown.includes(text)),
      "und meldet dafür KEINEN Fehler — der Abruf ist geglückt, der Container ist fort"
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// Seit #124 steht ein fremdverwalteter Container in der Allowlist des Arms
// (`externallyManaged`, Agent v0.31.0). Der Reiter öffnet seinen Strom wie bei
// jedem anderen, und der Hinweis steht nur noch in der Übersicht.
test("bei einem fremdverwalteten Container öffnet das Protokoll seinen Strom", async () => {
  const container = containerOf({
    id: "c1",
    name: "unraid-plex-1",
    externalManagement: { manager: "unraid" }
  });
  const server = stubHub(hostWith([container]));
  const mounted = await mountAt(containerPath(HOST_ID, container.name, "logs"));
  await settle();
  await waitFor(() => at("log-view") !== null);

  try {
    assert.ok(logCalls(server.calls).length > 0, "der Strom geht hinaus");
    assert.ok(at("log-view") !== null, "und `LogView` hängt ein");
    assert.equal(at("container-external-note"), null, "ohne Hinweis an seiner Stelle");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("die Übersicht nennt den Verwalter und was nur er darf", async () => {
  const container = containerOf({
    id: "c1",
    name: "unraid-plex-1",
    externalManagement: { manager: "unraid" }
  });
  const server = stubHub(hostWith([container]));
  const mounted = await mountAt(containerPath(HOST_ID, container.name));
  await settle();

  try {
    assert.ok(at("container-tab-logs") !== null, "der Reiter steht da und wird nicht weggelassen");
    const note = at("container-external-note");
    assert.ok(note !== null, "der Hinweis steht in der Übersicht");
    const shown = note.textContent ?? "";
    assert.ok(
      [de.containerExternalDefinition, en.containerExternalDefinition]
        .map((text) => text.replaceAll("{manager}", "Unraid"))
        .some((text) => shown.includes(text)),
      `der Hinweis nennt nicht, was gesperrt ist: ${JSON.stringify(shown)}`
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("eine unsichere Zuordnung nennt keinen Verwalter, aber die Sperre (#5)", async () => {
  const container = containerOf({
    id: "c1",
    name: "claimed-web-1",
    externalManagement: { manager: "unknown" }
  });
  const server = stubHub(hostWith([container]));
  const mounted = await mountAt(containerPath(HOST_ID, container.name));
  await settle();

  try {
    const shown = at("container-external-note")?.textContent ?? "";
    assert.ok(
      [de.containerExternalUnknownDefinition, en.containerExternalUnknownDefinition].some((text) => shown.includes(text)),
      `der Hinweis erklärt die unsichere Zuordnung nicht: ${JSON.stringify(shown)}`
    );
    assert.equal(shown.includes("unknown"), false, "der Rohwert erscheint nicht als Name");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("der Compose Manager erscheint mit seinem Produktnamen (#5)", async () => {
  const container = containerOf({
    id: "c1",
    name: "media-web-1",
    externalManagement: { manager: "unraid-compose" }
  });
  const server = stubHub(hostWith([container]));
  const mounted = await mountAt(containerPath(HOST_ID, container.name));
  await settle();

  try {
    const shown = at("container-external-note")?.textContent ?? "";
    assert.equal(shown.includes("Unraid Compose Manager"), true, JSON.stringify(shown));
    assert.equal(shown.includes("unraid-compose"), false, "der Rohwert erscheint nicht als Name");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 5. Der Marken-Griff steckt NICHT im Verweis auf die Detailseite
// ---------------------------------------------------------------------------
//
// FÄNGT: die verlinkte ZEILE. Sie wäre die naheliegende Bauform — und ein Klick
// auf den Griff öffnete darin die Detailseite statt das Menü. Geprüft wird am
// gerenderten Baum und im Deepdive, denn nur dort zeichnet die Zeile einen
// Griff (`assign` ist freiwillig).
test("im Deepdive steht der Marken-Griff neben dem Verweis auf die Detailseite und nicht darin", async () => {
  const mark: MarkView = { id: "m-a", name: "Sicherung", hue: "teal", style: "label" };
  const container = containerOf({ id: "c1", name: "demo-web-1", marks: [mark] });
  const server = stubHub(hostWith([container]), [mark]);
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <MemoryRouter>
        <ContainersScreen role="admin" />
      </MemoryRouter>
    </AppLanguageProvider>
  );
  await settle();

  try {
    const link = at(`container-open-${container.name}`);
    const handle = at(`container-marks-${container.name}`);
    assert.ok(link !== null, "der Name führt auf die Detailseite — sonst prüfte dieser Fall eine Zeile ohne Weg");
    assert.ok(handle !== null, "und der Griff hängt in derselben Zeile — sonst prüfte er eine Zeile ohne Gefahr");

    assert.equal(link.tagName.toLowerCase(), "a");
    assert.equal(
      link.getAttribute("href"),
      containerPath(HOST_ID, container.name),
      "der Verweis trägt den VOLLSTÄNDIGEN Namen des Containers, kodiert"
    );
    assert.equal(link.contains(handle), false, "der Griff steckt nicht im Verweis");

    // ⚠️ GESUCHT WIRD AB DEM ELTERNELEMENT und nicht am Griff selbst: `closest`
    // beginnt beim Element, und der Griff IST ein `button` — er fände sich
    // sonst immer selbst. Dieselbe Bauart wie `nested(…)` in
    // `marks-assign.test.tsx`, dort mit derselben Begründung.
    //
    // ⚠️ Verglichen wird ein NAME und kein Element. Gemessen am 2026-09-07:
    // ein `assert.equal(element, null)` gegen ein gefundenes Element lässt
    // `node --test` den ganzen Teilbaum als Unterschied ausschreiben — der Lauf
    // stand danach 14 Minuten und wurde mit SIGKILL beendet, ohne den Fall zu
    // nennen. Ein Wächter, der im Fehlerfall hängt, meldet nichts.
    const enclosing = handle.parentElement?.closest("a[href], button") ?? null;
    assert.equal(
      enclosing === null ? "nichts" : enclosing.tagName.toLowerCase(),
      "nichts",
      "der Griff steckt in gar keinem Bedienelement: ein Klick darauf öffnete sonst die Detailseite statt das Menü"
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 6. Der vierte Reiter „Shell" (Paket B6, Etappe E6, #5)
// ---------------------------------------------------------------------------
//
// FÄNGT: dieselben zwei Fehler wie bei den drei Reitern davor, an der Stelle,
// an der sie am teuersten sind.
//
//   a) DER REITER IM ZUSTAND STATT IN DER ADRESSE. Deshalb wird auch hier
//      frisch unter der Adresse eingehängt und nicht geklickt.
//   b) DIE ANFRAGE, DEREN AUSGANG FESTSTEHT. Bei einem fremdverwalteten
//      Container eröffnete `ShellView` eine Exec-Sitzung, die der Arm
//      abweist — und beleg dabei einen der VIER Sitzungsplätze des Arms und
//      einen Audit-Eintrag unter dem Namen des Betreibers. Geprüft wird an der
//      AUSGEBLIEBENEN Fläche und nicht am Text.

/** Steht der Reiter in der Leiste, und wo? */
function tabOrder(): string[] {
  return [...document.body.querySelectorAll("[data-testid^='container-tab-']")].map(
    (node) => node.getAttribute("data-testid") ?? ""
  );
}

test("„Shell“ steht als vierter Reiter hinter „Dateien“ und führt auf seine eigene Adresse", async () => {
  const container = containerOf({ id: "c1", name: "demo-web-1" });
  const server = stubHub(hostWith([container]));
  const mounted = await mountAt(containerPath(HOST_ID, container.name));
  await settle();

  try {
    assert.deepEqual(
      tabOrder(),
      ["container-tab-overview", "container-tab-logs", "container-tab-files", "container-tab-shell"],
      "die Reihenfolge der Reiter ist nicht sehen, lesen, Dateien, Shell"
    );

    const tab = at("container-tab-shell");
    assert.ok(tab, "es gibt keinen Reiter „Shell“");
    assert.equal(
      tab.getAttribute("href"),
      containerPath(HOST_ID, container.name, "shell"),
      "der Reiter führt nicht auf die Adresse, die `containerPath` für ihn baut"
    );
    // Gegen die Sprachdateien und nicht gegen einen abgetippten Satz: die
    // Sprache dieses Laufs hängt am Browser.
    assert.ok(
      [de.containerTabShell, en.containerTabShell].includes(tab.textContent ?? ""),
      `beschriftet ist er mit ${JSON.stringify(tab.textContent)}`
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("die Adresse mit /shell zeigt nach einem Neuladen das Terminal", async () => {
  const container = containerOf({ id: "c1", name: "demo-web-1" });
  const server = stubHub(hostWith([container]));
  const mounted = await mountAt(containerPath(HOST_ID, container.name, "shell"));
  await settle();
  await waitFor(() => at("shell-view") !== null);

  try {
    assert.ok(at("shell-view"), "unter der Shell-Adresse steht kein Terminal");
    assert.ok(at("log-view") === null, "unter der Shell-Adresse steht zusätzlich das Protokoll");
    assert.equal(
      at("container-tab-shell")?.getAttribute("aria-current"),
      "page",
      "der geltende Reiter ist für den Screenreader nicht der geltende"
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("ein fremdverwalteter Container bekommt ein Terminal wie jeder andere", async () => {
  const container = containerOf({
    id: "c1",
    name: "demo-web-1",
    externalManagement: { manager: "unraid" }
  });
  const server = stubHub(hostWith([container]));
  const mounted = await mountAt(containerPath(HOST_ID, container.name, "shell"));
  await settle();
  await waitFor(() => at("shell-view") !== null);

  try {
    assert.equal(at("container-external-note"), null, "an Stelle des Terminals steht ein Hinweis");
    assert.ok(at("shell-view") !== null, "das Terminal hängt ein");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 7. Der GESCHLOSSENE Reiter „Shell" eröffnet keine Sitzung
// ---------------------------------------------------------------------------
//
// FÄNGT: ein `hidden` statt der Zusage „nur der geltende Reiter wird
// eingehängt". Vorbild `stack-tabs.test.tsx` („der geschlossene Reiter holt
// keine Compose-Datei"), und hier wiegt es am schwersten: eine Exec-Sitzung
// belegt einen der VIER Plätze des ganzen Arms, für alle Menschen zusammen.
// Wer die Container-Seite öffnet, um die Stammdaten zu lesen, hätte damit
// nebenbei eine Shell eröffnet — und nach vier solchen Seiten bekäme niemand
// auf diesem Arm mehr ein Terminal.
//
// ⚠️ AM AUSGEBLIEBENEN AUFRUF UND NICHT AM TEXT. Eine Fassung mit `hidden`
// bestünde jede Prüfung, die nur nachsieht, ob etwas sichtbar ist.

/** Die Aufrufe an die Exec-Routen — der Prüfgegenstand von Fall 7. */
function execCalls(calls: Call[]): string[] {
  return calls.filter((call) => call.url.includes("/exec")).map((call) => call.url);
}

test("der geschlossene Reiter „Shell“ eröffnet keine Sitzung auf dem Arm", async () => {
  const container = containerOf({ id: "c1", name: "demo-web-1" });
  const server = stubHub(hostWith([container]));
  const mounted = await mountAt(containerPath(HOST_ID, container.name));
  await settle();

  try {
    // Die Übersicht steht, der Reiter „Shell" ist geschlossen.
    assert.ok(at("container-tab-shell"), "es gibt den Reiter gar nicht — dann prüft dieser Fall nichts");
    assert.ok(at("shell-view") === null, "das Terminal hängt trotz geschlossenem Reiter im Baum");
    assert.deepEqual(
      execCalls(server.calls),
      [],
      "der geschlossene Reiter hat eine Shell auf dem Arm eröffnet — einer von vier Plätzen, für alle " +
        "Menschen zusammen"
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});
