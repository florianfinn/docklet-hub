// Der DOM für die Wächter des Webs — eine Fassung für alle.
//
// Warum es diese Datei gibt: bis hierher belegte im `web`-Workspace kein
// einziger Test, dass eine Komponente TUT, was sie soll. Gemessen in #71 und
// festgehalten in #78: entfernt man die Rückstellung des Sprachumschalters bei
// einem Fehler, bleibt die ganze Kette grün. Typcheck, Bau und Screenshots
// sehen einen Klickpfad nicht — sie sehen, dass er sich übersetzen, bündeln
// und abbilden lässt.
//
// ⚠️ DER DATEINAME TRÄGT KEIN `.test.` — sonst sammelte der Lauf die
// Hilfsdatei als Testdatei ein und meldete „keine Tests" (dieselbe Falle wie
// bei `strip-comments.mjs`).
//
// ⚠️ REIHENFOLGE. `GlobalRegistrator.register()` läuft beim Laden DIESES
// Moduls und damit, bevor React geladen wird: die dynamischen Importe unten
// stehen nach dem Aufruf, und ein Test importiert diese Datei als erste. Ein
// `import { createRoot } from "react-dom/client"` oben im Kopf wäre statisch
// und liefe VOR der Registrierung — React sähe dann kein `document`.
//
// Warum drei neue Abhängigkeiten, und warum diese (AGENTS.md, „Abhängigkeiten"
// — eine Abhängigkeit wird begründet, nicht bemerkt):
//
//   * `happy-dom` statt `jsdom`: beide können, was hier gebraucht wird. Das
//     eine ist deutlich kleiner und startet schneller, und der Testlauf steht
//     in jedem Haken vor jedem Push. `jsdom` bleibt der Rückweg, falls eine
//     Fläche etwas braucht, das happy-dom nicht kennt — der Wechsel wäre
//     diese eine Datei.
//   * `@happy-dom/global-registrator`: der vorgesehene Weg, die Fenster-Welt
//     in die Globalen von Node zu legen. Von Hand wären es ein Dutzend
//     Zuweisungen, die bei jeder Fassung nachzuziehen wären.
//   * `tsx`: der Testlauf muss `.tsx` lesen können. Es ist keine neue
//     Abhängigkeit dieses Repos — der `server`-Workspace fährt seinen Lauf
//     schon damit —, sondern eine des `web`-Workspaces. Kein Vitest: das
//     brächte einen zweiten Testläufer neben `node --test` mit eigener
//     Kommandozeile, eigener Konfiguration und eigenen Erwartungen an die
//     Ausgabe. Gemessen: unter `--import tsx` bleiben alle bestehenden
//     `.mjs`-Wächter grün.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { ReactNode } from "react";

GlobalRegistrator.register({ url: "https://hub.test/" });

// React kennt daran den Testlauf und verlangt, dass Zustandsänderungen in
// `act(…)` stehen. Ohne die Marke warnt es bei jedem Klick auf stderr, und
// eine Warnung, die immer kommt, liest niemand mehr.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { createQueryClient } = await import("../src/platform/query/query-client.js");

export type Mounted = {
  container: HTMLElement;
  /** The query cache of this tree, for a test that counts or seeds entries. */
  queryClient: ReturnType<typeof createQueryClient>;
  unmount: () => Promise<void>;
};

/**
 * Hängt einen Baum in ein frisches Element am `document` und gibt es zurück.
 *
 * Das Aufräumen ist Sache des Tests (`unmount`): zwei Bäume gleichzeitig am
 * selben `document` wären zwei Antworten auf jede Abfrage, und der Test läse
 * die des Nachbarn.
 */
//
// Every tree gets its own query cache (#256), built with the app's own policy
// (`createQueryClient`), the way `app/query/AppQueryProvider.tsx` gives the app
// one. A cache shared between cases would answer the second case from the
// first one's stub.
//
// ⚠️ `clear()` ON UNMOUNT IS NOT TIDYING UP. Under happy-dom TanStack Query sees
// a `window` and keeps every inactive entry for five minutes on a timer; the
// timers keep the test process alive, and the file would end five minutes
// after its last case instead of at once.
export async function renderInDom(node: ReactNode): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = createQueryClient();
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, node));
  });
  return {
    container,
    queryClient,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      // ⚠️ ONE MACROTASK AFTER THE UNMOUNT (#258). The stream store releases a
      // stream only after a grace period of one macrotask
      // (`web/src/platform/streams/stream-store.ts`, rule 3); a tree mounted
      // right after would otherwise revive the store of the previous case,
      // lines and open stream included.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // ⚠️ CANCEL BEFORE `clear()` (#286). A case may end on purpose with a
      // fetch still open (a stub that never answers). `clear()` cancels it
      // too, but the fetch settles only afterwards, and the `finally` of
      // `Query.fetch` then schedules a five-minute gc timer on a query the
      // cache no longer holds — nothing clears it, and the process waits.
      // Cancelling first lets that timer land while `clear()` can still
      // destroy it.
      await act(async () => {
        await queryClient.cancelQueries();
      });
      queryClient.clear();
      container.remove();
    }
  };
}

/**
 * Lässt eine Runde Mikrotasks UND den Zeitgeber durchlaufen.
 *
 * ⚠️ Gebraucht wird das für jede Wirkung, die an einer ABGELEHNTEN Zusage
 * hängt: der Klick kehrt zurück, bevor `fetch` geantwortet hat, und die
 * Rückstellung geschieht erst im `catch`. Ein Test, der direkt nach dem Klick
 * prüft, misst den Zwischenstand und wäre grün, auch wenn die Rückstellung
 * fehlt.
 */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Polls `condition` through `settle()` until it holds or `timeoutMs` ends.
 * Returns whether it held; the caller asserts, so a timeout fails the test.
 */
export async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return true;
    if (Date.now() >= deadline) return false;
    await settle();
  }
}

/**
 * Settles until no query of the tree is in flight, twice in a row (#271).
 *
 * ⚠️ A FIXED NUMBER OF `settle()` COUNTS THE LOADING STEPS OF A SCREEN. A
 * query reports its result one macrotask later (TanStack's notify batch), and
 * a query that only starts once the first one rendered (the compose file after
 * the overview, the text of a file after its listing) needs one more round.
 * When #271 moved the overview and the file text from an effect onto Query,
 * one more step appeared, and every mount with a counted `settle()` was short
 * by one. Quiet means: nothing in flight AND no query changed its state in
 * that round, twice in a row. "Nothing in flight" alone is not enough: a query
 * that starts and answers within one round leaves the round idle while its
 * result still waits for the notify batch of the next one.
 */
export async function settleQueries(queryClient: Mounted["queryClient"], maxRounds = 20): Promise<void> {
  const state = (): string =>
    JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => [query.queryHash, query.state.status, query.state.dataUpdatedAt, query.state.errorUpdatedAt])
    );
  let quiet = 0;
  let before = state();
  for (let round = 0; round < maxRounds && quiet < 2; round += 1) {
    await settle();
    const after = state();
    quiet = queryClient.isFetching() === 0 && after === before ? quiet + 1 : 0;
    before = after;
  }
}
