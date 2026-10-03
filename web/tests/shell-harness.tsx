// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG: der DOM muss stehen, bevor
// React geladen wird (siehe `dom-harness.tsx`).
import { renderInDom, settle } from "./dom-harness.js";

import React from "react";

import { GlobalThemeProvider, useGlobalTheme } from "../src/features/appearance/index.js";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { ShellView } from "../src/features/shell/ShellView.js";
import type {
  SizeWatcher,
  SurfaceLoader,
  TerminalLook,
  TerminalSize,
  TerminalSurface
} from "../src/features/shell/terminal-look.js";

// Der Prüfstand für den Reiter „Shell" (Paket B6, Etappe E6, #5) — eine
// Fassung für beide Testdateien.
//
// ⚠️ DER DATEINAME TRÄGT KEIN `.test.` — sonst sammelte der Lauf die
// Hilfsdatei als Testdatei ein und meldete „keine Tests" (dieselbe Falle wie
// bei `dom-harness.tsx` und `strip-comments.mjs`).
//
// ⚠️ WARUM ES DIESE DATEI GIBT. Die Fälle des Reiters standen bis zum
// 2026-09-08 in EINER Datei; mit den Wächtern aus Baustein 6 stand sie bei
// 1.044 Zeilen und damit über der Marke aus `source-file-size.test.mjs`.
// Geteilt ist entlang der Frage und nicht entlang der Zeilenzahl:
// `shell-view.test.tsx` prüft, was HEREINKOMMT (Nachladen, Strom, die fünf
// Zustände des Kopfs), `shell-input.test.tsx`, was HINAUSGEHT (Eingabe,
// Größe, kein Auto-Reconnect, die Sitzungs-Id). Der Prüfstand ist beiden
// gemeinsam und stünde sonst zweimal da — zwei Attrappen desselben Hubs, die
// beim ersten Nachziehen auseinanderlaufen.

export const ENCODER = new TextEncoder();

export const HOST = "host-1";
export const CONTAINER = "container-1";
/** Die Sitzungs-Id des HUBS. Die des Agenten sieht der Browser nie. */
export const SESSION = "hub-session-7";

