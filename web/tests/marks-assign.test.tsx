// Das ZUORDNEN der eigenen Marken und der Schalter für die Einrückung
// (D7b/C2, #62).
//
// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG und keine Formatierung: der DOM
// muss stehen, bevor React geladen wird (siehe `dom-harness.tsx`). Wer hier
// alphabetisch sortiert, bekommt „document is not defined".
import { renderInDom, settle } from "./dom-harness.js";

// ⚠️ React steht hier NAMENTLICH, obwohl keine Zeile es aufruft — `tsx`
// übersetzt das JSX dieser Datei mit dem alten Laufzeitmodell
// (`React.createElement`). Die Begründung samt Messung steht im Kopf von
// `language-switch.test.tsx`.
import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRouter, Route, Routes } from "react-router";

import { MARK_IDS_MAX, type MarkView } from "contract";
import type { HostOverview, OverviewContainer, StackView } from "contract";
import type { Role } from "../src/platform/session/session-user.js";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { ContainersScreen } from "../src/app/screens/ContainersScreen.js";
import { StackScreen } from "../src/app/screens/StackScreen.js";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Sieben Fehler dieser Fläche sind gültiges JSX, gültiges TypeScript und eine
// grüne Prüfkette. Keiner der 128 Wächter über Dateitexte, kein `tsc` und kein
// `vite build` sieht sie — geprüft wird deshalb am gerenderten Baum und an dem,
// was `fetch` zu sehen bekommt:
//
//   1. DER HALBE SATZ. `PUT …/marks` ERSETZT die Zuordnung eines Ziels
//      (`parseMarkIds`, server/src/features/marks/input.ts). Eine Oberfläche, die
//      beim Anhängen nur die NEUE Kennung schickte, zöge alle übrigen Marken ab
//      — mit einer 200 als Antwort und ohne eine einzige rote Zeile. Der Test
//      liest deshalb den RUMPF und prüft die ganze Liste IN IHRER REIHENFOLGE,
//      nicht nur, dass geschrieben wurde.
//   2. DER NEUNTE EINTRAG. Der Server lehnt mehr als `MARK_IDS_MAX` mit einer
//      400 ab. Eine Oberfläche, die dagegenläuft, zeigt eine Fehlermeldung für
//      eine Grenze, von der der Betreiber nichts wusste.
//   3. VERSCHACHTELTE BEDIENUNG. Ein `button` in einem `button` (oder in einem
//      `a`) ist ungültiges HTML, das kein Browser meldet: der äußere Klick
//      löst mit aus, die Tastaturbedienung erreicht das innere Element nicht
//      mehr, und die Zeile sieht dabei unverändert aus. Kein vorhandener
//      Wächter fängt das — deshalb steht die Zählung unten.
//   4. DER GRIFF FÜR DEN, DER NICHT SCHREIBEN DARF. Die drei Routen stehen
//      hinter `requireAdmin`; ein Knopf für einen Benutzer ohne Rolle endete im
//      403. Er sieht die Marken und keinen Griff.
//   5. DIE STUFEN DER EINRÜCKUNG. Sie kommen aus `INDENT_STEPS` und nicht aus
//      einer zweiten Aufzählung im Bildschirm; geschrieben wird der Rumpf
//      `{ display: { indent } }`.
//   6. DER FOKUS, DER NACH ESCAPE NICHT ZURÜCKKEHRT. Bis Etappe D war das ein
//      GEMESSENER Fehler dieser Fläche und keine Vermutung: der selbstgebaute
//      Aufklapper enthielt keinen einzigen `.focus()`-Aufruf, und nach Escape
//      stand `document.activeElement` auf `<body>`. Wer mit der Tastatur
//      arbeitet, war damit aus der Zeile heraus, in der er gerade war.
//   7. DAS MENÜ, AUS DEM DIE TASTATUR NICHT MEHR HERAUSKOMMT. Ebenfalls
//      gemessen: nach dem Wählen sperrte `disabled={busy}` den Eintrag unter
//      dem Fokus, der Browser nahm ihm den Fokus, und der Escape-Griff hing am
//      Wurzel-`<span>` — ein Tastendruck von `<body>` lief nicht mehr durch
//      ihn. Ergebnis war `{focus:"BODY", open:true, openAfterEscapeFromBody:
//      true}`. Beide Fehler sind durch eine Lücke gekommen, die diese Datei
//      selbst gerissen hatte: in 595 Zeilen rührte keine einzige an die
//      Tastatur.
//
// ⚠️ DER INHALT DES MENÜS STEHT NICHT IM CONTAINER DER VORRICHTUNG. Seit
// Etappe D ist der Aufklapper das `DropdownMenu` aus `web/src/platform/ui/shadcn/`, und
// Radix schickt seinen Inhalt durch ein Portal an `document.body`. `find(…)`
// unten sucht deshalb im ganzen Dokument; eine Abfrage, die nur den
// gerenderten Teilbaum abginge, fände nichts und wäre für jede Abwesenheit
// grün, ohne etwas zu prüfen.
//
// ⚠️ GEÖFFNET WIRD ÜBER `pointerdown` UND NICHT ÜBER `click()`. Gemessen am
// 2026-09-06 unter happy-dom: `trigger.click()` lässt das Radix-Menü
// geschlossen (0 Einträge im Dokument), ein `PointerEvent("pointerdown")` mit
// `button: 0` öffnet es (2 Einträge). Radix hört auf `pointerdown` — das ist
// keine Eigenheit des Prüfstands, sondern die Geste, die auch der Zeiger
// macht. Genau diese Messung war in der Etappe davor der Anlass, das fertige
// Menü gar nicht erst zu nehmen; sie war zu weit gefasst.
//
// NICHT geprüft: dass der Server so antwortet. In dieser Umgebung läuft weder
// Postgres noch Docker — `fetch` ist unten eine Attrappe, die die Form der
// Routen nachbildet. Dass der Server sie hält, prüft der `server`-Workspace.
//
// NICHT geprüft: das Bild. Ein DOM ohne Stylesheet rechnet keine Breite; die
// Sichtprüfung steht im Bericht dieser Etappe.

