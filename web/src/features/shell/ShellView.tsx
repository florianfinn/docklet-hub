import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";

import {
  TERMINAL_SCROLLBACK_STEPS,
  TERMINAL_SIZE_STEPS,
  type GlobalThemePreset
} from "contract";
import { Button } from "../../platform/ui/shadcn/button";
import { shellErrorMessageKey, shellFailureMessageKey } from "./shell-errors";
import { freshStream, openShellSession, streamKey, type ShellPhase, type ShellState } from "./shell-session";
import { canvasColorConverter, readTerminalPalette, type ColorConverter } from "./terminal-theme";
import type {
  SizeWatcher,
  SurfaceLoader,
  TerminalLook,
  TerminalSize,
  TerminalSurface
} from "./terminal-look";

// Der Reiter „Shell" (Paket B6, Etappe E6, #5) — das Terminal eines
// Containers.
//
// ⚠️ DIESES BAUTEIL IST NICHT DIE CONTAINER-DETAILSEITE, dieselbe Trennung wie
// bei `LogView`: es bekommt zwei Kennungen und zeigt ein Terminal. Der Rahmen
// gehört dem Ort, an dem es hängt.
//
// ── DAS NACHLADEN — DIE ERSTE STELLE IM BESTAND ────────────────────────────
//
// Gemessen am 2026-09-08 auf `90fb084`: unter `web/src` gibt es kein
// `React.lazy`, kein `Suspense` und kein `import(…)`. Es gibt also kein
// Vorbild, und deshalb steht die Wahl hier begründet statt still.
//
// GEWÄHLT: ein `await` auf einen Lader im EINHÄNGE-EFFEKT, der Ladezustand in
// dem `useState`, das der Reiter ohnehin führt.
// VERWORFEN: `React.lazy` + `Suspense`. Es gäbe beides im ganzen Bestand kein
// zweites Mal, und es kaufte nichts: `@xterm` hängt sich IMPERATIV an einen
// DOM-Knoten, das muss ohnehin in einem Effekt geschehen. Mit `Suspense` läge
// der Ladezustand an einer zweiten Stelle (der Grenze) und der Aufbau an
// dieser — zwei Orte für einen Vorgang.
//
// Und das Nachladen ist hier kein Kunstgriff, sondern das vorhandene Muster:
// `ContainerScreen` hängt NUR den geltenden Reiter ein (Zusage, kein `hidden`),
// also läuft dieser Effekt genau dann, wenn jemand die Shell öffnet.
//
// ⚠️ DIE FALLE DES DYNAMISCHEN IMPORTS: ER LÖST NACH DEM AUSHÄNGEN AUF. Wer
// danach ein Terminal baut, hängt es in einen Knoten, den React entfernt hat —
// und im StrictMode passiert das bei JEDEM Einhängen einmal, denn React fährt
// den Effekt zweimal. Deshalb steht hinter dem `await` als erstes die Frage,
// ob dieser Effekt überhaupt noch gilt. Der Fall steht als eigener Test
// (`web/tests/shell-view.test.tsx`).
//
// ── KEIN AUTO-RECONNECT ────────────────────────────────────────────────────
//
// Entscheidung des Betreibers, wörtlich aus dem Quellsystem übernommen: DIESER
// REITER VERBINDET SICH NIE VON SELBST NEU. Ein Mensch drückt die Schaltfläche.
//
// Eine Shell ist die stärkste Fähigkeit dieses Systems, und eine
// Wiederverbindungsschleife wäre nicht bloß unhöflich, sondern gefährlich:
//
//   * Sie belegte die Plätze des Arms. Der Agent führt VIER Exec-Sitzungen
//     gleichzeitig, für alle Menschen zusammen, und zwei je Mensch. Ein
//     vergessener Reiter, der alle paar Sekunden neu anklopft, sperrte die
//     Shell für alle anderen.
//   * Sie schriebe bei jedem Versuch einen Audit-Eintrag unter dem Namen eines
//     Menschen, der gar nicht am Rechner sitzt.
//   * Sie öffnete eine Shell erneut, deren Recht inzwischen entzogen sein
//     kann — der Hub prüft es neben der laufenden Verbindung nach und beendet
//     sie dann mit `error: permission-revoked`. Ein Neuversuch machte aus dem
//     Entzug eine Warteschleife.
//
// Gebaut ist das als ZÄHLWERK in den Abhängigkeiten des Effekts: `attempt`
// wächst ausschließlich im `onClick` der Schaltfläche. Ein Test zählt die
// `fetch`-Aufrufe nach einem `end` (Baustein 6) — am Augenschein wäre es
// nicht zu sehen.

