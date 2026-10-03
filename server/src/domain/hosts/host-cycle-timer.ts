// Der Zeitgeber des Hintergrundlaufs — und sonst nichts.
//
// ⚠️ EIN ZEITGEBER IST DER TEIL, DEN MAN AM SCHLECHTESTEN PRÜFEN KANN. Deshalb
// steht hier möglichst wenig: der Riegel gegen überlappende Läufe, das
// Abschalten bei Intervall 0, das `unref()` und das Fangen. Was ein Durchlauf
// TUT, steht in `host-cycle.ts` und wird dort gegen Attrappen geprüft.
//
// Die zwei Hälften sind absichtlich getrennt: `createCycleRunner` ist ohne
// jede Uhr prüfbar (man ruft `trigger()` von Hand auf), und `startCycleTimer`
// enthält danach keine Entscheidung mehr, die schiefgehen könnte.

export type CycleRunnerOptions = {
  // Der Durchlauf. Er darf ablehnen; genau dafür gibt es `onError`.
  run: () => Promise<unknown>;
  // ⚠️ PFLICHT und nicht optional. Ein unbehandelter Fehler in einem Zeitgeber
  // beendet den Prozess — ein Hub, der nachts an einem unerreichbaren Arm
  // stirbt, ist schlimmer als einer ohne Lauf. Ein optionales Feld hier hieße,
  // dass ein Aufrufer diesen Fall vergessen darf.
  onError: (error: unknown) => void;
  // Wird gerufen, wenn ein Tick auf einen noch laufenden Durchlauf trifft.
  onOverlap?: () => void;
};

export type CycleRunner = {
  // Löst einen Durchlauf aus, wenn keiner läuft. Wirft nie und gibt nichts
  // zurück — der Zeitgeber hat niemanden, dem er ein Versprechen reichen
  // könnte.
  trigger: () => void;
  isRunning: () => boolean;
};

/**
 * Der Riegel: KEIN ZWEITER DURCHLAUF, SOLANGE EINER LÄUFT.
 *
 * ⚠️ Ohne ihn stapeln sich die Läufe. Ein Arm mit Frist 3 s und zwanzig Armen
 * kann länger dauern als das Intervall; jeder Tick startete dann einen
 * weiteren, und die Zahl der gleichzeitigen Abfragen gegen denselben Agenten
 * wüchse, bis der Hub keine Verbindungen mehr bekommt. Das ist kein
 * theoretischer Fall — es ist der Normalfall, sobald ein Arm nicht antwortet.
 *
 * Ein übersprungener Tick wird NICHT nachgeholt. Der Durchlauf liest ohnehin
 * jedes Mal den vollen Bestand; ein nachgeholter Lauf brächte dieselbe Antwort
 * und dieselbe Wartezeit noch einmal.
 */
export function createCycleRunner(options: CycleRunnerOptions): CycleRunner {
  let running = false;

  return {
    isRunning: () => running,
    trigger: () => {
      if (running) {
        options.onOverlap?.();
        return;
      }
      running = true;
      // ⚠️ `void` und ein `finally`, das den Riegel IMMER löst. Bliebe er nach
      // einem abgelehnten Durchlauf gesetzt, wäre der Lauf ab dem ersten
      // Fehler dauerhaft tot — und zwar lautlos, weil der Zeitgeber weiter
      // tickte.
      void options
        .run()
        .catch((error: unknown) => {
          options.onError(error);
        })
        .finally(() => {
          running = false;
        });
    }
  };
}

/**
 * Der Griff auf einen laufenden Zeitgeber.
 *
 * Absichtlich schmal: `unref` ist das Einzige, was diese Datei von einem
 * `NodeJS.Timeout` braucht, und ein Test speist damit eine Attrappe aus zwei
 * Zeilen ein statt einer nachgebauten Node-Uhr.
 */
export type IntervalHandle = { unref?: () => void };

export type CycleTimerOptions = {
  // 0 schaltet den Lauf ab. Das ist die Bremse für den Fall, dass er sich als
  // Fehler erweist — sie steht in der Umgebung und braucht keinen neuen Bau.
  intervalMs: number;
  runner: CycleRunner;
  setIntervalImpl?: (handler: () => void, ms: number) => IntervalHandle;
  clearIntervalImpl?: (handle: IntervalHandle) => void;
};

export type CycleTimer = {
  // Ob tatsächlich ein Zeitgeber läuft. `false` bei Intervall 0 — der
  // Aufrufer meldet das dem Betreiber, statt einen abgeschalteten Lauf für
  // einen laufenden zu halten.
  started: boolean;
  stop: () => void;
};

export function startCycleTimer(options: CycleTimerOptions): CycleTimer {
  if (options.intervalMs <= 0) {
    return { started: false, stop: () => undefined };
  }

  const setImpl = options.setIntervalImpl ?? ((handler, ms) => setInterval(handler, ms));
  // Die Umkehrung zum Vorgabewert oben. Der Griff ist hier absichtlich schmal
  // typisiert; `clearInterval` will den vollen Node-Typ, und die Umdeutung
  // steht deshalb an genau dieser einen Stelle.
  const clearImpl =
    options.clearIntervalImpl ?? ((handle: IntervalHandle) => clearInterval(handle as NodeJS.Timeout));

  const handle = setImpl(() => {
    options.runner.trigger();
  }, options.intervalMs);

  // ⚠️ Ohne `unref()` hält der Zeitgeber den Prozess am Leben: `node` beendet
  // sich erst, wenn keine offene Uhr mehr da ist. Ein Testlauf, der diesen
  // Zeitgeber startet, hinge damit bis zum Zeitüberschreitungs-Abbruch.
  handle.unref?.();

  return {
    started: true,
    stop: () => {
      clearImpl(handle);
    }
  };
}
