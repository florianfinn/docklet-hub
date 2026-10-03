import type { TerminalPalette } from "./terminal-look";

// Die Farben des Terminals aus dem Theme lesen — und in eine Form bringen, die
// `@xterm` überhaupt annimmt (Paket B6, Etappe E6, #5).
//
// ── WARUM DAS NICHT „EINFACH ABLESEN" IST ──────────────────────────────────
//
// Drei Messungen vom 2026-09-08, und erst zusammen ergeben sie die Bauart
// dieser Datei. Die Lücke, die sie schließen, benennt
// `web/tests/terminal-contrast.test.mjs:222,234` über sich selbst: ob
// `@xterm` die abgelesenen Werte am Ende wirklich nimmt, war im ganzen Repo
// nirgends gemessen.
//
// (1) `getComputedStyle(el).color` gibt in Chromium 1194 (über Playwright)
//     einen HEX-Token als `rgb(249, 131, 124)` zurück, einen OKLCH-Token aber
//     unverändert als `oklch(0.165 0.008 265)` und einen mit Deckung als
//     `oklch(0.7 0.1 265 / 0.45)`. Die 48 ANSI-Werte in `tokens.css` sind Hex,
//     die Flächen, der Vordergrund, der Cursor und die Auswahl sind oklch.
//
// (2) `@xterm` 5.5.0 parst eine Farbe über eine 2D-LEINWAND. In Chromium
//     kommen deshalb auch die oklch-Werte an — gemessen gegen die innere
//     Farbtafel (`_core._themeService.colors`, Feld `rgba`):
//     `oklch(0.165 0.008 265)` wird zu `0x0d0e12ff`, genau dem Wert, den auch
//     der Umrechner hier liefert. MIT EINER AUSNAHME: die Auswahl,
//     `oklch(0.7 0.1 265 / 0.45)`, kommt NICHT an — dort steht danach
//     `0xffffff4d`, `@xterm`s eigene Vorgabe. Eine oklch-Farbe mit Deckung
//     verliert es.
//
// (3) Ohne 2D-Leinwand fällt `@xterm` für JEDEN nicht-Hex-Wert auf seine
//     Vorgabepalette zurück (gemessen unter happy-dom, das für
//     `getContext("2d")` `null` gibt).
//
// ⚠️ DIE ZWEITE MESSUNG HAT DIE ERSTE FASSUNG DIESES KOPFES BERICHTIGT. Hier
// stand zuerst „`@xterm` verwirft oklch still" — das war unter happy-dom
// gemessen und ist eine Aussage über happy-dom, nicht über den Browser. Der
// Satz war bereits in einem Commit-Text gelandet, bevor die Messung in
// Chromium ihn widerlegt hat.
//
// WAS DIE UMRECHNUNG DAMIT WIRKLICH KAUFT, ohne Übertreibung:
//   * Die AUSWAHL kommt an. Ohne sie liegt `@xterm`s weiße Vorgabe über dem
//     Text — und keine Prüfkette dieses Repos sähe es.
//   * Das Ergebnis hängt nicht mehr daran, dass `@xterm` intern eine Leinwand
//     findet. Wo es keine gibt, gibt es hier auch keine, und dann geht der
//     abgelesene Wert unverändert hinaus: derselbe Rückfall wie ohne diese
//     Datei, kein schlechterer.
//   * Was hineingeht, ist eine Form, die im Quelltext von `@xterm` ohne
//     Leinwand geparst wird. Das ist die schmalste Zusage, die diese Fläche
//     der Gegenseite abverlangt.
//
// ── DER UMRECHNER IST DER BROWSER UND NICHT EIGENE FARBMATHEMATIK ──────────
//
// Umgerechnet wird, indem der Browser EINEN BILDPUNKT MALT und die vier Bytes
// zurückgelesen werden. Das ist keine Bequemlichkeit, sondern die einzige
// Fassung, die nicht veraltet: sie kennt jede Farbschreibweise, die der
// Browser kennt — heute oklch, morgen was auch immer —, und sie hat keine
// zweite Wahrheit über den Farbraum.
//
// ⚠️ VERWORFEN: der Weg über `context.fillStyle` ALLEIN, wie ihn
// `web/src/platform/ui/dot-wave/DotWave.tsx` geht. Er prüft, OB der Browser den Wert
// annimmt, und das ist hier ebenfalls nötig — aber er NORMALISIERT nicht:
// gemessen in Chromium bleibt `oklch(0.115 0.006 265)` beim Zurücklesen
// zeichengleich `oklch(0.115 0.006 265)`. Die Tabelle im Kopf von `DotWave`
// sagt das selbst; dort ging es nur nie um eine Gegenseite, die `oklch` nicht
// parst. Deshalb hier der Bildpunkt und nicht bloß das Zurücklesen.
//
// ⚠️ VERWORFEN: `color-mix(in srgb, var(--x) 100%, transparent)` im
// Stylesheet, damit der Browser selbst sRGB liefert. Gemessen: Chromium gibt
// dafür `color(srgb 0.0167956 0.019747 0.0267662)` zurück — eine Schreibweise,
// die `@xterm` ebenfalls verwirft. Es hätte das Problem nur verschoben.
//
// ⚠️ VERWORFEN: einen eigenen OKLab-nach-sRGB-Rechner. Er wäre die zweite
// Wahrheit über die Farbrechnung des Browsers, und er wäre falsch, sobald ein
// Token einen anderen Farbraum trägt.