// ---------------------------------------------------------------------------
// Attrappen
// ---------------------------------------------------------------------------

const HOST_ID = "host-1";
const PROJECT = "demo";
const CONTAINER = "demo-web-1";

function markOf(id: string, name: string): MarkView {
  // ⚠️ Der Typ wird nicht nachgebaut, sondern erfüllt: `MarkView` kommt aus
  // `server/src/features/marks/types.ts` über `client.ts`. Ein Ton, den `HUE_TONES`
  // nicht kennt, wäre ein Typfehler — gemessen in C1: ein erfundenes
  // `hue: "iris"` blieb unter `tsx` grün und wurde erst von `tsc -p tests` rot.
  return { id, name, hue: "teal", style: "label" };
}

function containerOf(marks: MarkView[]): OverviewContainer {
  return {
    id: "c1",
    name: CONTAINER,
    image: "demo:latest",
    status: "Up 2 hours",
    running: true,
    startedAt: null,
    health: null,
    compose: { project: PROJECT, service: "web" },
    stats: null,
    externalManagement: null,
    state: "ok",
    marks,
    system: false
  };
}

function overviewOf(options: {
  stackMarks: MarkView[];
  containerMarks: MarkView[];
  indent?: StackView["indent"];
}): HostOverview[] {
  const container = containerOf(options.containerMarks);
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
      stacks: [
        {
          project: PROJECT,
          state: "ok",
          running: 1,
          marks: options.stackMarks,
          indent: options.indent ?? "nested",
          hidden: false,
          total: 1,
          system: false,
          containers: [container]
        }
      ],
      loose: [],
      error: null
    }
  ];
}

type Call = { method: string; url: string; body: unknown };

/**
 * Der Hub als Attrappe.
 *
 * ⚠️ SIE BILDET DIE ROUTEN NACH UND ERFINDET SIE NICHT. Die vier Formen sind
 * am Router abgelesen (`server/src/app/router.ts`): `GET /api/overview` gibt
 * `{ hosts }`, `GET /api/marks` gibt `{ marks }`, `PUT …/marks` nimmt
 * `{ markIds }` und gibt `{ marks }`, `PUT …/display` nimmt
 * `{ display: { indent } }` und gibt `{ display }`. Eine Attrappe mit einer
 * anderen Form prüfte die Oberfläche gegen einen Vertrag, den es nicht gibt —
 * und genau daran ist in D7a ein zwei Pakete alter Fehler aufgefallen.
 *
 * ⚠️ `PUT …/marks` antwortet mit den Marken IN DER GESCHICKTEN REIHENFOLGE,
 * so wie der Server es tut (`ORDER BY upserted.position` in
 * `server/src/features/marks/assignment-store.ts`). Eine Attrappe, die sortierte,
 * machte den Test gegen die Reihenfolge wertlos.
 */
function stubHub(options: { hosts: HostOverview[]; marks: MarkView[] }): {
  calls: Call[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  const byId = new Map(options.marks.map((mark) => [mark.id, mark]));

  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, url, body });

    if (method === "GET" && url.includes("/api/overview")) return Promise.resolve(json({ hosts: options.hosts }));
    if (method === "GET" && url.includes("/api/marks")) return Promise.resolve(json({ marks: options.marks }));

    if (url.endsWith("/display")) {
      return Promise.resolve(json({ display: (body as { display: unknown }).display }));
    }

    const sent = (body as { markIds: string[] }).markIds;
    return Promise.resolve(json({ marks: sent.map((id) => byId.get(id)).filter((mark) => mark !== undefined) }));
  }) as typeof fetch;

  return { calls, restore: () => (globalThis.fetch = original) };
}

