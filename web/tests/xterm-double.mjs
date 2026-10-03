// Die Doppel für `@xterm/xterm` und `@xterm/addon-fit` — Paket B6, Etappe E8
// (#5), Berichtigung nach der unabhängigen Prüfung.
//
// ⚠️ DER DATEINAME TRÄGT KEIN `.test.` — sonst sammelte der Lauf die
// Hilfsdatei als Testdatei ein und meldete „keine Tests" (dieselbe Falle wie
// bei `dom-harness.tsx` und `strip-comments.mjs`).
//
// WOZU SIE DA SIND. `web/src/features/shell/terminal-surface.ts` ist
// die einzige Datei des Bestands, die `@xterm` anfasst. Sie war bis zum
// 2026-09-08 von KEINEM Testfall berührt: die unabhängige Prüfung hat
// `fontSize: 999` fest eingesetzt, und die volle Web-Suite blieb bei
// 415/415/0. Alle Fälle fahren über den eingespeisten Lader `loadSurface` des
// Reiters und sehen die Datei nie.
//
// ⚠️ WAS HIER DOPPEL IST UND WAS NICHT, und das ist der ganze Unterschied
// zwischen einem Prüfstand und einer Vorführung: geprüft wird die ECHTE Datei
// — `terminal-surface.ts` wird unverändert geladen und ausgeführt. Doppel sind
// nur ihre beiden fremden Abhängigkeiten. Ein Test, der stattdessen eine
// nachgebaute Fläche prüfte, prüfte sich selbst; das Repo hat dafür die
// Warnung im Kopf von `log-view.test.tsx` und die Zeile in `terminal-look.ts`:
// „eine Attrappe, die ein halbes `@xterm` nachbaut, prüft am Ende sich
// selbst".
//
// ⚠️ UND DESHALB BAUEN DIESE DOPPEL NICHTS NACH. Sie zeichnen auf, was die
// Datei ihnen reicht, und geben zurück, was der Test ihnen vorlegt. Sie
// entscheiden nichts. Was `@xterm` mit den Werten TUT, sagt kein Doppel — das
// hält der letzte Fall in `terminal-surface.test.mjs` gegen die echte
// Bibliothek, und was auch der nicht erreicht, steht dort namentlich als Lücke.

/**
 * Was in diesem Lauf gebaut wurde.
 *
 * Die Datei unter Prüfung gibt ihr `Terminal` nicht heraus (`TerminalSurface`
 * hat bewusst keinen Durchgriff), also ist dieses Verzeichnis der einzige Weg,
 * von außen an das Gebaute zu kommen.
 */
export const record = {
  /** @type {TerminalDouble[]} */
  terminals: [],
  /** @type {FitAddonDouble[]} */
  fitAddons: []
};

/** Vor jedem Fall leeren — sonst zählt ein Fall die Terminals des vorigen mit. */
export function reset() {
  record.terminals.length = 0;
  record.fitAddons.length = 0;
}

/**
 * Das Doppel für `Terminal`.
 *
 * ⚠️ `options` HAT NUR EINEN LESER UND KEINEN SCHREIBER, und das ist kein
 * Versehen: bei `@xterm` ist `options` ein Objekt mit Settern je Feld, und der
 * Kommentar an `apply` in der geprüften Datei sagt ausdrücklich, ein
 * `terminal.options = { … }` ginge an ihnen vorbei und käme im Bild nicht an.
 * Hier wirft dieselbe Zuweisung — ES-Module laufen streng — und der Fall über
 * `apply` wird rot, statt still eine Fassung durchzulassen, die im Browser
 * nichts täte. Ein Proxy dahinter zeichnet jede EINZELNE Zuweisung auf.
 */
export class TerminalDouble {
  /** @type {Record<string, unknown>} */
  #options;

  /** @param {Record<string, unknown>} given */
  constructor(given) {
    /** Was beim Bau hineingereicht wurde — roh, ohne jede Nachbearbeitung. */
    this.given = given;
    /** Jede spätere Zuweisung an `options`, in ihrer Reihenfolge. */
    /** @type {[string, unknown][]} */
    this.assigned = [];
    /** @type {unknown[]} */
    this.opened = [];
    /** @type {string[]} */
    this.written = [];
    /** @type {((data: string) => void)[]} */
    this.dataHandlers = [];
    /** @type {unknown[]} */
    this.addons = [];
    this.focusCount = 0;
    this.disposeCount = 0;
    // Die Zellenmaße. Sie stehen hier auf einem Wert, den kein Terminal hat,
    // damit ein Fall, der sie nicht selbst setzt, nicht versehentlich grün
    // wird.
    this.cols = -1;
    this.rows = -1;

    const assigned = this.assigned;
    this.#options = new Proxy(
      { ...given },
      {
        set(target, key, value) {
          assigned.push([String(key), value]);
          target[key] = value;
          return true;
        }
      }
    );
    record.terminals.push(this);
  }

  get options() {
    return this.#options;
  }

  /** @param {{ activate?: (terminal: TerminalDouble) => void }} addon */
  loadAddon(addon) {
    this.addons.push(addon);
    if (typeof addon.activate === "function") addon.activate(this);
  }

  /** @param {unknown} node */
  open(node) {
    this.opened.push(node);
  }

  /** @param {string} text */
  write(text) {
    this.written.push(text);
  }

  /** @param {(data: string) => void} handler */
  onData(handler) {
    this.dataHandlers.push(handler);
  }

  focus() {
    this.focusCount += 1;
  }

  dispose() {
    this.disposeCount += 1;
  }
}

/**
 * Das Doppel für `FitAddon`.
 *
 * `proposal` legt der Test vor: `undefined` ist der gemessene Zustand einer
 * Fläche ohne Layout (siehe den letzten Fall in `terminal-surface.test.mjs`,
 * der das an der echten Bibliothek nachschlägt).
 *
 * `afterFit` setzt beim `fit()` die Zellenmaße des Terminals. Damit lässt sich
 * belegen, dass die geprüfte Datei die Größe NACH dem Anpassen vom Terminal
 * abliest und nicht den Vorschlag zurückgibt — zwei Fassungen, die sich sonst
 * nicht unterscheiden ließen.
 */
export class FitAddonDouble {
  constructor() {
    /** @type {TerminalDouble | null} */
    this.terminal = null;
    /** @type {{ cols: number, rows: number } | undefined} */
    this.proposal = undefined;
    /** @type {{ cols: number, rows: number } | null} */
    this.afterFit = null;
    this.proposeCount = 0;
    this.fitCount = 0;
    record.fitAddons.push(this);
  }

  /** @param {TerminalDouble} terminal */
  activate(terminal) {
    this.terminal = terminal;
  }

  proposeDimensions() {
    this.proposeCount += 1;
    return this.proposal;
  }

  fit() {
    this.fitCount += 1;
    if (this.afterFit !== null && this.terminal !== null) {
      this.terminal.cols = this.afterFit.cols;
      this.terminal.rows = this.afterFit.rows;
    }
  }
}

// Unter den Namen, unter denen die geprüfte Datei sie importiert. Der Lader
// daneben (`xterm-stub-loader.mjs`) reicht genau diese zwei weiter.
export { TerminalDouble as Terminal, FitAddonDouble as FitAddon };
