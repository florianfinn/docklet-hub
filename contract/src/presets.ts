// Die Stellschrauben des Theme-Editors als Daten — die eine Quelle, gegen die
// der Server validiert und aus der die Oberfläche rendert.
//
// WHY THIS FILE LIVES IN `contract/`
//
// Both workspaces need it: the server, to reject a stored value that does not
// exist; the web, to draw the editor at all. It used to sit in
// `server/src/theme/` with the web reaching across the workspace boundary by
// relative path; since #245 both import it from the package `contract`. The
// direction that must hold is now a package boundary: `contract` imports
// nothing from `server` or `web`, and `web/tests/contract-package.test.mjs`
// fails on either breach.
//
// WAS HIER STEHT UND WAS NICHT
//
// Diese Datei enthält DATEN, KEINE LOGIK, und sie importiert nichts. Jede
// Stellschraube aus docs/design/hub-color-and-structure.md §4 steht als
// benannte Stufenliste darin, dazu der Tonvorrat aus §2 und die zwei fest
// vergebenen Bereichstöne.
//
// Bewusst NICHT hier:
//   - die drei Zustandsfarben (`--state-ok`, `--state-warn`, `--state-down`).
//     Sie sind Bedeutung, kein Geschmack: ein Editor, der „in Ordnung" auf Rot
//     stellen kann, ist kein Editor, sondern ein Fehler. Sie stehen fest in
//     `web/src/platform/theme/tokens.css`.
//
// „Darstellung einer Marke" und „Einrückung der Container eines Stacks" aus §4
// standen bis D7a in dieser Liste. Sie stehen jetzt unten als `MARK_STYLE_STEPS`
// und `INDENT_STEPS` — D7b (#62) hat sie nachgetragen.
//
// Die Namen sind wörtlich die Attributwerte aus `web/src/platform/theme/tokens.css` und
// `web/src/platform/theme/palette.css`. Ein Wächter hält beide Seiten gegeneinander —
// eine Stufe ohne Regel und eine Regel ohne Stufe werden beide rot.

/** Ein Ton aus dem Vorrat: der Attributwert und sein Ort im Farbtonkreis. */
export interface HueTone {
  /** Attributwert in `[data-hue="…"]` — zugleich die Kennung in der Ablage. */
  readonly name: string;
  /** Grad im oklch-Farbtonkreis. */
  readonly hue: number;
  /**
   * Eigener Sättigungswert statt der gerechneten Ableitung, oder `null`.
   * Nur „neutral" trägt einen: ein grauer Ton entsteht nicht aus einem
   * Faktor auf `--chroma`, sondern aus einer festen, sehr kleinen Buntheit.
   */
  readonly chroma: number | null;
}

/**
 * Der Tonvorrat aus §2: sechs freie Töne, dazu Neutral.
 *
 * Die drei Zustandstöne (160 in Ordnung, 85 Achtung, 22 Ausfall) fehlen hier
 * nicht versehentlich — D0 hat sie gesperrt, damit kein Host aussieht wie eine
 * Störung. Die zwei Bereichstöne stehen in `AREA_TONES`.
 */
export const HUE_TONES = [
  { name: "amber", hue: 62, chroma: null },
  { name: "green", hue: 130, chroma: null },
  { name: "teal", hue: 195, chroma: null },
  { name: "blue", hue: 255, chroma: null },
  { name: "violet", hue: 300, chroma: null },
  { name: "rose", hue: 350, chroma: null },
  { name: "neutral", hue: 265, chroma: 0.014 }
] as const satisfies readonly HueTone[];

/**
 * Die zwei fest vergebenen Bereichstöne aus §2.
 *
 * Sie stehen NICHT im Vorrat und gehören nicht in den Editor: sie sind
 * Ortsangabe („ich bin im Betrieb", „ich bin in den Einstellungen"), nicht
 * Geschmack. Wer sie wählbar macht, nimmt der Schale ihre Achse.
 */
export const AREA_TONES = [
  { name: "operations", hue: 225 },
  { name: "management", hue: 325 }
] as const;