/**
 * Wie der Reiter an `@xterm` kommt.
 *
 * ⚠️ EINE ANGABE MIT VORGABEWERT UND KEIN FESTER IMPORT, und der Grund ist
 * nicht Bequemlichkeit: die nachgeladene Datei importiert
 * `@xterm/xterm/css/xterm.css`, und der Testlauf fährt unter `tsx`, das eine
 * CSS-Datei nicht lesen kann. Ein Test, der den echten Lader zöge, stürbe an
 * der Fremd-CSS und nicht an dieser Fläche. Dieselbe Naht wie `schedule` in
 * `server/src/features/shell/routes.ts` und `probeHost` in
 * `server/src/domain/hosts/container-access.ts`:
 * die Vorgabe ist der Betriebsweg, die Angabe ist der Prüfstand.
 *
 * Der echte Lader steht damit unter `tsc` und unter `vite build`, aber nicht
 * unter `node --test`. Was das ungeprüft lässt, steht in der Rückmeldung
 * dieser Etappe.
 */
const loadSurface: SurfaceLoader = () => import("./terminal-surface");

/**
 * Wie der Reiter erfährt, dass seine Fläche eine andere Größe hat.
 *
 * Die Begründung für die Naht steht am Typ `SizeWatcher`; sie ist dieselbe
 * wie beim Lader — happy-dom kann es nicht, und ohne Naht wäre der Weg
 * ungeprüft.
 */
const watchSize: SizeWatcher = (node, onChange) => {
  const observer = new ResizeObserver(() => onChange());
  observer.observe(node);
  return () => observer.disconnect();
};


