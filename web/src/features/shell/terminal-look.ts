// Was ein Terminal an Aussehen braucht — beschrieben OHNE `@xterm`.
//
// ⚠️ DIESE DATEI IMPORTIERT ABSICHTLICH NICHTS AUS `@xterm` (Paket B6, Etappe
// E6, #5). Sie ist die Sprache zwischen dem Reiter und der nachgeladenen
// Fläche: der Reiter rechnet das Aussehen aus dem Theme aus, die nachgeladene
// Datei reicht es an `@xterm` weiter. Stünde hier ein `import type { ITheme }
// from "@xterm/xterm"`, wäre das für den Typprüfer harmlos und für den Bau
// beinahe auch — ein `import type` wird gelöscht. Beinahe: die erste Zeile, die
// den Typ versehentlich als WERT benutzt (ein `satisfies ITheme`, eine
// Aufzählung ihrer Schlüssel), zöge das ganze Bündel in den Hauptteil zurück,
// und niemand sähe es. Ein eigener Typ hat diese Kante nicht.
//
// ⚠️ DIE NAMEN SIND DIE VON `@xterm` (`brightBlack` und nicht
// `bright-black`). Das ist keine Nachlässigkeit, sondern die Stelle, an der
// diese Datei ihre Gegenseite spiegelt: die nachgeladene Datei reicht das
// Objekt unverändert weiter, statt eine zweite Umbenennungstabelle zu führen.

/** Die Farben, die `@xterm` kennt — Fläche, Schrift, Cursor und 16 ANSI-Töne. */
export type TerminalPalette = {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
};

/**
 * Das ganze Aussehen eines Terminals.
 *
 * ⚠️ `fontSize` UND `scrollback` SIND ZAHLEN UND KOMMEN NICHT AUS DEM CSS.
 * `--terminal-size` trägt „13px" — eine Zeichenkette mit Einheit, die `@xterm`
 * nicht nimmt —, und `--terminal-scrollback` wäre der Umweg über eine
 * Zeichenkette zu einer Zahl, die es als Zahl schon gibt. Beide stehen als
 * `TERMINAL_SIZE_STEPS` und `TERMINAL_SCROLLBACK_STEPS` in
 * `contract/src/presets.ts`, und `web/tests/theme-presets.test.mjs` hält
 * sie gegen das Stylesheet.
 */
export type TerminalLook = {
  fontSize: number;
  scrollback: number;
  palette: TerminalPalette;
};

/** Die Größe eines Terminals in Zellen. */
export type TerminalSize = { cols: number; rows: number };

/**
 * Ein eingehängtes Terminal, von außen betrachtet.
 *
 * ⚠️ KEIN DURCHGRIFF AUF DAS `Terminal`-OBJEKT. Was hier nicht steht, kann der
 * Reiter nicht anfassen — und was er nicht anfasst, muss die Attrappe im Test
 * nicht nachbilden. Genau das macht den Prüfstand ehrlich: eine Attrappe, die
 * ein halbes `@xterm` nachbaut, prüft am Ende sich selbst.
 */
export type TerminalSurface = {
  /** Ausgabe des Containers hineinschreiben. */
  write: (text: string) => void;
  /** Tastenanschläge entgegennehmen — genau EIN Empfänger, gesetzt beim Bau. */
  onData: (handler: (data: string) => void) => void;
  /** Aussehen neu setzen, ohne das Terminal neu zu bauen. */
  apply: (look: TerminalLook) => void;
  /**
   * An den Knoten anpassen und die neue Größe melden.
   *
   * `null` heißt: die Fläche hat gerade keine messbare Größe (sie ist noch
   * nicht gezeichnet oder ausgeblendet). Der Aufrufer schickt dann nichts an
   * den Arm — eine Größe von 0×0 wäre eine Falschmeldung und keine Auskunft.
   */
  fit: () => TerminalSize | null;
  focus: () => void;
  dispose: () => void;
};

/**
 * Die nachgeladene Datei, von außen betrachtet.
 *
 * ⚠️ EIN EIGENER TYP UND KEIN `typeof import(...)`. Der Reiter bekommt den
 * Lader als Angabe herein (Vorbild: `schedule` in
 * `server/src/features/shell/routes.ts`), und ein Test reicht dafür eine
 * Attrappe. Mit `typeof import("./terminal-surface")` hinge die Signatur des
 * Testes an der echten Datei — und damit an `@xterm`, das unter happy-dom
 * gerade nicht geladen werden soll.
 */
export type SurfaceModule = {
  createTerminalSurface: (node: HTMLElement, look: TerminalLook) => TerminalSurface;
};

/** Wie der Reiter an die Fläche kommt. */
export type SurfaceLoader = () => Promise<SurfaceModule>;

/**
 * Wie der Reiter erfährt, dass seine Fläche eine andere Größe hat.
 *
 * Zurück kommt das Abbestellen und kein Griff auf den Beobachter — dieselbe
 * Form wie `Scheduler` in `server/src/features/shell/routes.ts`: was ein
 * Aufrufer nicht in der Hand hat, kann er nicht falsch anfassen.
 *
 * ⚠️ EINE ANGABE MIT VORGABEWERT UND KEIN FESTES `new ResizeObserver`, und der
 * Grund ist gemessen: happy-dom kennt zwar einen `ResizeObserver`, aber er
 * RUFT NIE ZURÜCK — es gibt dort kein Layout. Gemessen am 2026-09-08 an
 * happy-dom 20: nach `observe()` und nach einer Änderung von `style.width`
 * steht der Zähler des Rückrufs auf 0. Ohne diese Naht wäre der ganze Weg
 * „Fläche ändert sich, neue Größe geht an den Arm" durch keinen Test gedeckt,
 * und ein Test, der ihn nur vorgibt, wäre schlimmer als keiner.
 */
export type SizeWatcher = (node: HTMLElement, onChange: () => void) => () => void;