/**
 * Der neutrale Grundton des ganzen Hauses, auf dem jede Fläche und jeder
 * Textwert in `tokens.css` steht. 265 und nicht 255: „blue" aus dem Vorrat ist
 * sein Nachbar, kein Gegensatz.
 */
export const BASE_HUE = 265;

/** Die drei Sättigungsstufen aus §4, global. */
export const CHROMA_STEPS = [
  { name: "subtle", chroma: 0.055 },
  { name: "normal", chroma: 0.145 },
  { name: "bold", chroma: 0.19 }
] as const;

/**
 * Die Sättigungsfaktoren der vier Ebenen aus §2: je seltener und wichtiger
 * etwas ist, desto kräftiger darf es auftreten. `cap` ist die Deckelung, die
 * §2 nur für den Host nennt.
 *
 * Diese Zahlen stehen hier als Beleg und für den Kontrasttest, nicht damit
 * jemand sie im Editor dreht — sie sind das Gefüge, nicht eine Stellschraube.
 */
export const CHROMA_FACTORS = [
  { name: "host", factor: 1.3, cap: 0.215 },
  { name: "mark", factor: 0.5, cap: null },
  { name: "area", factor: 0.32, cap: null },
  { name: "base", factor: 0.32, cap: null }
] as const;

/**
 * Hell und Dunkel aus §4.
 *
 * Hell ist kein zweiter Blick auf dieselben Zahlen, sondern ein eigener
 * Wertesatz mit eigenem Kontrasttest — er steht in `tokens.css` unter
 * `[data-scheme="light"]`, geprüft von `web/tests/theme-contrast.test.mjs`.
 */
export const SCHEME_STEPS = [{ name: "dark" }, { name: "light" }] as const;

/**
 * Farbeinsatz am Host aus §4 — je Host.
 *
 * „none" und „edge" tragen dieselben Flächen; der Unterschied liegt allein in
 * der Kante. Wer die beiden zusammenzieht, weil sie gleich aussehen, nimmt dem
 * Editor eine Stufe.
 */
export const INK_STEPS = [
  { name: "none" },
  { name: "edge" },
  { name: "head" },
  { name: "card" }
] as const;

/** Schriftart aus §4: IBM Plex als Datei oder die Schrift des Systems. */
export const FONT_STEPS = [{ name: "plex" }, { name: "system" }] as const;

/** Rundung aus §4. Der Wert ist wörtlich der, den `--radius` annimmt. */
export const RADIUS_STEPS = [
  { name: "sharp", radius: "4px" },
  { name: "soft", radius: "8px" },
  { name: "round", radius: "12px" }
] as const;

/** Dichte aus §4: Schriftgröße und Zeilenabstand gehen gemeinsam. */
export const DENSITY_STEPS = [
  { name: "normal", size: "15px", leading: 1.55 },
  { name: "compact", size: "14px", leading: 1.45 }
] as const;

/**
 * Diagrammfarben aus §4: „Drehung wie im Artboard" dreht den Farbton der
 * Reihen 2, 3 und 4 gegen die Kennfarbe, „einfarbig" lässt ihn stehen und
 * staffelt allein über die Helligkeit.
 */
export const CHART_STEPS = [{ name: "rotate" }, { name: "mono" }] as const;

/**
 * Fokusring aus §4: aus dem Farbton der Umgebung oder neutral. „neutral" ist
 * hier dieselbe Buntheit null wie beim neutralen Ton, nicht ein eigener Ton.
 */
export const FOCUS_STEPS = [{ name: "hue" }, { name: "neutral" }] as const;

/**
 * Darstellung einer eigenen Marke aus §4 — je Marke.
 *
 * §3 sagt, worin der Unterschied zur Systemmarke liegt: eine eigene Marke ist
 * „getönt statt gefüllt". „label" ist die getönte Beschriftung, „fill" die
 * getönte Fläche. Beide laufen auf halber Sättigung (`CHROMA_FACTORS`, Eintrag
 * „mark") — die Stufe entscheidet über die Form, nicht über die Kräftigkeit.
 */
export const MARK_STYLE_STEPS = [{ name: "label" }, { name: "fill" }] as const;