/**
 * Ein Element mit dieser Kennung, IRGENDWO im Dokument.
 *
 * ⚠️ Der erste Parameter ist der Baum, in dem NICHT allein gesucht wird. Er
 * steht weiterhin da, weil die Aufrufe unten damit sagen, welche Vorrichtung
 * gerade hängt — gesucht wird aber am `document`, denn der Inhalt des Menüs
 * reist durch ein Portal an `document.body` und steht nicht im Container der
 * Vorrichtung (siehe der Kopf dieser Datei).
 */
function find(container: HTMLElement, testId: string): HTMLElement {
  assert.ok(container.isConnected, "die Vorrichtung hängt noch am Dokument");
  const element = document.body.querySelector(`[data-testid="${testId}"]`);
  assert.ok(element instanceof HTMLElement, `„${testId}" steht nicht im Dokument`);
  return element;
}

/** Dasselbe für die Abwesenheit — ebenfalls am ganzen Dokument. */
function absent(testId: string): Element | null {
  return document.body.querySelector(`[data-testid="${testId}"]`);
}

/**
 * Ein Klick, der zurückkehrt, wenn React fertig ist.
 *
 * ⚠️ `element.click()` steht IN `act(…)` und nicht davor — sonst warnt React
 * bei jedem Klick, der einen Zustand setzt, auf stderr, und eine Warnung, die
 * bei jedem Lauf kommt, verdeckt die nächste, die etwas bedeutet.
 */
async function click(element: HTMLElement): Promise<void> {
  await React.act(async () => {
    element.click();
  });
  await settle();
}

/**
 * Das Menü aufziehen — mit der Geste, auf die Radix wirklich hört.
 *
 * ⚠️ `pointerdown` UND NICHT `click()`, und `button: 0` gehört dazu: der
 * Auslöser von Radix prüft `event.button === 0 && event.ctrlKey === false`,
 * bevor er umschaltet. Ein `PointerEvent` ohne diese Felder ginge durch und
 * täte nichts, und der Test wäre dann grün gegen ein Menü, das gar nicht
 * aufgegangen ist — deshalb prüft diese Hilfe gleich selbst nach.
 */
async function openMenu(trigger: HTMLElement): Promise<void> {
  await React.act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
  });
  await settle();
  assert.equal(trigger.getAttribute("aria-expanded"), "true", "das Menü steht nach der Geste offen");
}

/**
 * Ein Tastendruck auf das Element, das gerade den Fokus hat.
 *
 * ⚠️ Er geht an `document.activeElement` und nicht an ein gemerktes Element:
 * genau die Verschiebung des Fokus ist hier der Prüfgegenstand. Ein Test, der
 * die Taste immer an dasselbe `<span>` schickte, wäre grün geblieben, während
 * der Betreiber mit dem Fokus auf `<body>` festsaß.
 */
async function pressFocused(key: string): Promise<void> {
  const target = document.activeElement ?? document.body;
  await React.act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }));
  });
  await settle();
}

/** Was gerade den Fokus hat — als Kennung, sonst als Name des Elements. */
function focused(): string {
  const element = document.activeElement;
  return element?.getAttribute("data-testid") ?? element?.tagName ?? "nichts";
}

/** Die Rümpfe aller Schreibvorgänge auf die Marken eines Ziels. */
function markPuts(calls: Call[]): { url: string; markIds: string[] }[] {
  return calls
    .filter((call) => call.method === "PUT" && call.url.endsWith("/marks"))
    .map((call) => ({ url: call.url, markIds: (call.body as { markIds: string[] }).markIds }));
}

async function mountStack(options: {
  role?: Role;
  stackMarks: MarkView[];
  marks: MarkView[];
  indent?: StackView["indent"];
}) {
  const server = stubHub({
    hosts: overviewOf({ stackMarks: options.stackMarks, containerMarks: [], indent: options.indent }),
    marks: options.marks
  });
  const mounted = await renderInDom(
    <AppLanguageProvider>
      {/* Die Adresse trägt Arm und Projekt — die Seite liest beides aus den
          Parametern der Route und nicht aus einer Eigenschaft. */}
      <MemoryRouter initialEntries={[`/stack/${HOST_ID}/${PROJECT}`]}>
        <Routes>
          <Route path="/stack/:hostId/:project" element={<StackScreen role={options.role ?? "admin"} tab="overview" />} />
        </Routes>
      </MemoryRouter>
    </AppLanguageProvider>
  );
  // Die Seite hängt an zwei Zusagen (Übersicht und Marken) — ohne dieses
  // Durchlaufen stünde sie noch auf „wird geholt".
  await settle();
  return { server, ...mounted };
}

