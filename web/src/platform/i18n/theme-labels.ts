// Was der Betreiber liest, wenn in `presets.ts` „amber" oder „compact" steht.
//
// Die Namen der Stufen sind BEZEICHNER: sie stehen englisch in
// `contract/src/presets.ts`, sie sind zugleich die Attributwerte in
// `web/src/platform/theme/palette.css` und `tokens.css`, und sie liegen in genau dieser
// Schreibweise in der Ablage. Sie sind damit kein Text, den man übersetzt,
// sondern ein Schlüssel — und diese Datei ordnet jedem einen Sprachschlüssel
// zu. Denselben Weg gehen `web/src/platform/i18n/language-labels.ts`,
// `web/src/features/hosts/HostCard.tsx` (`HOST_KIND_KEYS`) und
// `web/src/domain/hosts/host-status.tsx` schon.
//
// ⚠️ WARUM DIE ZUORDNUNGEN TOTAL SIND UND NICHT `Partial`. Jede der Tabellen
// unten ist ein `Record` über die volle Stufenliste aus `presets.ts`. Wer dort
// eine Stufe hinzufügt — einen achten Ton, eine vierte Stufe des Farbeinsatzes
// —, bekommt hier einen Typfehler, der den fehlenden Eintrag beim Namen nennt
// (`TS2741: Property 'ochre' is missing`). Ohne diese Totalität stünde die
// neue Stufe im Editor mit einem leeren Feld oder mit ihrem englischen
// Bezeichner da, und nichts daran wäre rot.

import type { Messages } from "use-intl";

import type {
  AreaName,
  GlobalThemePreset,
  HueName,
  InkName,
  MarkStyleName
} from "contract";

/**
 * Der Schlüsseltyp der Sprachdateien.
 *
 * `keyof Messages` und nicht der Umweg über den Rückgabetyp des Hooks: die
 * Flächen dieses Baums (`HOST_KIND_KEYS`, `host-status.tsx`) nennen ihn schon
 * so, und `use-intl` gibt `Messages` ausdrücklich dafür heraus.
 */
export type TranslationKey = keyof Messages;

/**
 * Der Name jeder globalen Stellschraube, wie er links in der Feldliste steht.
 *
 * ⚠️ Dieses `Record` ist die Stelle, an der eine ACHTE globale Stellschraube
 * auffällt: `keyof GlobalThemePreset` ist total, ein neues Feld in
 * `presets.ts` erzeugt hier `TS2741` und nennt den fehlenden Eintrag beim
 * Namen. Die Reihenfolge der Zeilen in `AppearancePanel.tsx` ist damit noch
 * nicht erzwungen — dort muss die neue Stellschraube von Hand nachgetragen
 * werden, und dieser Typfehler ist die Nachricht, die daran erinnert.
 */
export const GLOBAL_KNOB_LABELS: Readonly<Record<keyof GlobalThemePreset, TranslationKey>> = {
  scheme: "themeKnobScheme",
  chroma: "themeKnobChroma",
  radius: "themeKnobRadius",
  density: "themeKnobDensity",
  font: "themeKnobFont",
  charts: "themeKnobCharts",
  focus: "themeKnobFocus",
  // B6 (#5): die vier des Terminals. Sie stehen hier, weil dieses `Record`
  // total ist — ohne sie meldet der Bau `TS2741` und nennt das fehlende Feld
  // beim Namen. Die Tafel, die sie zeigt, baut eine spätere Etappe; die
  // Beschriftung gehört trotzdem hierher, sonst hätte die Tafel nichts zu
  // lesen.
  terminalScheme: "themeKnobTerminalScheme",
  terminalSurface: "themeKnobTerminalSurface",
  terminalSize: "themeKnobTerminalSize",
  terminalScrollback: "themeKnobTerminalScrollback"
};

/**
 * Die Stufen jeder globalen Stellschraube — über BEIDE Achsen total: außen die
 * Stellschraube, innen ihre eigene Stufenliste aus `presets.ts`.
 *
 * ⚠️ „normal" steht zweimal darin und trägt trotzdem zwei verschiedene
 * Schlüssel (`themeChromaNormal`, `themeDensityNormal`). Das ist keine
 * Doppelung, sondern der Unterschied zwischen „normal gesättigt" und „normal
 * dicht": ein gemeinsamer Schlüssel hieße, dass eine Sprache, die für das eine
 * ein anderes Wort braucht als für das andere, es nicht haben kann.
 */
export type GlobalStepLabels = {
  readonly [K in keyof GlobalThemePreset]: Readonly<Record<GlobalThemePreset[K], TranslationKey>>;
};