export function line(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

// ---------------------------------------------------------------------------
// Das Terminal als Attrappe
// ---------------------------------------------------------------------------

export type FakeSurface = TerminalSurface & {
  log: string[];
  written: string[];
  looks: TerminalLook[];
  node: HTMLElement;
  handlers: ((data: string) => void)[];
  /** Was `fit()` das nächste Mal meldet — vom Test umstellbar. */
  measured: { cols: number; rows: number };
  /** Einen Tastenanschlag auslösen, so wie `@xterm` es täte. */
  type: (data: string) => void;
};

function fakeSurface(node: HTMLElement, look: TerminalLook): FakeSurface {
  const log: string[] = [];
  const written: string[] = [];
  const looks: TerminalLook[] = [look];
  const handlers: ((data: string) => void)[] = [];
  // Die Größe, die `fit()` meldet. Der Test stellt sie um und lässt den
  // Beobachter dann feuern — genau das, was ein Browser beim Zuklappen der
  // Seitenleiste tut.
  const measured = { cols: 100, rows: 30 };
  return {
    node,
    log,
    written,
    looks,
    handlers,
    measured,
    type: (data: string) => {
      for (const handler of handlers) handler(data);
    },
    write: (text) => {
      written.push(text);
      log.push("write");
    },
    onData: (handler) => {
      handlers.push(handler);
      log.push("onData");
    },
    apply: (next) => {
      looks.push(next);
      log.push("apply");
    },
    fit: (): TerminalSize | null => {
      log.push("fit");
      return { cols: measured.cols, rows: measured.rows };
    },
    focus: () => log.push("focus"),
    dispose: () => log.push("dispose")
  };
}

export type Lab = {
  load: SurfaceLoader;
  /** Die Zusage des Laders von Hand auflösen — der Kern von Fall 1. */
  arrive: () => void;
  built: FakeSurface[];
  readonly calls: number;
};

/**
 * Ein Lader, der erst auflöst, wenn der Test es sagt.
 *
 * ⚠️ NICHT `Promise.resolve(modul)`. Der Punkt von Fall 1 ist die Zeitspanne
 * ZWISCHEN Anfrage und Ankunft; ein sofort aufgelöster Lader hat sie nicht.
 */
export function lab(): Lab {
  const built: FakeSurface[] = [];
  const waiting: (() => void)[] = [];
  const state = { calls: 0 };

  const load: SurfaceLoader = () => {
    state.calls += 1;
    return new Promise((resolve) => {
      waiting.push(() =>
        resolve({
          createTerminalSurface: (node, look) => {
            const surface = fakeSurface(node, look);
            built.push(surface);
            return surface;
          }
        })
      );
    });
  };

  return {
    load,
    arrive: () => {
      const pending = [...waiting];
      waiting.length = 0;
      for (const resolve of pending) resolve();
    },
    built,
    get calls() {
      return state.calls;
    }
  };
}

// ---------------------------------------------------------------------------
// Der Hub als Attrappe
// ---------------------------------------------------------------------------

export type Pipe = {
  push: (chunk: Uint8Array) => void;
  finish: () => void;
  fail: (error: unknown) => void;
  state: { reads: number; cancelled: boolean };
  reader: { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel: () => Promise<void> };
};

/** Ein Rumpf, in den der Test Byte für Byte einspeist — wann er will. */
export function pipe(): Pipe {
  const queue: Uint8Array[] = [];
  const state = { reads: 0, cancelled: false };
  let waiting: {
    resolve: (value: { done: boolean; value?: Uint8Array }) => void;
    reject: (error: unknown) => void;
  } | null = null;
  let closed = false;
  let failure: unknown = null;

  return {
    state,
    push: (chunk) => {
      if (waiting !== null) {
        const pending = waiting;
        waiting = null;
        pending.resolve({ done: false, value: chunk });
        return;
      }
      queue.push(chunk);
    },
    finish: () => {
      closed = true;
      if (waiting !== null) {
        const pending = waiting;
        waiting = null;
        pending.resolve({ done: true });
      }
    },
    fail: (error) => {
      failure = error;
      if (waiting !== null) {
        const pending = waiting;
        waiting = null;
        pending.reject(error);
      }
    },
    reader: {
      read: () => {
        state.reads += 1;
        if (failure !== null) return Promise.reject(failure);
        const chunk = queue.shift();
        if (chunk !== undefined) return Promise.resolve({ done: false, value: chunk });
        if (closed) return Promise.resolve({ done: true });
        return new Promise((resolve, reject) => {
          waiting = { resolve, reject };
        });
      },
      cancel: () => {
        state.cancelled = true;
        return Promise.resolve();
      }
    }
  };
}

export type Call = { method: string; url: string; body: string | null };

export type Hub = {
  readonly body: Pipe;
  calls: Call[];
  signals: AbortSignal[];
  restore: () => void;
};

/**
 * Der Hub als Attrappe.
 *
 * `status` ist der Code VOR der ersten Zeile — der einzige Zeitpunkt, an dem
 * es überhaupt noch einen geben kann. `error` ist die Kennung im Rumpf; sie
 * und nicht der Status entscheidet an dieser Fläche über den Text.
 *
 * Die drei kurzen Routen antworten `200 { ok: true }` wie der echte Hub.
 */
export function stubHub(options: { status?: number; error?: string } = {}): Hub {
  const original = globalThis.fetch;
  // ⚠️ JE STROM EIN EIGENER RUMPF, und das ist kein Aufwand ohne Grund. Der
  // Abbruch des ERSTEN Stroms lässt seinen Rumpf abreissen; ein geteilter
  // Rumpf trüge diesen Abriss danach für immer, und der zweite Strom (nach
  // einem Klick auf „neu verbinden") endete sofort, ohne dass die Fläche etwas
  // falsch gemacht hätte. Der Fall zum Auto-Reconnect prüfte dann eine
  // Attrappe.
  const bodies: Pipe[] = [pipe()];
  const calls: Call[] = [];
  const signals: AbortSignal[] = [];
  const status = options.status ?? 200;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      method: (init?.method ?? "GET").toUpperCase(),
      url,
      body: typeof init?.body === "string" ? init.body : null
    });

    if (/\/exec\/[^/]+\/(input|size|close)$/.test(url)) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true })
      } as unknown as Response);
    }

    // Der erste Strom bekommt den Rumpf, der schon steht; jeder weitere einen
    // frischen.
    const body = signals.length === 0 ? bodies[0] : (bodies[bodies.length] = pipe());
    const signal = init?.signal;
    if (signal) {
      signals.push(signal);
      // Ein echter Rumpf reisst beim Abbruch ab. Ohne das bliebe der Leser in
      // seinem `read()` hängen.
      signal.addEventListener("abort", () => body.fail(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }

    if (status !== 200) {
      return Promise.resolve({
        ok: false,
        status,
        json: () => Promise.resolve({ error: options.error ?? "agent-unreachable", message: "Attrappe" })
      } as unknown as Response);
    }

    return Promise.resolve({
      ok: true,
      status: 200,
      body: { getReader: () => body.reader }
    } as unknown as Response);
  }) as typeof fetch;

  return {
    get body() {
      // Immer der Rumpf des ZULETZT eröffneten Stroms — das ist der, in den
      // ein Test einspeist.
      return bodies[bodies.length - 1];
    },
    calls,
    signals,
    restore: () => (globalThis.fetch = original)
  };
}

