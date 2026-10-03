import {
  closeContainerExec,
  sendContainerExecInput,
  sendContainerExecSize,
  streamContainerExec
} from "./api";
import { execErrorKey } from "./shell-errors";
import { terminalFontReady } from "./terminal-font";
import type { SurfaceLoader, TerminalLook, TerminalSize, TerminalSurface } from "./terminal-look";

// One session of the shell tab, from loading the terminal to `close`: the
// stream that opens it, the input and the size that go out while it runs, and
// the close at the end. The reasons for each step stand next to it below, as
// they stood in `ShellView.tsx`.
//
// ⚠️ A PROCESS OUTSIDE REACT (#271). Until then this was the body of the
// view's mount effect. The view starts it in that effect and stops it in the
// cleanup, and hands in what it owns (the field, the look, the holders the
// size watcher shares); the effect itself calls nothing on the hub
// (`local/no-api-call-in-effect`). The same split as the stream store in
// `platform/streams/`: the module owns the stream and its cancellation, the
// view subscribes. The shell is not on the store itself: it writes into a
// terminal instead of holding lines, and it sends while it reads. Moving it
// there is open (#286).
//
// ⚠️ NO TIMER HERE EITHER. The guard against a reconnect loop
// (`web/tests/shell-guards.test.mjs`) reads this file next to the view.

/**
 * Die Größe, mit der der Strom eröffnet wird, wenn die Fläche noch keine hat.
 *
 * ⚠️ SIE IST EIN NOTNAGEL UND KEINE EINSTELLUNG. `fit()` gibt `null`, solange
 * der Knoten nicht gezeichnet ist; ohne Ersatz ginge dann `0×0` an den Arm,
 * und ein Terminal mit null Spalten zeigt nichts an, ohne kaputt auszusehen.
 * 80×24 ist die Größe, die jede PTY ohne Angabe annimmt. Sobald die Fläche
 * gemessen ist, korrigiert die `size`-Route sie.
 */
export const FALLBACK_SIZE = { cols: 80, rows: 24 };

/** Die fünf Zustände des Kopfs (Auftrag §5), plus das Nachladen davor. */
export type ShellPhase = "loading" | "load-failed" | "connecting" | "connected" | "ended" | "broken" | "rejected";

/**
 * Alles, was zu EINEM Verbindungsversuch gehört, in einem Zustand.
 *
 * ⚠️ EIN Zustand und nicht sieben — dieselbe Begründung wie beim früheren `StreamState`
 * der Log-Ansicht (bis #258 in `LogView.tsx`, seitdem im Strom-Store). `source` sagt, zu welchem Container UND zu welchem Versuch
 * dieser Stand gehört; damit braucht ein Wechsel kein Zurücksetzen im
 * Effektrumpf, und `react-hooks/set-state-in-effect` bleibt zufrieden.
 */
export type ShellState = {
  source: string;
  phase: ShellPhase;
  /** Der Name aus der `start`-Zeile — der Beleg dafür, dass die Sitzung steht. */
  containerName: string;
  /** Nur bei `ended`: die Zahl, die der Prozess zurückgegeben hat. */
  exitCode: number | null;
  /** Nur bei `rejected`: die ROHE Kennung des Hubs. */
  errorReason: string | null;
  /** Nur bei `broken` und nur, wenn eine `error`-Zeile kam: der rohe Grund. */
  failureReason: string | null;
  /**
   * Die rohe Kennung einer abgelehnten EINGABE oder GRÖSSE — der Strom läuft
   * dabei weiter.
   *
   * ⚠️ SIE STEHT NEBEN DEM KOPF UND ERSETZT IHN NICHT. Eine abgelehnte Eingabe
   * beendet die Sitzung nicht (außer der Arm hat sie selbst beendet, dann
   * kommt das über den Strom); wer sie in den Kopf schriebe, sägte an einer
   * laufenden Verbindung eine Endmeldung an.
   *
   * ⚠️ UND SIE WIRD ÜBERHAUPT GEZEIGT. Eine Eingabe, die hinausgeht und nichts
   * tut, ist der Fehler, den niemand findet: der Betreiber tippt, es passiert
   * nichts, und keine Zeile sagt warum.
   *
   * ⚠️ ZWEI EBENEN (#176): `sendError === null` heißt „nichts abgelehnt",
   * `sendError.reason === null` heißt „abgelehnt, aber ohne lesbare Kennung" —
   * ein Netzfehler etwa. Bis #176 setzte die Fläche dafür `unbekannt` ein.
   */
  sendError: { reason: string | null } | null;
};