export const GLOBAL_STEP_LABELS: GlobalStepLabels = {
  scheme: { dark: "themeSchemeDark", light: "themeSchemeLight" },
  chroma: { subtle: "themeChromaSubtle", normal: "themeChromaNormal", bold: "themeChromaBold" },
  radius: { sharp: "themeRadiusSharp", soft: "themeRadiusSoft", round: "themeRadiusRound" },
  density: { normal: "themeDensityNormal", compact: "themeDensityCompact" },
  font: { plex: "themeFontPlex", system: "themeFontSystem" },
  charts: { rotate: "themeChartsRotate", mono: "themeChartsMono" },
  focus: { hue: "themeFocusHue", neutral: "themeFocusNeutral" },
  // ⚠️ „dark" steht hier ein zweites Mal (oben bei `scheme`) und trägt
  // trotzdem einen eigenen Schlüssel: „dunkel" als Schema des Hubs und „immer
  // dunkel" als Trotz des Terminals gegen ein helles Haus sind zwei Aussagen.
  // Derselbe Grund wie bei „normal" in `chroma` und `density`.
  terminalScheme: { follow: "themeTerminalSchemeFollow", dark: "themeTerminalSchemeDark" },
  terminalSurface: {
    card: "themeTerminalSurfaceCard",
    sunken: "themeTerminalSurfaceSunken",
    ink: "themeTerminalSurfaceInk"
  },
  terminalSize: {
    small: "themeTerminalSizeSmall",
    normal: "themeTerminalSizeNormal",
    large: "themeTerminalSizeLarge"
  },
  terminalScrollback: {
    short: "themeTerminalScrollbackShort",
    normal: "themeTerminalScrollbackNormal",
    long: "themeTerminalScrollbackLong"
  }
};

/**
 * Die sieben Töne des Vorrats.
 *
 * Die deutschen Namen sind die des Artboards (hub-palette.html Z. 802–820):
 * „Lila · 300", „Türkis · 195", „Orange · 62". Sie benennen die Farbe, die der
 * Betreiber sieht, und nicht den Bezeichner, unter dem sie gespeichert liegt —
 * „amber" ist der Schlüssel, „Orange" ist die Auskunft.
 */
export const HUE_LABELS: Readonly<Record<HueName, TranslationKey>> = {
  amber: "themeHueAmber",
  green: "themeHueGreen",
  teal: "themeHueTeal",
  blue: "themeHueBlue",
  violet: "themeHueViolet",
  rose: "themeHueRose",
  neutral: "themeHueNeutral"
};

/**
 * Die vier Stufen des Farbeinsatzes.
 *
 * ⚠️ „none" und „edge" tragen laut `presets.ts` dieselben Flächen und
 * unterscheiden sich allein in der Kante. Die Beschriftungen sagen deshalb
 * genau das („ohne Farbe", „nur Kante") und nicht zweimal dasselbe Wort — wer
 * beide gleich benennt, macht aus zwei Stufen eine, die niemand mehr
 * auseinanderhält.
 */
export const INK_LABELS: Readonly<Record<InkName, TranslationKey>> = {
  none: "themeInkNone",
  edge: "themeInkEdge",
  head: "themeInkHead",
  card: "themeInkCard"
};

/**
 * Die zwei Stufen, in denen eine eigene Marke dargestellt wird (D7b, #62).
 *
 * ⚠️ „Beschriftung" und „Fläche" und NICHT „label" und „fill". Die englischen
 * Namen sind Bezeichner: sie stehen so in `MARK_STYLE_STEPS`, so in
 * `[data-mark-style="…"]` (web/src/platform/theme/palette.css) und so in der Ablage.
 * Ein Wähler, der sie als Wörter anbietet, zeigt die Wahl nicht — und die
 * Beschriftung ist ohnehin nur die halbe Auskunft: der Editor zeigt jede Stufe
 * zusätzlich ALS MARKE in dieser Darstellung (`MarksPanel.tsx`).
 *
 * Was der Unterschied ist, steht in `palette.css` Z. 181–182 (nachgesehen):
 * „label" macht die Fläche durchsichtig und zieht eine getönte Linie, „fill"
 * füllt die Fläche und lässt die Linie weg. Beide laufen auf halber Sättigung
 * — das entscheidet `[data-mark]` und nicht die Stufe
 * (docs/design/hub-color-and-structure.md §3).
 */
export const MARK_STYLE_LABELS: Readonly<Record<MarkStyleName, TranslationKey>> = {
  label: "themeMarkStyleLabel",
  fill: "themeMarkStyleFill"
};

/**
 * Die zwei fest vergebenen Bereiche — nur Anzeige, siehe `AreaColorPanel`.
 *
 * „Profil & Einstellungen" und nicht „Verwaltung": das Artboard nennt sie so
 * (Z. 791), und es ist die Antwort auf „wo bin ich" und nicht der Name einer
 * Abteilung.
 */
export const AREA_LABELS: Readonly<Record<AreaName, TranslationKey>> = {
  operations: "themeAreaOperations",
  management: "themeAreaManagement"
};

/** Wofür ein Bereichston steht — die letzte Spalte der Zeile im Artboard. */
export const AREA_SCOPE_LABELS: Readonly<Record<AreaName, TranslationKey>> = {
  operations: "themeAreaOperationsScope",
  management: "themeAreaManagementScope"
};

/**
 * Der Name des Tons, den ein Bereich trägt — „Stahlblau · 225" im Artboard.
 *
 * Ohne ihn stünde in der Zeile allein die Zahl, und die beantwortet die Frage
 * „welche Farbe ist das" für niemanden, der nicht im Farbtonkreis rechnet.
 */
export const AREA_TONE_LABELS: Readonly<Record<AreaName, TranslationKey>> = {
  operations: "themeAreaOperationsTone",
  management: "themeAreaManagementTone"
};