/**
 * Einrückung der Container eines Stacks aus §4 — je Stack.
 *
 * „nested" ist der Vorgabewert und zugleich der Wert, den `:root` in
 * `tokens.css` ohnehin trägt (`--stack-indent: 18px`). Er hat trotzdem eine
 * eigene Regel `[data-indent="nested"]`, und das ist Absicht: der Editor setzt
 * das Attribut ausdrücklich, und eine Stufe ohne Umschalter wäre eine Wahl,
 * die im Stylesheet nicht vorkommt.
 */
export const INDENT_STEPS = [{ name: "nested" }, { name: "flat" }] as const;

/**
 * Das Schema des Terminals — B6 (#5), Vorgabe des Leitstands in
 * `.remember/orchestration-b6/terminal-farben.md`.
 *
 * „follow" heißt: das Terminal nimmt das Schema des Hubs, wie es
 * `data-scheme` gerade trägt. „dark" heißt dunkel, auch wenn der Hub hell
 * steht — und das ist der Vorgabewert: ein Terminal ist die eine Fläche, für
 * die Dunkel auch in einer hellen Oberfläche der erwartete Anblick ist.
 */
export const TERMINAL_SCHEME_STEPS = [{ name: "follow" }, { name: "dark" }] as const;

/**
 * Die TIEFE der Terminalfläche gegenüber der Karte, auf der der Reiter sitzt —
 * keine freie Farbe. „card" ist die Karte selbst, „sunken" eine Stufe tiefer
 * (`--background`), „ink" die tiefste Stufe (`--terminal-ink`, in `tokens.css`
 * eigens dafür angelegt).
 *
 * Warum keine Farbwahl: eine gewählte Fläche stünde neben dem Wertesatz des
 * Schemas und nicht darin — sie folgte weder dem hellen noch dem dunklen Satz,
 * und der Kontrast der sechzehn ANSI-Töne wäre gegen sie nicht gemessen.
 */
export const TERMINAL_SURFACE_STEPS = [{ name: "card" }, { name: "sunken" }, { name: "ink" }] as const;

/**
 * Die Schriftgröße im Terminal, als ZAHL in Pixeln.
 *
 * ⚠️ Zahl und nicht „12px" wie bei `DENSITY_STEPS`: `@xterm` nimmt seine
 * `fontSize` als Zahl entgegen. Die Einheit hängt `tokens.css` an
 * (`--terminal-size: 12px`), und `web/tests/theme-presets.test.mjs` hält beide
 * Seiten gegeneinander — sonst stünden 12, 13 und 15 an zwei Orten ohne
 * Wächter dazwischen.
 */
export const TERMINAL_SIZE_STEPS = [
  { name: "small", pixels: 12 },
  { name: "normal", pixels: 13 },
  { name: "large", pixels: 15 }
] as const;

/**
 * Der Verlauf, den das Terminal im Browser vorhält, in Zeilen.
 *
 * ⚠️ Das ist Speicher im Browser und KEINE Angabe an den Agenten: der Agent
 * kennt keinen Verlauf, er schickt, was kommt. Wer die Zahl für eine
 * Nachlieferung alter Zeilen hält, baut eine Zusage, die niemand einlöst.
 */
export const TERMINAL_SCROLLBACK_STEPS = [
  { name: "short", lines: 1000 },
  { name: "normal", lines: 5000 },
  { name: "long", lines: 20000 }
] as const;

/**
 * Die Reichweiten aus §4. „global" gilt für den ganzen Hub und steht auf
 * `<html>`, „host" am einzelnen Arm, „mark" an einer eigenen Marke, „stack" an
 * einem Compose-Projekt eines Arms.
 */
export type KnobScope = "global" | "host" | "mark" | "stack";