/**
 * Der Beobachter der Fläche als Attrappe.
 *
 * ⚠️ ER IST PFLICHT UND KEINE BEQUEMLICHKEIT. Gemessen am 2026-09-08 an
 * happy-dom 20: der eingebaute `ResizeObserver` ruft NIE zurück — weder nach
 * `observe()` noch nach einer Änderung von `style.width`; es gibt dort kein
 * Layout. Ohne diese Naht wäre der Weg „Fläche ändert sich, neue Größe geht an
 * den Arm" durch keinen Test gedeckt, und ein Test, der ihn nur vorgäbe, wäre
 * schlimmer als keiner.
 */
export function sizeLab(): { observeSize: SizeWatcher; change: () => void; disconnects: number } {
  const state = { onChange: null as (() => void) | null, disconnects: 0 };
  return {
    observeSize: (_node, onChange) => {
      state.onChange = onChange;
      return () => {
        state.disconnects += 1;
        state.onChange = null;
      };
    },
    change: () => state.onChange?.(),
    get disconnects() {
      return state.disconnects;
    }
  };
}

/**
 * `ShellView` as `ContainerScreen` hangs it (#261): the view is a feature and
 * takes the set of knobs as a prop, so something above it reads the provider.
 */
export function ShellWithTheme(props: {
  hostId: string;
  containerId: string;
  load?: SurfaceLoader;
  observeSize?: SizeWatcher;
}) {
  const { theme } = useGlobalTheme();
  return <ShellView {...props} theme={theme} />;
}

export async function mount(load: SurfaceLoader, observeSize?: SizeWatcher) {
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <GlobalThemeProvider>
        <ShellWithTheme hostId={HOST} containerId={CONTAINER} load={load} observeSize={observeSize} />
      </GlobalThemeProvider>
    </AppLanguageProvider>
  );
  await settle();
  return mounted;
}

/**
 * Einhängen, den Lader ankommen lassen und React eine Runde drehen — der
 * Normalfall, ab dem der Strom steht.
 */
export async function open(options: { status?: number; error?: string; observeSize?: SizeWatcher } = {}) {
  const surfaces = lab();
  const server = stubHub(options);
  const mounted = await mount(surfaces.load, options.observeSize);
  await React.act(async () => {
    surfaces.arrive();
  });
  await settle();
  return { surfaces, server, mounted };
}

/** Einspeisen und React die Runde machen lassen. */
export async function send(server: Hub, text: string): Promise<void> {
  await React.act(async () => {
    server.body.push(ENCODER.encode(text));
  });
  await settle();
}

export function at(testId: string): HTMLElement | null {
  const element = document.body.querySelector(`[data-testid="${testId}"]`);
  return element instanceof HTMLElement ? element : null;
}

export function phase(): string | null {
  return at("shell-view")?.getAttribute("data-phase") ?? null;
}

export function status(): string {
  return at("shell-status")?.textContent ?? "";
}

/** Die Aufrufe an die Stromroute — der Prüfgegenstand mehrerer Fälle. */
export function execCalls(server: Hub): Call[] {
  return server.calls.filter((call) => /\/exec$/.test(call.url));
}