/**
 * Ein Umrechner: eine beliebige CSS-Farbe in eine Form, die `@xterm` liest —
 * oder `null`, wenn der Browser den Wert selbst nicht versteht.
 */
export type ColorConverter = (value: string) => string | null;

/**
 * Welcher `--terminal-*`-Wert welche Farbe von `@xterm` trägt.
 *
 * ⚠️ DIE NAMEN LINKS SIND DIE VON `@xterm` UND DIE RECHTS DIE VON
 * `tokens.css`. Beide Seiten stehen woanders; diese Tabelle ist die eine
 * Stelle, an der sie sich treffen. Eine zweite Zuordnung irgendwo wäre die,
 * die beim nächsten neuen Ton vergessen wird.
 *
 * ⚠️ `cursorAccent` IST DIE FLÄCHE UND NICHT DER VORDERGRUND. Es ist die
 * Farbe, in der der Text UNTER einem Blockcursor steht; sie muss zum Cursor
 * kontrastieren, und der trägt den Vordergrund. Wer hier ebenfalls den
 * Vordergrund einträgt, macht das Zeichen unter dem Cursor unsichtbar.
 */
const TOKEN_BY_COLOR: Record<keyof TerminalPalette, string> = {
  background: "--terminal-surface",
  foreground: "--terminal-foreground",
  cursor: "--terminal-cursor",
  cursorAccent: "--terminal-surface",
  selectionBackground: "--terminal-selection",
  black: "--terminal-ansi-black",
  red: "--terminal-ansi-red",
  green: "--terminal-ansi-green",
  yellow: "--terminal-ansi-yellow",
  blue: "--terminal-ansi-blue",
  magenta: "--terminal-ansi-magenta",
  cyan: "--terminal-ansi-cyan",
  white: "--terminal-ansi-white",
  brightBlack: "--terminal-ansi-bright-black",
  brightRed: "--terminal-ansi-bright-red",
  brightGreen: "--terminal-ansi-bright-green",
  brightYellow: "--terminal-ansi-bright-yellow",
  brightBlue: "--terminal-ansi-bright-blue",
  brightMagenta: "--terminal-ansi-bright-magenta",
  brightCyan: "--terminal-ansi-bright-cyan",
  brightWhite: "--terminal-ansi-bright-white"
};

/** Die Namen dieser Tabelle — für den Wächter und für nichts sonst. */
export const TERMINAL_COLOR_TOKENS: readonly string[] = Object.values(TOKEN_BY_COLOR);

function twoDigits(value: number): string {
  return value.toString(16).padStart(2, "0");
}