/**
 * Alle Stellschrauben an einer Stelle: welches Attribut sie schaltet, worauf
 * sie wirkt, welche Stufen es gibt und welche gilt, solange nichts
 * gespeichert ist.
 *
 * ⚠️ `scope` IST EINE LISTE UND KEIN EINZELNER NAME, seit D7b (#62). Der Grund
 * steht in einem Satz: `hue` gilt für den Arm UND für eine Marke, und der
 * Tonvorrat dahinter ist DERSELBE (`HUE_TONES`) — #62 verlangt wörtlich „nicht
 * vier Stellen mit demselben Standardwert".
 *
 * Der andere Weg wäre ein zweiter Eintrag `markHue` mit demselben `attribute`
 * und derselben Stufenliste gewesen. Er scheitert daran, dass der SCHLÜSSEL
 * hier zugleich der Spaltenname in der Migration und der Feldname im Rumpf der
 * Route ist: `hub_mark` trägt eine Spalte `hue`, und `PUT /api/marks` trägt
 * `{ mark: { name, hue, style } }`. Ein Eintrag `markHue` bräuchte einen
 * dritten Ort, der `markHue` auf `hue` abbildet — genau die abgeschriebene
 * Aufzählung, die `knob-input.ts` in seinem Kopf ausschließt.
 *
 * ⚠️ Wer eine Reichweite braucht, LEITET SIE WEITERHIN AUS `scope` AB
 * (`scope.includes("host")`) und zählt sie nicht auf. Das ist die Bauart aus
 * D7a und der einzige Grund, warum diese Tabelle die eine Quelle bleibt.
 */
export const THEME_KNOBS = {
  scheme: { attribute: "data-scheme", scope: ["global"], steps: SCHEME_STEPS, fallback: "dark" },
  chroma: { attribute: "data-chroma", scope: ["global"], steps: CHROMA_STEPS, fallback: "normal" },
  radius: { attribute: "data-radius", scope: ["global"], steps: RADIUS_STEPS, fallback: "soft" },
  density: { attribute: "data-density", scope: ["global"], steps: DENSITY_STEPS, fallback: "normal" },
  font: { attribute: "data-font", scope: ["global"], steps: FONT_STEPS, fallback: "plex" },
  charts: { attribute: "data-charts", scope: ["global"], steps: CHART_STEPS, fallback: "rotate" },
  focus: { attribute: "data-focus", scope: ["global"], steps: FOCUS_STEPS, fallback: "hue" },
  // B6 (#5): die vier des Terminals. Sie sind global und nicht je Arm — die
  // Shell ist EIN Bauteil des Hubs, und ein Terminal, das je nach Arm anders
  // aussieht, wäre eine Einstellung ohne Gegenstück in der Bedienung.
  //
  // ⚠️ DIE SCHLÜSSEL SIND camelCase, DIE SPALTEN IN 012 SIND KLEINGESCHRIEBEN
  // (`terminalscheme`, …). Postgres faltet einen Bezeichner ohne
  // Anführungszeichen auf Kleinschreibung, und `features/appearance/store.ts` baut seine
  // Anweisungen wörtlich aus diesen Schlüsseln: `SELECT terminalScheme` trifft
  // `terminalscheme` und nur die. Ein `terminal_scheme` in der Migration wäre
  // die Spalte, die diese Anweisung NICHT findet.
  terminalScheme: {
    attribute: "data-terminal-scheme",
    scope: ["global"],
    steps: TERMINAL_SCHEME_STEPS,
    fallback: "dark"
  },
  terminalSurface: {
    attribute: "data-terminal-surface",
    scope: ["global"],
    steps: TERMINAL_SURFACE_STEPS,
    fallback: "sunken"
  },
  terminalSize: {
    attribute: "data-terminal-size",
    scope: ["global"],
    steps: TERMINAL_SIZE_STEPS,
    fallback: "normal"
  },
  terminalScrollback: {
    attribute: "data-terminal-scrollback",
    scope: ["global"],
    steps: TERMINAL_SCROLLBACK_STEPS,
    fallback: "normal"
  },
  // Ein Ton, zwei Reichweiten, EINE Stufenliste. Die Marke läuft auf halber
  // Sättigung (§3) — das entscheidet aber `CHROMA_FACTORS` und nicht eine
  // zweite Liste von Tönen.
  hue: { attribute: "data-hue", scope: ["host", "mark"], steps: HUE_TONES, fallback: "neutral" },
  ink: { attribute: "data-ink", scope: ["host"], steps: INK_STEPS, fallback: "head" },
  style: { attribute: "data-mark-style", scope: ["mark"], steps: MARK_STYLE_STEPS, fallback: "label" },
  indent: { attribute: "data-indent", scope: ["stack"], steps: INDENT_STEPS, fallback: "nested" }
} as const satisfies Record<
  string,
  { attribute: string; scope: readonly KnobScope[]; steps: readonly { name: string }[]; fallback: string }