async function mountDeepdive(options: { role?: Role; containerMarks: MarkView[]; marks: MarkView[] }) {
  const server = stubHub({
    hosts: overviewOf({ stackMarks: [], containerMarks: options.containerMarks }),
    marks: options.marks
  });
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <MemoryRouter>
        <ContainersScreen role={options.role ?? "admin"} />
      </MemoryRouter>
    </AppLanguageProvider>
  );
  await settle();
  return { server, ...mounted };
}

// ---------------------------------------------------------------------------
// 1. Anhängen schickt die ALTE Liste plus die neue
// ---------------------------------------------------------------------------
//
// FÄNGT: den halben Satz. Gegenprobe beim Bau: ersetzt man in `MarkAssign.tsx`
// das `[...ids, mark.id]` durch `[mark.id]`, wird genau diese Zusicherung rot
// („die alten Marken reisen mit"), während lint, build und alle 128 Wächter
// grün bleiben — die Mutation steht in einer einzigen Zeile und ist gültiges
// TypeScript.
test("eine Marke anhängen schickt die alte Liste plus die neue, in dieser Reihenfolge", async () => {
  const alpha = markOf("m-a", "Sicherung");
  const beta = markOf("m-b", "Datenbank");
  const gamma = markOf("m-c", "Netz");
  const { container, unmount, server } = await mountStack({
    stackMarks: [alpha, beta],
    marks: [alpha, beta, gamma]
  });

  try {
    await openMenu(find(container, "stack-marks"));
    await click(find(container, "stack-marks-mark-m-c"));

    const puts = markPuts(server.calls);
    assert.equal(puts.length, 1, "genau ein Schreibvorgang");
    assert.ok(
      puts[0].url.endsWith(`/api/hosts/${HOST_ID}/stacks/${PROJECT}/marks`),
      `geschrieben wird an die Route des Stacks, nicht an „${puts[0].url}"`
    );
    assert.deepEqual(
      puts[0].markIds,
      ["m-a", "m-b", "m-c"],
      "der GANZE Satz reist, und die neue Marke steht am Ende: die Route ersetzt " +
        "die Zuordnung, ein Rumpf mit nur der neuen Kennung zöge die beiden alten ab"
    );

    // ⚠️ UND DAS BILD TRÄGT DANACH DEN STAND DES SERVERS, OHNE DASS JEMAND NEU
    // LÄDT. Die Attrappe antwortet mit den drei Marken; stünde die dritte
    // danach nicht da, hinge die Fläche am alten Stand und der Betreiber
    // wüsste nicht, ob sein Klick angekommen ist.
    assert.ok(
      container.textContent?.includes("Netz") === true,
      "die angehängte Marke steht danach im Bild — ohne zweiten Abruf und ohne Neuladen"
    );
  } finally {
    await unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 2. Abziehen schickt den Rest
// ---------------------------------------------------------------------------
test("eine Marke abziehen schickt den Rest und nicht die abgezogene", async () => {
  const alpha = markOf("m-a", "Sicherung");
  const beta = markOf("m-b", "Datenbank");
  const { container, unmount, server } = await mountStack({
    stackMarks: [alpha, beta],
    marks: [alpha, beta]
  });

  try {
    await openMenu(find(container, "stack-marks"));
    await click(find(container, "stack-marks-mark-m-a"));

    const puts = markPuts(server.calls);
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0].markIds, ["m-b"], "der Rest reist, nicht die abgezogene Marke");
  } finally {
    await unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 3. Der neunte Eintrag wird abgefangen, bevor der Server ihn ablehnt
// ---------------------------------------------------------------------------
//
// FÄNGT: die Oberfläche, die gegen `MARK_IDS_MAX` läuft. Die Grenze steht im
// Server und wird hier NICHT abgeschrieben, sondern importiert — eine Zahl an
// zwei Stellen wiche beim nächsten Umbau an einer davon ab.
test("der neunte Eintrag steht gar nicht erst zur Wahl", async () => {
  const assigned = Array.from({ length: MARK_IDS_MAX }, (_, index) => markOf(`m-${index}`, `Marke ${index}`));
  const extra = markOf("m-extra", "Zuviel");
  const { container, unmount, server } = await mountStack({
    stackMarks: assigned,
    marks: [...assigned, extra]
  });

  try {
    await openMenu(find(container, "stack-marks"));

    // ⚠️ Am DOKUMENT gesucht und nicht am Container: der Inhalt des Menüs
    // steht im Portal. Eine Abfrage am Container wäre hier für JEDE Fassung
    // grün — auch für eine, die den neunten Eintrag anbietet.
    assert.equal(
      absent("stack-marks-mark-m-extra"),
      null,
      "die überzählige Marke steht nicht zur Wahl — sonst liefe der Klick in eine 400"
    );
    // Und die Grenze wird BENANNT: ein Eintrag, der einfach fehlt, sähe aus wie
    // ein Fehler beim Laden.
    find(container, "stack-marks-full");
    // Die zugeordneten bleiben stehen, sonst käme niemand unter die Grenze
    // zurück.
    find(container, "stack-marks-mark-m-0");

    assert.equal(markPuts(server.calls).length, 0, "es wurde nichts geschrieben");
  } finally {
    await unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 4. Kein Bedienelement steckt in einem anderen
// ---------------------------------------------------------------------------
//
// FÄNGT: `button` in `button` und `button` in `a`. Beides ist ungültiges HTML,
// das kein Browser meldet — der äußere Klick löst mit aus, die
// Tastaturbedienung erreicht das innere Element nicht mehr, und die Zeile sieht
// dabei unverändert aus. Kein vorhandener Wächter fängt das.
//
// ⚠️ Geprüft wird auf BEIDEN Flächen, denn die Gefahr sitzt an verschiedenen
// Stellen: auf der Stack-Seite steht der Griff neben der Überschrift, im
// Deepdive in der Container-Zeile, deren Stack-Kopfzeile ein `Link` über die
// ganze Breite ist.
//
// ⚠️ GEZÄHLT WIRD AM GANZEN DOKUMENT UND NICHT NUR IM CONTAINER. Seit das Menü
// durch ein Portal an `document.body` reist, läge sein Inhalt außerhalb des
// gerenderten Teilbaums — eine Zählung am Container fände dort NIE etwas und
// wäre für jede Fassung grün, auch für eine, die den Auslöser wieder in einen
// Knopf setzt. Der Container bleibt der Beleg dafür, dass überhaupt eine
// Vorrichtung hängt.
function nested(container: HTMLElement): string[] {
  assert.ok(container.isConnected, "die Vorrichtung hängt noch am Dokument");
  const interactive = "a[href], button";
  return [...document.body.querySelectorAll(interactive)]
    .filter((element) => element.parentElement?.closest(interactive) != null)
    .map((element) => `${element.tagName.toLowerCase()} in ${element.parentElement?.closest(interactive)?.tagName.toLowerCase() ?? "?"}`);
}

test("auf der Stack-Seite steckt kein Bedienelement in einem anderen", async () => {
  const alpha = markOf("m-a", "Sicherung");
  const { container, unmount, server } = await mountStack({ stackMarks: [alpha], marks: [alpha] });

  try {
    assert.deepEqual(nested(container), [], "zugeklappt");
    await openMenu(find(container, "stack-marks"));
    assert.deepEqual(nested(container), [], "aufgeklappt — die Auswahl steht neben dem Auslöser, nicht darin");
  } finally {
    await unmount();
    server.restore();
  }
});

test("im Deepdive steckt der Griff der Container-Zeile in keinem Verweis", async () => {
  const alpha = markOf("m-a", "Sicherung");
  const { container, unmount, server } = await mountDeepdive({ containerMarks: [alpha], marks: [alpha] });

  try {
    // Die Kopfzeile des Stacks IST ein Verweis — sie muss also im Baum stehen,
    // sonst prüfte dieser Test gegen eine Fläche ohne die Gefahr.
    assert.ok(
      container.querySelector("a[href]") !== null,
      "die Stack-Kopfzeile des Deepdives steht als Verweis im Baum"
    );
    assert.deepEqual(nested(container), [], "zugeklappt");

    await openMenu(find(container, `container-marks-${CONTAINER}`));
    assert.deepEqual(nested(container), [], "aufgeklappt");
  } finally {
    await unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 5. Der Container-Griff schreibt an die Route des Containers
// ---------------------------------------------------------------------------
test("die Container-Zeile schreibt an ihren eigenen Namen", async () => {
  const alpha = markOf("m-a", "Sicherung");
  const beta = markOf("m-b", "Datenbank");
  const { container, unmount, server } = await mountDeepdive({
    containerMarks: [alpha],
    marks: [alpha, beta]
  });

  try {
    await openMenu(find(container, `container-marks-${CONTAINER}`));
    await click(find(container, `container-marks-${CONTAINER}-mark-m-b`));

    const puts = markPuts(server.calls);
    assert.equal(puts.length, 1);
    assert.ok(
      puts[0].url.endsWith(`/api/hosts/${HOST_ID}/containers/${CONTAINER}/marks`),
      `das Ziel ist der VOLLSTÄNDIGE Container-Name und nicht der Dienstname — „${puts[0].url}"`
    );
    assert.deepEqual(puts[0].markIds, ["m-a", "m-b"]);
  } finally {
    await unmount();
    server.restore();
  }
});

test("die Container-Zeile zieht eine Marke ab, und die Zeile zeigt sie danach nicht mehr", async () => {
  const alpha = markOf("m-a", "Sicherung");
  const beta = markOf("m-b", "Datenbank");
  const { container, unmount, server } = await mountDeepdive({
    containerMarks: [alpha, beta],
    marks: [alpha, beta]
  });

  try {
    await openMenu(find(container, `container-marks-${CONTAINER}`));
    await click(find(container, `container-marks-${CONTAINER}-mark-m-a`));

    const puts = markPuts(server.calls);
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0].markIds, ["m-b"], "der Rest reist, nicht die abgezogene Marke");

    await click(find(container, `container-marks-${CONTAINER}-mark-m-b`));
    const after = markPuts(server.calls);
    assert.equal(after.length, 2, "auch die letzte Marke lässt sich abziehen");
    assert.deepEqual(after[1].markIds, [], "die Zeile kennt nach der ersten Antwort den neuen Stand");
  } finally {
    await unmount();
    server.restore();
  }
});

test("das Kreuz an der Marke der Container-Zeile zieht genau diese Marke ab", async () => {
  const alpha = markOf("m-a", "Sicherung");
  const beta = markOf("m-b", "Datenbank");
  const { container, unmount, server } = await mountDeepdive({
    containerMarks: [alpha, beta],
    marks: [alpha, beta]
  });

  try {
    await click(find(container, "mark-remove-m-a"));
    const puts = markPuts(server.calls);
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0].markIds, ["m-b"], "der Rest reist, nicht die abgezogene Marke");
    assert.ok(
      container.querySelector('[data-testid="mark-remove-m-a"]') === null,
      "die abgezogene Marke steht nicht mehr in der Zeile"
    );
  } finally {
    await unmount();
    server.restore();
  }
});

test("zwei Klicks hintereinander an einer Container-Zeile schreiben nur einmal", async () => {
  const alpha = markOf("m-a", "Sicherung");
  const beta = markOf("m-b", "Datenbank");
  const { container, unmount, server } = await mountDeepdive({
    containerMarks: [alpha, beta],
    marks: [alpha, beta]
  });

  try {
    // Kein `await` dazwischen: der zweite Klick kommt, solange der erste
    // Schreibvorgang noch unterwegs ist. Eine gemeinsame Sperre lässt ihn fallen.
    find(container, "mark-remove-m-a").click();
    find(container, "mark-remove-m-b").click();
    await settle();
    assert.equal(markPuts(server.calls).length, 1, "ein Schreibvorgang zur Zeit");
  } finally {
    await unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 6. Ohne Adminrolle: die Marken ja, der Griff nein
// ---------------------------------------------------------------------------
test("ein Benutzer ohne Adminrolle sieht die Marken und keinen Griff", async () => {
  const alpha = markOf("m-a", "Sicherung");

  const stack = await mountStack({ role: "user", stackMarks: [alpha], marks: [alpha] });
  try {
    assert.ok(stack.container.textContent?.includes("Sicherung") === true, "die Marke des Stacks steht da");
    assert.equal(stack.container.querySelector('[data-testid="stack-marks"]'), null, "kein Griff an den Marken");
    assert.equal(
      stack.container.querySelector('[data-testid="stack-indent-flat"]'),
      null,
      "kein Schalter für die Einrückung"
    );
    // ⚠️ Und kein Abruf der Marken-Liste: sie wäre eine Anfrage für eine
    // Auswahl, die niemand sieht.
    assert.equal(
      stack.server.calls.filter((call) => call.url.includes("/api/marks")).length,
      0,
      "der Vorrat wird gar nicht erst geholt"
    );
  } finally {
    await stack.unmount();
    stack.server.restore();
  }

  const deepdive = await mountDeepdive({ role: "user", containerMarks: [alpha], marks: [alpha] });
  try {
    assert.ok(deepdive.container.textContent?.includes("Sicherung") === true, "die Marke der Zeile steht da");
    assert.equal(
      deepdive.container.querySelector(`[data-testid="container-marks-${CONTAINER}"]`),
      null,
      "kein Griff an der Container-Zeile"
    );
  } finally {
    await deepdive.unmount();
    deepdive.server.restore();
  }
});

// ---------------------------------------------------------------------------
// 7. Die Übersicht bekommt den Griff NICHT
// ---------------------------------------------------------------------------
//
// FÄNGT: den Griff, der über `ContainerRow` in die Übersicht und auf die
// Stack-Seite durchschlägt. Die Zeile ist dieselbe Komponente auf drei Flächen
// (gemessen in C1); der Unterschied ist allein die freiwillige Angabe `assign`.
// Ohne diese Zusicherung wäre eine Fassung, die den Griff fest verdrahtet,
// überall grün.
test("die Container-Zeile der Stack-Seite trägt keinen Griff", async () => {
  const alpha = markOf("m-a", "Sicherung");
  const server = stubHub({
    hosts: overviewOf({ stackMarks: [], containerMarks: [alpha] }),
    marks: [alpha]
  });
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <MemoryRouter initialEntries={[`/stack/${HOST_ID}/${PROJECT}`]}>
        <Routes>
          <Route path="/stack/:hostId/:project" element={<StackScreen role="admin" tab="overview" />} />
        </Routes>
      </MemoryRouter>
    </AppLanguageProvider>
  );
  await settle();

  try {
    // Der Griff des STACKS steht da — sonst prüfte dieser Test eine Fläche,
    // auf der es ohnehin keinen gibt.
    find(mounted.container, "stack-marks");
    assert.equal(
      mounted.container.querySelector(`[data-testid="container-marks-${CONTAINER}"]`),
      null,
      "die Container-Zeile dieser Fläche bekommt keinen Griff: zugeordnet wird ein " +
        "Container im Deepdive, und zwei Wege zum selben Ziel liefen auseinander"
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 8. Die Einrückung
// ---------------------------------------------------------------------------
test("der Schalter der Einrückung schreibt den Rumpf der Display-Route", async () => {
  const { container, unmount, server } = await mountStack({ stackMarks: [], marks: [], indent: "nested" });

  try {
    const flat = find(container, "stack-indent-flat");
    assert.equal(flat.getAttribute("aria-pressed"), "false", "„bündig“ gilt noch nicht");
    assert.equal(
      find(container, "stack-indent-nested").getAttribute("aria-pressed"),
      "true",
      "die geltende Stufe ist am Schalter zu sehen"
    );

    await click(flat);

    const puts = server.calls.filter((call) => call.method === "PUT" && call.url.endsWith("/display"));
    assert.equal(puts.length, 1);
    assert.ok(puts[0].url.endsWith(`/api/hosts/${HOST_ID}/stacks/${PROJECT}/display`));
    assert.deepEqual(
      puts[0].body,
      { display: { indent: "flat" } },
      "der Rumpf ist `{ display: { indent } }` — unter dem Umschlag, wie am Router abgelesen"
    );

    // Und das Bild folgt dem gespeicherten Stand, ohne dass jemand neu lädt.
    assert.equal(find(container, "stack-indent-flat").getAttribute("aria-pressed"), "true");
  } finally {
    await unmount();
    server.restore();
  }
});

test("dieselbe Stufe noch einmal zu wählen schreibt nichts", async () => {
  const { container, unmount, server } = await mountStack({ stackMarks: [], marks: [], indent: "nested" });

  try {
    await click(find(container, "stack-indent-nested"));
    assert.equal(
      server.calls.filter((call) => call.method === "PUT").length,
      0,
      "ein Klick auf die geltende Stufe ist keine Änderung"
    );
  } finally {
    await unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 9. Ein Hub ganz ohne Marken
// ---------------------------------------------------------------------------
//
// „Leer ist erlaubt, ausgegraut nicht" (D3): der Auslöser ist da und führt zur
// ersten Marke, statt eine leere Auswahlliste zu zeigen.
test("gibt es im Hub noch keine Marke, führt die Auswahl in die Einstellungen", async () => {
  const { container, unmount, server } = await mountStack({ stackMarks: [], marks: [] });

  try {
    await openMenu(find(container, "stack-marks"));
    const panel = find(container, "stack-marks-panel");
    const link = panel.querySelector("a[href]");
    assert.ok(link instanceof HTMLAnchorElement, "der Weg zur ersten Marke steht als Verweis da");
    assert.ok(link.getAttribute("href")?.endsWith("/settings") === true, "und er führt in die Einstellungen");
  } finally {
    await unmount();
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// 10. Die Tastatur
// ---------------------------------------------------------------------------
//
// FÄNGT: die beiden Fehler, an denen der unabhängige Prüfer diese Fläche am
// 2026-09-06 hat durchfallen lassen — und die durch die Lücke gekommen sind,
// dass hier bis dahin keine Zeile an die Tastatur rührte.
//
// ⚠️ Diese drei Proben laufen auf der STACK-SEITE und nicht zusätzlich im
// Deepdive. Beide Flächen hängen dasselbe Bauteil ein (`StackScreen.tsx` und
// `overview/ContainerRow.tsx`, beide `MarkAssign`); was hier geprüft wird, ist
// die Bedienung DIESES Bauteils und nicht die Zeile darum. Dass es auf beiden
// Flächen steht, prüfen die Proben 4 und 5 weiter oben.

test("Escape schließt das Menü und gibt den Fokus an den Auslöser zurück", async () => {
  const alpha = markOf("m-a", "Sicherung");
  const { container, unmount, server } = await mountStack({ stackMarks: [], marks: [alpha] });

  try {
    const trigger = find(container, "stack-marks");
    await openMenu(trigger);

    // Der Fokus muss ÜBERHAUPT ins Menü gewandert sein — sonst prüfte die
    // Rückgabe unten eine Rückkehr, die nie eine Abreise war.
    assert.notEqual(focused(), "BODY", "der Fokus steht nach dem Öffnen nicht auf dem Rumpf");
    assert.ok(
      find(container, "stack-marks-panel").contains(document.activeElement),
      `der Fokus steht im Menü und nicht auf „${focused()}"`
    );

    await pressFocused("Escape");

    assert.equal(absent("stack-marks-panel"), null, "Escape schließt das Menü");
    assert.equal(
      focused(),
      "stack-marks",
      "und der Fokus kehrt auf den AUSLÖSER zurück. Bis Etappe D stand er danach auf " +
        "`<body>`: wer mit der Tastatur arbeitete, war aus der Zeile heraus, in der er war"
    );
  } finally {
    await unmount();
    server.restore();
  }
});

test("nach dem Wählen bleibt die Tastatur im Menü, und Escape kommt wieder heraus", async () => {
  const alpha = markOf("m-a", "Sicherung");
  const beta = markOf("m-b", "Datenbank");
  const { container, unmount, server } = await mountStack({
    stackMarks: [alpha],
    marks: [alpha, beta]
  });

  try {
    const trigger = find(container, "stack-marks");
    await openMenu(trigger);

    // Mit den Pfeiltasten auf den ersten Eintrag und ihn mit Enter wählen —
    // der Weg, den ein Betreiber ohne Maus nimmt.
    await pressFocused("ArrowDown");
    assert.equal(focused(), "stack-marks-mark-m-a", "die Pfeiltaste führt auf den ersten Eintrag");

    await pressFocused("Enter");

    assert.deepEqual(markPuts(server.calls)[0]?.markIds, [], "Enter zieht die Marke ab — die Taste WIRKT");
    // ⚠️ Das Menü bleibt offen: angehängt und abgezogen wird in derselben
    // Liste, und wer nach der ersten Marke wieder herausflöge, bräuchte für die
    // zweite einen zweiten Weg dorthin.
    find(container, "stack-marks-panel");
    assert.notEqual(
      focused(),
      "BODY",
      "der Fokus liegt nach dem Wählen NICHT auf dem Rumpf. Bis Etappe D tat er das — " +
        "`disabled={busy}` nahm dem Eintrag unter dem Fokus den Fokus, und niemand holte ihn zurück"
    );

    await pressFocused("Escape");

    assert.equal(
      absent("stack-marks-panel"),
      null,
      "und Escape schließt DANACH noch. Bis Etappe D hing der Escape-Griff am Wurzel-`<span>`: " +
        "ein Tastendruck von `<body>` lief nicht mehr durch ihn, und der Betreiber kam nicht mehr heraus"
    );
    assert.equal(focused(), "stack-marks", "der Fokus kehrt auch auf diesem Weg auf den Auslöser zurück");
  } finally {
    await unmount();
    server.restore();
  }
});

test("der Auslöser sagt an, dass ein Menü an ihm hängt, und die Tastatur zieht es auf", async () => {
  const alpha = markOf("m-a", "Sicherung");
  const { container, unmount, server } = await mountStack({ stackMarks: [], marks: [alpha] });

  try {
    const trigger = find(container, "stack-marks");
    assert.equal(trigger.getAttribute("aria-haspopup"), "menu", "der Auslöser kündigt ein Menü an");
    assert.equal(trigger.getAttribute("aria-expanded"), "false", "und sagt, dass es noch zu ist");

    // Enter am Auslöser zieht auf — ohne Zeiger, nur mit der Tastatur.
    await React.act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    });
    await settle();

    const panel = find(container, "stack-marks-panel");
    assert.equal(panel.getAttribute("role"), "menu", "der Aufklapper ist ein Menü und ein namenloses `div`");
    assert.equal(
      trigger.getAttribute("aria-controls"),
      panel.getAttribute("id"),
      "und der Auslöser zeigt über `aria-controls` auf genau dieses Menü"
    );
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.equal(
      find(container, "stack-marks-mark-m-a").getAttribute("role"),
      "menuitemcheckbox",
      "ein Eintrag ist an- und abwählbar und sagt das auch an"
    );
  } finally {
    await unmount();
    server.restore();
  }
});