export function ShellView({
  hostId,
  containerId,
  theme,
  load = loadSurface,
  observeSize = watchSize
}: {
  hostId: string;
  containerId: string;
  /**
   * The set of global knobs in force, handed in by the screen that hangs this
   * view (#261).
   *
   * ⚠️ A PROP AND NOT `useGlobalTheme()`. The provider lives in `appearance/`
   * and also saves to the server; a feature imports neither (layers app →
   * features → domain → platform). The screen reads the context, and a new
   * object here is what re-reads the palette (the effect below), as the
   * context value was before.
   */
  theme: GlobalThemePreset;
  load?: SurfaceLoader;
  observeSize?: SizeWatcher;
}) {
  const t = useTranslations();
  const fontSize = pixelsOf(theme.terminalSize);
  const scrollback = linesOf(theme.terminalScrollback);

  // ⚠️ DAS ZÄHLWERK IST DIE GANZE WIEDERVERBINDUNG. Es wächst nur im `onClick`
  // der Schaltfläche; nichts im Strom fasst es an. Deshalb steht in diesem
  // Bauteil kein einziger Zeitgeber und kein `catch`, der neu anfängt.
  const [attempt, setAttempt] = useState(0);
  const source = streamKey(hostId, containerId, attempt);
  const [stream, setStream] = useState<ShellState>(() => freshStream(source));

  const fieldRef = useRef<HTMLDivElement | null>(null);
  // ⚠️ DAS ABLESEELEMENT. Es trägt je Farbe kurz die Variable als echte
  // CSS-Eigenschaft, damit der gerechnete Wert abgelesen werden kann — der
  // Weg aus `DotWave.tsx`, der einzige im Bestand.
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const surfaceRef = useRef<TerminalSurface | null>(null);

  // ⚠️ DER UMRECHNER WIRD EINMAL GEBAUT UND NICHT JE FARBE. Er hält eine
  // Leinwand; einundzwanzig davon je Wechsel des Themes wären einundzwanzig
  // Leinwände, die niemand wieder abräumt.
  //
  // ⚠️ UND ER WIRD ERST BEIM ERSTEN LESEN GEBAUT. Im Rumpf der Komponente
  // stünde ein `document.createElement` im Rendern; der Wert eines `useRef`
  // wird bei jedem Zeichnen ausgewertet, auch wenn er nur einmal gilt.
  const converterRef = useRef<{ convert: ColorConverter | null } | null>(null);
  // Die zuletzt an den Arm gemeldete Größe. `null` heißt: noch keine.
  const sentSizeRef = useRef<TerminalSize | null>(null);

  // ⚠️ DER BEOBACHTER DER FLÄCHE UND DER STROM SIND ZWEI EFFEKTE, und die
  // Meldung der Größe gehört dem Strom: nur dort ist die Sitzung bekannt.
  // Dieser Halter reicht sie hinüber. Der Vorgabewert tut nichts — solange
  // keine Sitzung läuft, gibt es auch nichts zu melden.
  const reportSizeRef = useRef<() => void>(() => undefined);

  /**
   * Das ganze Aussehen aus dem geltenden Theme.
   *
   * ⚠️ ES WIRD BEIM ZEICHNEN GERECHNET UND NICHT IN EINEM EFFEKT. Der Effekt
   * darunter braucht es, und `theme` ist seine Abhängigkeit; ein `useMemo`
   * darum wäre eine zweite Buchführung über dieselbe Frage.
   *
   * ⚠️ DIE PALETTE KOMMT NUR ZUSTANDE, WENN DAS ABLESEELEMENT SCHON STEHT.
   * Beim allerersten Zeichnen gibt es den Knoten noch nicht; dann bleibt sie
   * leer, und `@xterm` behält bis zum ersten Effekt seine Vorgabe. Das ist
   * genau ein Bildaufbau lang und kein sichtbarer Zustand — der Effekt setzt
   * sie unmittelbar danach.
   */
  const readLook = (): TerminalLook => {
    const probe = probeRef.current;
    if (probe === null) return { fontSize, scrollback, palette: {} };
    if (converterRef.current === null) converterRef.current = { convert: canvasColorConverter() };
    return { fontSize, scrollback, palette: readTerminalPalette(probe, converterRef.current.convert) };
  };

  // ⚠️ DAS AUSSEHEN STEHT IM `ref` UND NICHT IN DEN ABHÄNGIGKEITEN DES
  // AUFBAU-EFFEKTS. Ein Wechsel der Schriftgröße darf das Terminal nicht neu
  // bauen — der Verlauf wäre weg und die Sitzung mit ihm. Der Aufbau braucht
  // den Stand trotzdem, und zwar den zum Zeitpunkt des Aufbaus.
  //
  // ⚠️ GESCHRIEBEN WIRD IM EFFEKT UND NICHT IM RUMPF DER KOMPONENTE. Eine
  // Zuweisung an `.current` während des Zeichnens ist eine Nebenwirkung im
  // Rendern; `react-hooks` weist sie zu Recht ab. Dieser Effekt steht VOR dem
  // Aufbau-Effekt, und React fährt Effekte in der Reihenfolge ihrer
  // Anmeldung — beim ersten Einhängen steht der Wert also, bevor der Aufbau
  // ihn liest.
  const lookRef = useRef<TerminalLook>({ fontSize, scrollback, palette: {} });
  useEffect(() => {
    lookRef.current = readLook();
  });

  // ⚠️ DIE ÄNDERUNG ERFÄHRT DIESE FLÄCHE ÜBER `theme` (DEN KONTEXT DES
  // ANBIETERS, VOM BILDSCHIRM GEREICHT) UND NICHT ÜBER EINEN BEOBACHTER AM
  // ATTRIBUT. `GlobalThemeProvider` hält den Satz im Zustand und
  // schreibt ihn auf `document.documentElement`; einen `MutationObserver`
  // darauf gibt es im ganzen Bestand nicht, und er wäre die zweite Quelle für
  // eine Auskunft, die als Kontext danebensteht.
  //
  // ⚠️ ABGELESEN WIRD ERST IM EFFEKT UND NICHT SCHON IM RUMPF. Der Anbieter
  // setzt die Attribute selbst in einem Effekt; wer beim Zeichnen abliest,
  // bekommt die Farben des VORIGEN Satzes und schreibt sie fest.
  //
  // ⚠️ UND DAS TERMINAL WIRD DABEI NICHT NEU GEBAUT. `apply` setzt die drei
  // Optionen an einem stehenden `Terminal`; ein Neuaufbau nähme dem Menschen
  // den Verlauf und die Sitzung, weil eine Schriftgröße sich geändert hat.
  useEffect(() => {
    const next = readLook();
    lookRef.current = next;
    surfaceRef.current?.apply(next);
    // `readLook` wird bei jedem Zeichnen neu gebaut und gehört deshalb nicht in
    // die Abhängigkeiten; was diesen Effekt auslöst, ist der Satz des Themes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  // ⚠️ EIN FREMDER STAND WIRD NICHT ANGEZEIGT statt zurückgesetzt. Trägt der
  // gehaltene Stand eine andere Kennung, gehört er zum vorigen Container oder
  // zum vorigen Versuch; ein frischer tritt an seine Stelle, bis die erste
  // Rückmeldung da ist. Ein `setState` im Effektrumpf täte dasselbe eine Runde
  // später und ließe den Baum zweimal rechnen (`LogView.tsx`).
  const view = stream.source === source ? stream : freshStream(source);

  useEffect(() => {
    const field = fieldRef.current;
    if (field === null) return;
    // The session lives in `shell-session.ts` since #271; this effect starts
    // it and its cleanup ends it.
    return openShellSession({
      hostId,
      containerId,
      key: streamKey(hostId, containerId, attempt),
      field,
      load,
      look: () => lookRef.current,
      setState: setStream,
      sentSize: sentSizeRef,
      onReportSize: (report) => {
        reportSizeRef.current = report;
      },
      onSurface: (surface) => {
        surfaceRef.current = surface;
      }
    });
    // ⚠️ `attempt` STEHT HIER, UND DAS IST DIE GANZE WIEDERVERBINDUNG.
    // `theme` steht bewusst NICHT darin (siehe `lookRef` oben) — eine
    // Schriftgröße darf keine Sitzung beenden.
  }, [hostId, containerId, attempt, load]);

  // ⚠️ DIE GRÖSSE FOLGT DER FLÄCHE UND NICHT DEM FENSTER. Die Seitenleiste
  // klappt zu, ein Reiter daneben wird breiter, der Browser zoomt — nichts
  // davon löst ein `resize` am Fenster aus, und ein Terminal mit falscher
  // Spaltenzahl bricht jede Zeile an der falschen Stelle um.
  //
  // ⚠️ DIESER EFFEKT MELDET SELBST NICHTS AN DEN ARM. Er ruft die Funktion,
  // die der Stromeffekt hinterlegt hat — dort steht die Sitzung, und nur dort
  // ist bekannt, ob überhaupt eine läuft. Ein zweiter Sendeweg neben ihm wäre
  // die Stelle, an der eines Tages eine Größe an eine geschlossene Sitzung
  // geht.
  useEffect(() => {
    const field = fieldRef.current;
    if (field === null) return;
    return observeSize(field, () => reportSizeRef.current());
  }, [observeSize]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2" data-testid="shell-view" data-phase={view.phase}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[13px] text-subtle-foreground" data-testid="shell-status">
          {headline(t, view)}
        </span>

        {/* ⚠️ DIE SCHALTFLÄCHE IST DER EINZIGE WEG ZURÜCK. Sie steht nur da,
            wenn es nichts mehr zu tun gibt — bei einem laufenden Strom wäre
            sie eine Einladung, die eigene Sitzung wegzuwerfen und einen
            zweiten der vier Plätze zu belegen. */}
        {isOver(view.phase) ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="shell-reconnect"
            onClick={() => setAttempt((current) => current + 1)}
          >
            {t("shellReconnect")}
          </Button>
        ) : null}
      </div>

      {/* ⚠️ EINE ZWEITE MELDUNG NEBEN DEM KOPF UND NICHT IN IHM. Eine
          abgelehnte Eingabe beendet die Sitzung nicht; wer sie in den Kopf
          schriebe, hängte an eine laufende Verbindung eine Endmeldung. Und
          gemeldet wird sie überhaupt, weil eine Eingabe, die hinausgeht und
          nichts tut, der Fehler ist, den niemand findet. */}
      {view.sendError === null ? null : (
        <p role="alert" className="text-[13px] text-state-warn" data-testid="shell-send-error">
          {rejectionText(t, view.sendError.reason)}
        </p>
      )}

      {view.phase === "load-failed" ? (
        <p role="alert" className="text-[13px] text-destructive" data-testid="shell-load-failed">
          {t("shellLoadFailed")}
        </p>
      ) : null}

      {/* ⚠️ DER KNOTEN STEHT IMMER DA, AUCH WÄHREND DES LADENS. `@xterm`
          hängt sich an ein vorhandenes Element; ein Knoten, der erst mit dem
          fertigen Terminal entstünde, gäbe es in dem Augenblick nicht, in dem
          der Lader zurückkommt. */}
      {/* ⚠️ DAS ABLESEELEMENT. Es zeigt nichts und misst nur: je Farbe trägt
          es kurz `color: var(--terminal-…)`, und abgelesen wird der GERECHNETE
          Wert. `aria-hidden`, weil es für einen Screenreader nichts ist.

          ⚠️ ES STEHT INNERHALB DIESES BAUMS und nicht am `body`: die
          `--terminal-*`-Werte hängen an `<html>`, aber ein Arm oder eine Marke
          kann eine Palette an einem Teilbaum umschreiben (`palette.css`). Ein
          Ableseelement weiter oben läse dann die Farben des Hauses statt die
          dieser Fläche.

          ⚠️ NICHT `display: none`. Ein Element ohne Darstellung hat keinen
          gerechneten Stil, und `getComputedStyle` gäbe für jede Farbe die
          leere Zeichenkette zurück — die Palette bliebe leer, und niemand
          merkte es. */}
      <span ref={probeRef} aria-hidden="true" data-testid="shell-token-probe" className="sr-only" />

      {/* ⚠️ ZWEI KNOTEN, UND DER RAHMEN HAT EINE FESTE HÖHE. Gemessen am
          2026-09-29 in Chromium mit `@xterm/xterm` 5.5.0 und `addon-fit`
          0.10.0 in der Elternkette dieser Seite: stand das Terminal direkt in
          einem Knoten mit `p-2` und Rahmen, schlug `proposeDimensions` bei
          25 Zeilen 26 vor, dann 27, … — Fläche 393 → 408 → … → 498 px. Der
          Addon zieht nur das Padding des Terminals selbst ab, nicht das des
          Elternknotens, und unter `border-box` enthält dessen Höhe 18 px aus
          Padding und Rahmen — mehr als eine Zeile. Weil die Höhe der Fläche am
          Inhalt hing, wuchs sie mit jedem `fit()`, der `ResizeObserver` rief
          den nächsten, und jede Runde schickte dem Arm eine neue Größe: die
          Shell lief ins Unendliche und laggte.

          Deshalb trägt der äußere Knoten Rahmen, Padding und eine Höhe aus
          dem Fenster, und das Terminal hängt im inneren ohne Padding. Mit
          fester Höhe blieb der Vorschlag im selben Aufbau fünf `fit()` lang
          bei 36 Zeilen. */}
      <div
        className="h-[min(70svh,48rem)] min-h-[20rem] shrink-0 overflow-hidden rounded-md border p-2"
        // ⚠️ ZWEI INLINE-STILE UND KEINE TAILWIND-KLASSEN. Der `@theme
        // inline`-Block in `tokens.css` führt für die `--terminal-*`-Werte
        // KEINE `--color-…`-Aliasse (gemessen am 2026-09-08), es gäbe also
        // weder `bg-terminal-face` noch `border-terminal-line`. Sie dort
        // nachzutragen hieße, die Datei anzufassen, die drei Wächter lesen —
        // für zwei Regeln an genau einer Fläche. Die Fläche des Terminals ist
        // ohnehin der eine Ort, für den diese Werte gemacht sind.
        style={{ backgroundColor: "var(--terminal-surface)", borderColor: "var(--terminal-border)" }}
      >
        <div
          ref={fieldRef}
          data-testid="shell-terminal"
          aria-label={t("shellTerminalLabel")}
          // ⚠️ `font-mono` AM KNOTEN DES TERMINALS. `createTerminalSurface`
          // liest die Schriftfamilie aus genau diesem Knoten; ohne die Klasse
          // erbte er IBM Plex Sans vom `body`, `@xterm` maß die Zelle an einer
          // Proportionalschrift, und jedes Zeichen stand in einem Raster von
          // der Breite eines „W" (Befund des Betreibers am 2026-09-29: „sehr
          // viel Platz zwischen den Buchstaben").
          className="h-full font-mono"
        />
      </div>
    </div>
  );
}

/**
 * Der Satz zu einer Ablehnung — der Shell im Kopf oder einer Eingabe oder
 * Größe darunter.
 *
 * ⚠️ ÜBER DIE TABELLE UND MIT RÜCKFALL. Eine Kennung, die diese Fläche nicht
 * führt, erscheint ROH — nicht als leere Zeile, die aussieht wie ein
 * Zeichenfehler. Gar keine Kennung (`null`, #176) bekommt einen eigenen Satz:
 * bis dahin stand im Kopf eine leere Klammer, unter ihm das Wort `unbekannt`.
 */
function rejectionText(t: ReturnType<typeof useTranslations>, reason: string | null): string {
  if (reason === null) return t("shellErrorWithoutReason");
  const key = shellErrorMessageKey(reason);
  return key === null ? t("shellErrorUnknown", { reason }) : t(key);
}

/** Ist dieser Versuch vorbei? Nur dann steht die Schaltfläche da. */
function isOver(phase: ShellPhase): boolean {
  return phase === "ended" || phase === "broken" || phase === "rejected" || phase === "load-failed";
}

/**
 * Der Kopf in einem Satz — fünf Zustände, jeder mit eigenem Text.
 *
 * ⚠️ KEIN `t(TABELLE[wert])` MIT EINEM WERT DER GEGENSEITE. Die zwei Tabellen
 * in `shell-errors.ts` geben `null` zurück, wenn sie eine Kennung nicht
 * führen, und HIER steht, was dann dasteht: der Rückfallsatz mit der rohen
 * Kennung darin. Ein leerer Kopf wäre die schlechtere Auskunft — der
 * Log-Ansicht ist genau das schon einmal aufgefallen.
 */
function headline(t: ReturnType<typeof useTranslations>, view: ShellState): string {
  if (view.phase === "loading") return t("shellLoading");
  if (view.phase === "load-failed") return t("shellLoadFailed");
  if (view.phase === "connecting") return t("shellConnecting");
  if (view.phase === "connected") return t("shellConnected", { container: view.containerName });
  if (view.phase === "ended") return t("shellEnded", { code: view.exitCode ?? 0 });

  if (view.phase === "rejected") return rejectionText(t, view.errorReason);

  // `broken`: entweder eine `error`-Zeile mit Grund, oder ein `end` mit
  // `null` — dann weiß niemand mehr, als dass es vorbei ist.
  const reason = view.failureReason;
  if (reason === null) return t("shellBroken");
  const key = shellFailureMessageKey(reason);
  return key === null ? t("shellFailureUnknown", { reason }) : t(key);
}

/**
 * Die Schriftgröße in Pixeln zu einer Stufe.
 *
 * ⚠️ DIE ZAHL KOMMT AUS `presets.ts` UND NICHT AUS DEM CSS. `--terminal-size`
 * trägt „13px"; `@xterm` will eine Zahl. Denselben Weg nimmt
 * `web/src/app/settings/TerminalPanel.tsx` zu denselben Stufen.
 *
 * Der Rückfall ist die mittlere Stufe und kein `0`: eine Antwort, die eine
 * Stufe nennt, die es hier nicht gibt, ist ein Fehler der Gegenseite — und ein
 * Terminal mit Schriftgröße 0 wäre die schlechtere Auskunft darüber.
 */
function pixelsOf(name: string): number {
  return TERMINAL_SIZE_STEPS.find((step) => step.name === name)?.pixels ?? 13;
}

/** Der Verlauf in Zeilen zu einer Stufe — dieselbe Überlegung wie oben. */
function linesOf(name: string): number {
  return TERMINAL_SCROLLBACK_STEPS.find((step) => step.name === name)?.lines ?? 5_000;
}