>;

export type ThemeKnobName = keyof typeof THEME_KNOBS;

export type HueName = (typeof HUE_TONES)[number]["name"];
export type AreaName = (typeof AREA_TONES)[number]["name"];
export type ChromaName = (typeof CHROMA_STEPS)[number]["name"];
export type SchemeName = (typeof SCHEME_STEPS)[number]["name"];
export type InkName = (typeof INK_STEPS)[number]["name"];
export type FontName = (typeof FONT_STEPS)[number]["name"];
export type RadiusName = (typeof RADIUS_STEPS)[number]["name"];
export type DensityName = (typeof DENSITY_STEPS)[number]["name"];
export type ChartName = (typeof CHART_STEPS)[number]["name"];
export type FocusName = (typeof FOCUS_STEPS)[number]["name"];
export type MarkStyleName = (typeof MARK_STYLE_STEPS)[number]["name"];
export type IndentName = (typeof INDENT_STEPS)[number]["name"];
export type TerminalSchemeName = (typeof TERMINAL_SCHEME_STEPS)[number]["name"];
export type TerminalSurfaceName = (typeof TERMINAL_SURFACE_STEPS)[number]["name"];
export type TerminalSizeName = (typeof TERMINAL_SIZE_STEPS)[number]["name"];
export type TerminalScrollbackName = (typeof TERMINAL_SCROLLBACK_STEPS)[number]["name"];

/**
 * Der Satz, der gilt, solange nichts gespeichert ist — Stufe für Stufe
 * dieselben Werte, die `:root` in `tokens.css` trägt.
 */
export interface GlobalThemePreset {
  readonly scheme: SchemeName;
  readonly chroma: ChromaName;
  readonly radius: RadiusName;
  readonly density: DensityName;
  readonly font: FontName;
  readonly charts: ChartName;
  readonly focus: FocusName;
  readonly terminalScheme: TerminalSchemeName;
  readonly terminalSurface: TerminalSurfaceName;
  readonly terminalSize: TerminalSizeName;
  readonly terminalScrollback: TerminalScrollbackName;
}

export const DEFAULT_GLOBAL_THEME: GlobalThemePreset = {
  scheme: "dark",
  chroma: "normal",
  radius: "soft",
  density: "normal",
  font: "plex",
  charts: "rotate",
  focus: "hue",
  terminalScheme: "dark",
  terminalSurface: "sunken",
  terminalSize: "normal",
  terminalScrollback: "normal"
};

/** Was der Betreiber je Arm einstellt. */
export interface HostThemePreset {
  readonly hue: HueName;
  readonly ink: InkName;
}

export const DEFAULT_HOST_THEME: HostThemePreset = {
  hue: "neutral",
  ink: "head"
};

/**
 * Was der Betreiber je eigener Marke einstellt — ohne den Namen.
 *
 * Der Name ist keine Stellschraube: er hat keine Stufen, kein Attribut und
 * keinen Vorgabewert. Er reist im selben Rumpf und wird daneben geprüft
 * (`parseMarkInput`, `features/marks/input.ts`).
 */
export interface MarkThemePreset {
  readonly hue: HueName;
  readonly style: MarkStyleName;
}

export const DEFAULT_MARK_THEME: MarkThemePreset = {
  hue: "neutral",
  style: "label"
};

/** Was der Betreiber je Stack einstellt. Heute genau eine Stellschraube. */
export interface StackDisplayPreset {
  readonly indent: IndentName;
}

export const DEFAULT_STACK_DISPLAY: StackDisplayPreset = {
  indent: "nested"
};
