// Der Marken-Editor am laufenden Baum (D7b, #62).
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

import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { messages } from "../src/app/i18n/messages.js";
import { MarksPanel } from "../src/features/marks/MarksPanel.js";
import { MarkChip } from "../src/platform/ui/marks/index.js";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Bis D7b belegte im `web`-Workspace genau ein Test, dass eine Komponente TUT,
// was sie soll (`language-switch.test.tsx`). Der Rest der Kette — `tsc`,
// `vite build`, elf Wächter über Dateitexte — sieht einen Klickpfad nicht: er
// sieht, dass er sich übersetzen, bündeln und abbilden lässt. Gemessen in D4:
// die ganze Kette war grün, während der Hintergrund der Anmeldung als
// 300×150-Fleck in der Ecke klebte.
//
// Zwei Fehlerklassen fängt sonst nichts:
//
//   1. DIE DREI ATTRIBUTE AUF VERSCHIEDENEN ELEMENTEN. Ein Wrapper mit
//      `data-hue` und ein Kind mit `data-mark` ist gültiges JSX, gültiges HTML
//      und gültiges CSS — und die Marke trägt den Grundton des Hauses statt
//      des gewählten Tons, weil eine CSS-Variable dort auflöst, wo sie
//      deklariert ist (docs/design/hub-color-and-structure.md §8). Kein Lint,
//      kein Bau und kein Wächter dieses Repos sieht den Unterschied.
//   2. DER FALL `name-taken`. Er ist der einzige Fehlschlag, den der Betreiber
//      tatsächlich auslöst, und der Weg dorthin führt über einen Statuscode
//      (409), der sich lautlos in „konnte nicht angelegt werden" verwandelt,
//      sobald jemand `mark-errors.ts` vereinfacht.
//
// NICHT geprüft: die Wirkung gegen die ECHTEN Routen. Es läuft in dieser
// Umgebung weder Postgres noch Docker; `fetch` ist hier eine Attrappe, die den
// gemessenen Vertrag aus `server/src/app/router.ts` nachspielt. Was diese Datei
// belegt, ist das Verhalten der Oberfläche gegen diesen Vertrag — nicht, dass
// der Server ihn hält. Das prüft `server/src/app/mark-routes.test.ts`.

type StubMark = { id: string; name: string; hue: string; style: string };

/**
 * Der Hub ohne Hub.
 *
 * ⚠️ Die Antworten sind am Router NACHGEMESSEN und nicht erfunden:
 * `GET /api/marks` → `{ marks }` (router.ts:314), `POST` → 201 `{ mark }`
 * (:557), `PUT` → `{ mark }` (:575), `DELETE` → 204 ohne Rumpf (:604), und ein
 * vergebener Name → 409 mit `{ error: "name-taken", message }`
 * (`handleMarkError`, :122). Eine Attrappe, die eine andere Form liefert,
 * prüfte die Oberfläche gegen einen Vertrag, den es nicht gibt.
 */
function stubHub(options: {
  marks: StubMark[];
  /** Namen, auf die `POST`/`PUT` mit 409 antwortet. */
  taken?: string[];
}): { calls: { method: string; url: string; body: unknown }[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: { method: string; url: string; body: unknown }[] = [];
  let counter = 0;

  const json = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, url, body });

    if (method === "GET") return Promise.resolve(json(200, { marks: options.marks }));

    if (method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));

    const sent = (body as { mark?: StubMark } | null)?.mark;
    if (sent !== undefined && (options.taken ?? []).includes(sent.name)) {
      return Promise.resolve(json(409, { error: "name-taken", message: "Diesen Namen gibt es schon." }));
    }
    if (method === "POST") {
      counter += 1;
      return Promise.resolve(json(201, { mark: { ...sent, id: `new-${counter}` } }));
    }
    // PUT: die Kennung steht im Pfad, der Server antwortet mit der ganzen Marke.
    const id = url.slice(url.lastIndexOf("/") + 1);
    return Promise.resolve(json(200, { mark: { ...sent, id } }));
  }) as typeof fetch;

  return { calls, restore: () => (globalThis.fetch = original) };
}