/** Container UND Versuch zusammen — die Kennung EINES Stroms. */
export function streamKey(hostId: string, containerId: string, attempt: number): string {
  return JSON.stringify([hostId, containerId, attempt]);
}

export function freshStream(source: string): ShellState {
  return {
    source,
    phase: "loading",
    containerName: "",
    exitCode: null,
    errorReason: null,
    failureReason: null,
    sendError: null
  };
}

export type ShellSessionOptions = {
  hostId: string;
  containerId: string;
  /** The key of this attempt (`streamKey`); a state for another key counts as fresh. */
  key: string;
  /** The node the terminal is built into. */
  field: HTMLDivElement;
  load: SurfaceLoader;
  /** The look in force at the moment of building, read then and not before. */
  look: () => TerminalLook;
  /** Writes the state of the tab (the view's `setState`). */
  setState: (update: (current: ShellState) => ShellState) => void;
  /** The size last reported to the arm, shared with the size watcher of the view. */
  sentSize: { current: TerminalSize | null };
  /** Hands the size report to the view's size watcher; `() => undefined` at the end. */
  onReportSize: (report: () => void) => void;
  /** The built terminal for the view (to apply a new look), `null` at the end. */
  onSurface: (surface: TerminalSurface | null) => void;
};

/** Opens one session; the returned function ends it (close, abort, dispose). */
export function openShellSession({
  hostId,
  containerId,
  key,
  field,
  load,
  look,
  setState,
  sentSize,
  onReportSize,
  onSurface
}: ShellSessionOptions): () => void {
  const revise = (edit: (current: ShellState) => ShellState): void => {
    setState((current) => edit(current.source === key ? current : freshStream(key)));
  };

  // ⚠️ EIN HALTER UND KEINE FREIEN VARIABLEN. Alle drei Felder werden aus
  // Rückrufen heraus gesetzt, und die Aufräumfunktion liest sie später.
  // Dieselbe Bauart wie `watch` in `server/src/features/shell/routes.ts`.
  const held: { surface: TerminalSurface | null; live: boolean; session: string | null } = {
    surface: null,
    live: true,
    session: null
  };
  const controller = new AbortController();

  /**
   * Was der Betreiber erfährt, wenn eine Eingabe oder eine Größe abgelehnt
   * wird.
   *
   * ⚠️ SIE WIRD ÜBERHAUPT GEMELDET, und das ist der Punkt. Eine Eingabe, die
   * hinausgeht und nichts tut, ist der Fehler, den niemand findet: der
   * Betreiber tippt, es passiert nichts, und keine Zeile sagt warum. Ein
   * verschlucktes `catch` an dieser Stelle wäre bequem und still.
   */
  const noteSendError = (error: unknown): void => {
    if (controller.signal.aborted) return;
    revise((current) => ({ ...current, sendError: { reason: execErrorKey(error) } }));
  };

  /**
   * Die neue Größe an den Arm melden — aber nur, wenn sie eine neue ist.
   *
   * ⚠️ DER VERGLEICH GEGEN DIE ZULETZT GEMELDETE IST PFLICHT UND KEINE
   * Sparsamkeit. Ein `ResizeObserver` feuert bei jedem Bildaufbau, an dem
   * sich die Kästchen um einen Teilpixel verschieben; ohne den Vergleich
   * ginge bei jedem Ziehen am Fenster eine Anfrage an den Arm, und jede
   * davon schriebe dort einen Audit-Eintrag unter dem Namen des Betreibers.
   * In Zellen gerechnet ändert sich dabei meistens gar nichts.
   */
  const reportSize = (): void => {
    const session = held.session;
    const measured = held.surface?.fit() ?? null;
    if (session === null || measured === null) return;
    const sent = sentSize.current;
    if (sent !== null && sent.cols === measured.cols && sent.rows === measured.rows) return;
    sentSize.current = measured;
    void sendContainerExecSize(hostId, containerId, session, measured).catch(noteSendError);
  };
  onReportSize(reportSize);

  void load()
    // ⚠️ ERST DIE SCHRIFT, DANN DAS TERMINAL — `@xterm` misst die Zelle
    // beim Bau genau einmal (siehe `terminal-font.ts`).
    .then(async (module) => {
      await terminalFontReady(field, look().fontSize);
      return module;
    })
    .then((module) => {
      // ⚠️ DIE ZEILE, UM DIE ES GEHT. Ohne sie baut der zweite StrictMode-
      // Durchlauf ein Terminal in einen Knoten, den React schon entfernt
      // hat — und niemand räumt es ab.
      if (!held.live) return;
      const surface = module.createTerminalSurface(field, look());
      held.surface = surface;
      onSurface(surface);

      // ⚠️ DER EMPFÄNGER WIRD BEIM BAU ANGEMELDET UND NICHT ERST MIT DER
      // `start`-Zeile. `@xterm` nimmt Tasten entgegen, sobald es steht; ein
      // später angemeldeter Empfänger verlöre genau die Anschläge, die
      // jemand macht, während die Verbindung noch aufgeht.
      //
      // ⚠️ UND ER WIRFT SIE BIS ZUR `start`-Zeile WEG. Vor der Kopplung
      // kennt das Register des Hubs die Sitzung noch nicht und antwortete
      // `404 session-unknown` — auf einen Tastendruck, den der Mensch für
      // angekommen hält. Lieber verloren als falsch gemeldet.
      surface.onData((data) => {
        const session = held.session;
        if (session === null) return;
        // ⚠️ DER ROHE TEXT GEHT HINAUS, NICHT DIE KODIERUNG. `sendContainerExecInput`
        // kodiert selbst (`base64OfText` in `api.ts`) — was der Typ
        // nicht zulässt, kann diese Stelle nicht vergessen.
        void sendContainerExecInput(hostId, containerId, session, data).catch(noteSendError);
      });

      // ⚠️ ERST MESSEN, DANN VERBINDEN. Die Größe des Terminals IST die
      // Eröffnungsangabe des Stroms; eine Verbindung, die vor dem ersten
      // `fit()` aufginge, meldete dem Arm eine Größe, die die Fläche nie
      // hatte, und die erste Zeile käme umgebrochen an.
      const size = surface.fit() ?? FALLBACK_SIZE;
      // ⚠️ DIE ERÖFFNUNGSGRÖSSE GILT ALS BEREITS GEMELDET. Sie steht im
      // Rumpf des `POST`, den `streamContainerExec` gleich schickt; ohne
      // diese Zeile hielte `reportSize` sie für neu und schickte unmittelbar
      // nach der `start`-Zeile dieselben Zahlen ein zweites Mal — eine
      // Anfrage und ein Audit-Eintrag beim Arm für nichts.
      sentSize.current = size;
      revise((current) => ({ ...current, phase: "connecting" }));

      void streamContainerExec(
        hostId,
        containerId,
        {
          signal: controller.signal,
          cols: size.cols,
          rows: size.rows,
          onStart: (start) => {
            // ⚠️ DIE SITZUNGS-ID GEHT IN EINEN `ref` UND NICHT IN DEN
            // ZUSTAND. Die Aufräumfunktion braucht sie, um `close` zu rufen;
            // ein Zustand wäre dort der von vor dem letzten Zeichnen. Und
            // sie steht in nichts, was der Browser ZEIGT — sie ist ein
            // Schlüssel und keine Auskunft.
            held.session = start.session;
            revise((current) => ({ ...current, phase: "connected", containerName: start.containerName }));
            // ⚠️ EIN ABGLEICH UND KEINE ZWEITE MELDUNG DERSELBEN GRÖSSE.
            // Zwischen dem Eröffnen und der `start`-Zeile liegt der Aufbau
            // der Verbindung zum Container — die langsamste Stelle des
            // ganzen Vorgangs. In dieser Zeit bekommt die Fläche ihre echte
            // Höhe (Schriften laden, der Kasten wächst), und die Größe im
            // Rumpf der Eröffnung war die von davor. `reportSize` schickt
            // nur, wenn sie sich wirklich geändert hat.
            reportSize();
          },
          onEnd: (end) => {
            // ⚠️ ZWEI AUSGÄNGE UND NICHT EINER. Eine Zahl heißt: der Prozess
            // ist von selbst zu Ende gegangen. `null` heißt: der Agent hat
            // abgeriegelt, und welches seiner beiden Zeitlimits, weiß hier
            // niemand. Wer beide gleich beschriftet, behauptet eine Auskunft.
            held.session = null;
            revise((current) =>
              end.exitCode === null
                ? { ...current, phase: "broken", exitCode: null }
                : { ...current, phase: "ended", exitCode: end.exitCode }
            );
          },
          onFailure: (failure) => {
            held.session = null;
            revise((current) => ({ ...current, phase: "broken", failureReason: failure.reason }));
          }
        },
        (text) => held.surface?.write(text)
      )
        .then(() => {
          // Ein Strom, der ohne `end` und ohne `error` aufhört, ist
          // trotzdem zu Ende. Ohne diese Zeile bliebe der Kopf für immer auf
          // „verbindet" stehen, und der Mensch wartete auf etwas, das nicht
          // mehr kommt.
          if (controller.signal.aborted) return;
          revise((current) =>
            current.phase === "connecting" || current.phase === "connected"
              ? { ...current, phase: "broken" }
              : current
          );
        })
        .catch((error: unknown) => {
          // ⚠️ HIERHER KOMMT NUR, WAS VOR DER ERSTEN ZEILE SCHIEFGING.
          // Danach steht der Status fest, und ein Fehler reist als
          // `{"kind":"error"}` durch `onFailure`.
          if (controller.signal.aborted) return;
          revise((current) => ({ ...current, phase: "rejected", errorReason: execErrorKey(error) }));
        });
    })
    .catch(() => {
      if (!held.live) return;
      // Ein Nachladen, das nicht ankommt, ist der Fall, den ein Mensch am
      // ehesten selbst beheben kann (neu laden, Netz prüfen) — wenn ihm
      // jemand sagt, dass es das war. Ein leerer Kasten sagt es nicht.
      revise((current) => ({ ...current, phase: "load-failed" }));
    });

  return () => {
    held.live = false;
    const session = held.session;
    held.session = null;
    sentSize.current = null;
    onReportSize(() => undefined);

    // ⚠️ `close` IST PFLICHT UND KEINE HÖFLICHKEIT — und es geht VOR dem
    // Abbruch hinaus. Der Hub bindet die Sitzung an `response.on("close")`
    // seiner Stromroute; das greift, sobald der `fetch` abbricht. Darauf
    // darf sich diese Seite aber nicht verlassen: ein Zwischenglied kann
    // einen abgerissenen Browser spät oder gar nicht weitergeben, und eine
    // Sitzung, die niemand schließt, belegt einen von VIER Plätzen des
    // ganzen Arms, bis der Agent nach 30 Minuten selbst abriegelt.
    //
    // ⚠️ DER FEHLER WIRD VERSCHLUCKT, und das ist Absicht. Kommt der Abbruch
    // beim Hub zuerst an, hat er den Eintrag schon entfernt und antwortet
    // `404 session-unknown` — auf einen Reiter, den es nicht mehr gibt. Eine
    // Meldung dazu hätte keinen Leser.
    if (session !== null) {
      void closeContainerExec(hostId, containerId, session).catch(() => undefined);
    }

    controller.abort();
    held.surface?.dispose();
    held.surface = null;
    onSurface(null);
  };
}