/**
 * Der Browser als Umrechner: einen Bildpunkt malen und die vier Bytes lesen.
 *
 * `null` heißt: dieser Browser hat keine 2D-Leinwand. Dann geht der abgelesene
 * Wert UNVERÄNDERT an `@xterm` — und dort gibt es aus demselben Grund auch
 * keine, also fällt es für jeden nicht-Hex-Wert auf seine Vorgabe zurück. Das
 * ist genau das, was ohne diese Datei geschähe: kein besserer Zustand, aber
 * auch kein schlechterer, und deshalb der ehrliche Rückfall statt eines
 * Wurfes.
 *
 * ⚠️ ERST DIE PRÜFUNG, DANN DER BILDPUNKT. Ein `fillStyle`, den der Browser
 * nicht versteht, wird STILL verworfen und der vorige Wert bleibt stehen —
 * gemalt würde dann die vorige Farbe, und der Umrechner lieferte für einen
 * unbrauchbaren Wert eine plausible Farbe. Verglichen wird gegen den Stand
 * DAVOR und nicht gegen die gesetzte Zeichenkette; die Begründung dafür steht
 * ausführlich in `web/src/platform/ui/dot-wave/DotWave.tsx` und gilt hier unverändert.
 */
export function canvasColorConverter(): ColorConverter | null {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d");
  if (context === null) return null;

  return (value) => {
    context.fillStyle = "transparent";
    const untouched = context.fillStyle;
    context.fillStyle = value;
    if (context.fillStyle === untouched) return null;

    context.clearRect(0, 0, 1, 1);
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
    const rgb = `#${twoDigits(red)}${twoDigits(green)}${twoDigits(blue)}`;
    // ⚠️ Die Deckung gehört DAZU. `--terminal-selection` kommt aus `--ring`
    // und läuft auf 45 %; ohne das vierte Byte läge eine deckende Fläche über
    // dem Text, und die Auswahl verdeckte, was sie zeigen soll.
    return alpha === 255 ? rgb : `${rgb}${twoDigits(alpha)}`;
  };
}

/**
 * Die Palette des Terminals, abgelesen an einem Ableseelement.
 *
 * ⚠️ DAS ABLESEELEMENT TRÄGT DIE VARIABLE ALS ECHTE CSS-EIGENSCHAFT, und
 * abgelesen wird der GERECHNETE Wert. Das ist der Weg aus `DotWave.tsx` — der
 * einzige im Bestand — und nicht `getPropertyValue("--x")`: jener gibt den
 * Text der Deklaration zurück, also bei einem Alias (`--terminal-surface: var(--terminal-sunken)`)
 * die Kette und nicht die Farbe.
 *
 * ⚠️ EIN ELEMENT UND NICHT EINUNDZWANZIG. Es wird je Farbe umgestellt und neu
 * abgelesen; der Browser rechnet dabei jedes Mal neu. Einundzwanzig Elemente
 * wären einundzwanzig Knoten im Baum für einen Wert, der einmal je Wechsel des
 * Themes gebraucht wird.
 *
 * ⚠️ WAS DER UMRECHNER VERWIRFT, FEHLT IN DER PALETTE — und das ist Absicht.
 * `@xterm` behält für einen fehlenden Eintrag seine eigene Vorgabe; eine
 * Farbe, die der Browser nicht versteht, als Zeichenkette durchzureichen wäre
 * dasselbe Ergebnis mit mehr Umweg. Ein hier erfundener Ersatzwert wäre die
 * schlechteste Wahl: er sähe aus wie eine Entscheidung des Themes.
 */
export function readTerminalPalette(probe: HTMLElement, convert: ColorConverter | null): TerminalPalette {
  const palette: Record<string, string> = {};
  for (const [color, token] of Object.entries(TOKEN_BY_COLOR)) {
    probe.style.color = `var(${token})`;
    const computed = getComputedStyle(probe).color;
    if (computed === "") continue;
    const usable = convert === null ? computed : convert(computed);
    if (usable === null) continue;
    palette[color] = usable;
  }
  // Das Ableseelement bleibt nicht auf der letzten Farbe stehen: es ist ein
  // Messgerät und keine Fläche.
  probe.style.color = "";
  return palette as TerminalPalette;
}