function find(container: HTMLElement, testId: string): HTMLElement {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  assert.ok(element instanceof HTMLElement, `„${testId}" steht nicht im Baum`);
  return element;
}

/**
 * Setzt den Wert eines Eingabefelds so, wie React ihn sieht.
 *
 * ⚠️ `element.value = …` allein reicht NICHT. React hängt einen eigenen Setter
 * vor die Eigenschaft des Prototyps und merkt sich den letzten Wert; wer die
 * Eigenschaft direkt beschreibt, ändert den DOM, und Reacts `onChange` bekommt
 * beim nächsten Ereignis denselben Wert zu sehen wie vorher — der Zustand
 * bliebe leer, und der Test wäre grün an einer Stelle, an der er nichts misst.
 * Der Umweg über den Setter des Prototyps ist der vorgesehene Weg.
 */
async function typeInto(element: HTMLElement, value: string): Promise<void> {
  assert.ok(element instanceof HTMLInputElement, "das Feld ist ein Eingabefeld");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  assert.ok(setter !== undefined, "der Setter des Prototyps ist da");
  // Das Ereignis steht in `act(…)`, aus demselben Grund wie beim Klick unten.
  await React.act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * Ein Klick, der zurückkehrt, wenn React fertig ist.
 *
 * ⚠️ `element.click()` steht IN `act(…)` und nicht davor. Ohne das warnt React
 * bei jedem Klick, der einen Zustand setzt, auf stderr („An update … was not
 * wrapped in act(…)") — gemessen an `RemoveMarkDialog`, dessen `setBusy(true)`
 * noch im Klick-Handler läuft. Eine Warnung, die bei jedem Lauf kommt, liest
 * niemand mehr, und sie verdeckt die nächste, die etwas bedeutet.
 */
async function click(element: HTMLElement): Promise<void> {
  await React.act(async () => {
    element.click();
  });
  await settle();
}

async function mountPanel(marks: StubMark[], taken?: string[]) {
  const server = stubHub({ marks, taken });
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <MarksPanel role="admin" />
    </AppLanguageProvider>
  );
  // Der erste Abruf hängt an einer Zusage — ohne dieses Durchlaufen stünde die
  // Liste noch auf „wird abgefragt".
  await settle();
  return { server, ...mounted };
}

// ---------------------------------------------------------------------------
// 1. Die drei Attribute stehen auf DEMSELBEN Element
// ---------------------------------------------------------------------------
//
// FÄNGT: den Baustein, der `data-hue` an einen Wrapper und `data-mark` an ein
// Kind hängt. Gegenprobe beim Bau: zieht man in `MarkChip.tsx` das `data-hue`
// auf ein umschließendes `<span>`, wird genau dieser Test rot; die volle Kette
// bleibt sonst grün — GEMESSEN am 2026-09-06: unter dieser Mutation ist
// `pnpm run lint` Exit 0 und alle 128 Wächter über Dateitexte grün, nur dieser
// Test wird rot. Für den Fall `name-taken` weiter unten dasselbe: setzt man in
// `mark-errors.ts` beide Zweige auf `settingsMarkCreateFailed`, wird nur der
// Test dort rot.
test("eine Marke trägt Ton, Ebene und Darstellung auf einem Element", async () => {
  const { container, unmount } = await renderInDom(
    <MarkChip mark={{ id: "m1", name: "Sicherung", hue: "teal", style: "fill" }} />
  );

  try {
    const marked = container.querySelectorAll("[data-mark]");
    assert.equal(marked.length, 1, "genau ein Element führt die Marken-Ebene");

    const chip = marked[0];
    assert.ok(chip instanceof HTMLElement);
    assert.equal(chip.getAttribute("data-mark"), "m1");
    assert.equal(
      chip.getAttribute("data-hue"),
      "teal",
      "der Ton steht auf demselben Element wie data-mark — sonst rechnet die " +
        "Ableitungsregel in palette.css mit dem Grundton des Hauses (§8)"
    );
    assert.equal(chip.getAttribute("data-mark-style"), "fill");

    // Und die drei Hilfsklassen ebenfalls dort: `bg-mark-face` löst
    // `var(--mark-face)` am benutzenden Element auf (`@theme inline`,
    // tokens.css) — auf einem anderen Element als der Ableitung stünde
    // dieselbe Falle noch einmal.
    for (const utility of ["bg-mark-face", "text-mark-ink", "border-mark-line"]) {
      assert.ok(chip.classList.contains(utility), `die Klasse ${utility} steht am selben Element`);
    }

    // Kein Vorfahre und kein Nachfahre führt eine zweite Palette-Ebene.
    assert.equal(container.querySelectorAll("[data-hue]").length, 1);
    assert.equal(container.querySelectorAll("[data-mark-style]").length, 1);
    assert.equal(chip.textContent, "Sicherung");
  } finally {
    await unmount();
  }
});

// Die Gegenprobe zum Test darüber: die zwei Darstellungen sind zwei
// verschiedene Werte und nicht zweimal derselbe. Ohne sie wäre der Test oben
// auch mit einem Bauteil grün, das `data-mark-style` fest verdrahtet.
test("die zwei Darstellungen kommen als zwei verschiedene Werte an", async () => {
  const { container, unmount } = await renderInDom(
    <>
      <MarkChip mark={{ name: "a", hue: "teal", style: "label" }} />
      <MarkChip mark={{ name: "b", hue: "teal", style: "fill" }} />
    </>
  );

  try {
    const styles = [...container.querySelectorAll("[data-mark-style]")].map((element) =>
      element.getAttribute("data-mark-style")
    );
    assert.deepEqual(styles, ["label", "fill"]);
    // Eine Marke ohne Kennung ist erlaubt (die Vorschau in den Auswahllisten)
    // und trägt trotzdem die Ebene — sonst bekäme die Vorschau den Grundton.
    assert.equal(container.querySelectorAll("[data-mark]").length, 2);
  } finally {
    await unmount();
  }
});

// ---------------------------------------------------------------------------
// 2. Anlegen
// ---------------------------------------------------------------------------
test("eine neue Marke wird angelegt und steht danach in der Liste", async () => {
  const { container, unmount, server } = await mountPanel([]);

  try {
    assert.equal(container.querySelectorAll("[data-testid^=mark-row-]").length, 0);

    await typeInto(find(container, "mark-new-name"), "Sicherung");
    await click(find(container, "mark-add"));

    const posts = server.calls.filter((call) => call.method === "POST");
    assert.equal(posts.length, 1, "es geht genau eine Anfrage hinaus");
    assert.equal(posts[0]?.url, "/api/marks");
    assert.deepEqual(
      posts[0]?.body,
      { mark: { name: "Sicherung", hue: "neutral", style: "label" } },
      "der Rumpf trägt den VOLLEN Satz unter dem Umschlag „mark“"
    );

    const row = find(container, "mark-row-new-1");
    assert.ok(row.textContent?.includes("Sicherung"));

    // ⚠️ Und die Marke steht mit der Kennung DES SERVERS da. Das ist die
    // Fehlerklasse aus D7a: eine Client-Funktion, die den Umschlag nicht
    // auspackt, hängte `{ mark: … }` an die Liste, `id` wäre `undefined` und
    // die Zeile hieße `mark-row-undefined`.
    assert.equal(container.querySelectorAll("[data-testid^=mark-row-]").length, 1);
  } finally {
    server.restore();
    await unmount();
  }
});

// ---------------------------------------------------------------------------
// 3. Ein vergebener Name
// ---------------------------------------------------------------------------
//
// FÄNGT: den 409, der als allgemeines „konnte nicht angelegt werden" endet.
// Gegenprobe beim Bau: gibt man in `mark-errors.ts` immer
// `settingsMarkCreateFailed` zurück, wird dieser Test rot.
test("ein vergebener Name wird als eigener Fall gemeldet und legt nichts an", async () => {
  const { container, unmount, server } = await mountPanel([], ["Sicherung"]);

  try {
    await typeInto(find(container, "mark-new-name"), "Sicherung");
    await click(find(container, "mark-add"));

    // ⚠️ Der erwartete Text kommt aus den SPRACHDATEIEN und steht nicht fest
    // verdrahtet hier. Die Ausgangssprache entscheidet `browserLanguage` — also
    // das, was die Fensterwelt des Testlaufs meldet (happy-dom sagt heute
    // Englisch); ein fest geschriebener deutscher Satz machte diesen Test davon
    // abhängig und bräche, sobald sie etwas anderes meldet. Dieselbe Vorsicht
    // wie in `language-switch.test.tsx`.
    const lang = document.documentElement.lang === "de" ? "de" : "en";
    const error = find(container, "mark-new-error");
    assert.equal(
      error.textContent,
      messages[lang].settingsMarkNameTaken,
      "der 409 hat einen eigenen Text und fällt nicht auf die allgemeine Meldung zurück"
    );
    assert.notEqual(
      error.textContent,
      messages[lang].settingsMarkCreateFailed,
      "und er ist nicht derselbe Satz wie der allgemeine Fehlschlag"
    );
    assert.equal(error.getAttribute("role"), "alert", "der Screenreader erfährt davon");

    assert.equal(
      container.querySelectorAll("[data-testid^=mark-row-]").length,
      0,
      "abgelehnt heißt: die Liste bleibt, wie sie war"
    );
    // Der getippte Name bleibt stehen — sonst müsste der Betreiber ihn neu
    // schreiben, um ein Zeichen daran zu ändern.
    assert.equal((find(container, "mark-new-name") as HTMLInputElement).value, "Sicherung");
  } finally {
    server.restore();
    await unmount();
  }
});

// ---------------------------------------------------------------------------
// 4. Ändern
// ---------------------------------------------------------------------------
test("eine Marke wird umbenannt, und der Knopf ist vorher stumm", async () => {
  const { container, unmount, server } = await mountPanel([
    { id: "m1", name: "Sicherung", hue: "teal", style: "label" }
  ]);

  try {
    const save = find(container, "mark-save-m1");
    assert.ok(save instanceof HTMLButtonElement);
    assert.equal(save.disabled, true, "solange nichts anders ist, gibt es nichts zu speichern");

    await typeInto(find(container, "mark-name-m1"), "Sicherung nachts");
    await settle();
    assert.equal(save.disabled, false, "ein geändertes Zeichen macht den Knopf lebendig");

    await click(save);

    const puts = server.calls.filter((call) => call.method === "PUT");
    assert.equal(puts.length, 1);
    assert.equal(puts[0]?.url, "/api/marks/m1");
    assert.deepEqual(puts[0]?.body, {
      mark: { name: "Sicherung nachts", hue: "teal", style: "label" }
    });

    assert.ok(find(container, "mark-row-m1").textContent?.includes("Sicherung nachts"));
    assert.equal(save.disabled, true, "nach dem Speichern gibt es wieder nichts zu speichern");
  } finally {
    server.restore();
    await unmount();
  }
});

// ---------------------------------------------------------------------------
// 5. Entfernen
// ---------------------------------------------------------------------------
//
// ⚠️ Geprüft wird auch, dass VORHER gefragt wird. Ein Klick auf „Entfernen“,
// der sofort löscht, nähme dem Betreiber den einzigen Halt vor einem Schritt,
// der die Marke von jedem Ziel abzieht (`ON DELETE CASCADE`, 007-marks.sql).
test("das Entfernen fragt vorher und nimmt die Zeile danach heraus", async () => {
  const { container, unmount, server } = await mountPanel([
    { id: "m1", name: "Sicherung", hue: "teal", style: "label" }
  ]);

  try {
    await click(find(container, "remove-m1"));
    assert.equal(
      server.calls.filter((call) => call.method === "DELETE").length,
      0,
      "der erste Klick öffnet die Rückfrage und löscht nicht"
    );

    // Der Dialog hängt in einem Portal am `document.body` und nicht im
    // Behälter dieses Baums — gesucht wird deshalb dort.
    const confirm = document.body.querySelector('[data-testid="remove-confirm-m1"]');
    assert.ok(confirm instanceof HTMLElement, "die Rückfrage steht offen");
    await click(confirm);

    const deletes = server.calls.filter((call) => call.method === "DELETE");
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0]?.url, "/api/marks/m1");

    assert.equal(
      container.querySelectorAll('[data-testid="mark-row-m1"]').length,
      0,
      "die Zeile ist weg, ohne dass jemand neu laden muss"
    );
  } finally {
    server.restore();
    await unmount();
  }
});
