// ANSI-Farbfolgen einer Logzeile, zerlegt in Abschnitte mit Stil.
//
// ⚠️ DER ARM REICHT DEN TEXT ROH DURCH, UND DAS BLEIBT SO. Viele Dienste
// färben ihr eigenes Log (winston, Serilog, Go-Logger mit TTY-Erkennung);
// gemessen am 2026-09-29 im Stack-Protokoll: overseerr schreibt jede Zeile als
// `ESC[34mdebugESC[39m[Jobs]: …`, und die Oberfläche zeigte das ESC als
// Kästchen und den Rest als Zeichensalat. Hier wird die Folge gelesen und in
// Farbe übersetzt — die Zeile selbst ändert sich nicht, der Filter läuft
// weiter über den rohen Text.
//
// ⚠️ KEIN REGULÄRER AUSDRUCK UND KEIN ESC IM QUELLTEXT. Das Steuerzeichen
// entsteht über `String.fromCharCode` (AGENTS.md: kein Steuerzeichen in einer
// Quelldatei), und der Leser geht Zeichen für Zeichen: eine Folge, die mitten
// im Text abbricht, darf den Rest der Zeile nicht verschlucken.
//
// Gelesen wird SGR (`ESC[…m`): Vorder- und Hintergrund in 16 Farben, 256
// Farben und 24 Bit, fett, blass, kursiv, unterstrichen. Jede andere
// CSI-Folge (Cursor, Löschen) und jede OSC-Folge (Fenstertitel, Links) fällt
// ersatzlos weg — in einer Zeile ohne Bildschirm bedeuten sie nichts.

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

export type AnsiStyle = {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
};

export type AnsiSegment = { text: string; style: AnsiStyle };

export const PLAIN_STYLE: AnsiStyle = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false };

/**
 * Die 16 Grundfarben, als Verweis auf die Farben des Terminals.
 *
 * ⚠️ DIESELBEN WERTE WIE IN DER SHELL (`--terminal-ansi-*`, theme/tokens.css).
 * Ein Rot im Log und ein Rot in der Shell desselben Containers sollen
 * dasselbe Rot sein, und beide folgen dem hellen und dem dunklen Schema.
 */
const BASE_COLORS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

function baseColor(index: number, bright: boolean): string {
  return `var(--terminal-ansi-${bright ? "bright-" : ""}${BASE_COLORS[index]})`;
}

/** Eine der 256 Farben: 0–15 die Grundfarben, dann der Würfel, dann das Grau. */
function paletteColor(index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null;
  if (index < 8) return baseColor(index, false);
  if (index < 16) return baseColor(index - 8, true);
  if (index < 232) {
    const cube = index - 16;
    const level = (step: number) => (step === 0 ? 0 : 55 + step * 40);
    return `rgb(${level(Math.floor(cube / 36))}, ${level(Math.floor(cube / 6) % 6)}, ${level(cube % 6)})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

/**
 * Eine erweiterte Farbe ab `codes[at]` (`5;n` oder `2;r;g;b`).
 * Gibt die Farbe und die Zahl der verbrauchten Werte zurück.
 */
function extendedColor(codes: number[], at: number): { color: string | null; used: number } {
  const mode = codes[at];
  if (mode === 5) return { color: paletteColor(codes[at + 1]), used: 2 };
  if (mode === 2) {
    const [red, green, blue] = [codes[at + 1], codes[at + 2], codes[at + 3]];
    const valid = [red, green, blue].every((value) => Number.isInteger(value) && value >= 0 && value <= 255);
    return { color: valid ? `rgb(${red}, ${green}, ${blue})` : null, used: 4 };
  }
  return { color: null, used: 1 };
}

/** Wendet die Werte einer SGR-Folge auf einen Stil an. */
function applySgr(style: AnsiStyle, parameters: string): AnsiStyle {
  // `ESC[m` ist dasselbe wie `ESC[0m`.
  const codes = parameters === "" ? [0] : parameters.split(";").map((part) => (part === "" ? 0 : Number(part)));
  let next = { ...style };
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === 0) next = { ...PLAIN_STYLE };
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 22) next = { ...next, bold: false, dim: false };
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code >= 30 && code <= 37) next.fg = baseColor(code - 30, false);
    else if (code >= 90 && code <= 97) next.fg = baseColor(code - 90, true);
    else if (code === 39) next.fg = null;
    else if (code >= 40 && code <= 47) next.bg = baseColor(code - 40, false);
    else if (code >= 100 && code <= 107) next.bg = baseColor(code - 100, true);
    else if (code === 49) next.bg = null;
    else if (code === 38 || code === 48) {
      const { color, used } = extendedColor(codes, index + 1);
      if (code === 38) next.fg = color;
      else next.bg = color;
      index += used;
    }
  }
  return next;
}

function isFinalByte(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

/**
 * Zerlegt eine Zeile in Abschnitte gleichen Stils.
 *
 * Eine Zeile ohne ESC kommt als EIN Abschnitt ohne Stil zurück — der
 * Normalfall, und er kostet eine Suche.
 */
export function parseAnsi(text: string): AnsiSegment[] {
  if (!text.includes(ESC)) return text === "" ? [] : [{ text, style: PLAIN_STYLE }];

  const segments: AnsiSegment[] = [];
  let style = PLAIN_STYLE;
  let buffer = "";
  const flush = () => {
    if (buffer === "") return;
    segments.push({ text: buffer, style });
    buffer = "";
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char !== ESC) {
      buffer += char;
      index += 1;
      continue;
    }
    const kind = text[index + 1];
    if (kind === "[") {
      // CSI: Parameter bis zum ersten Endbyte.
      let end = index + 2;
      while (end < text.length && !isFinalByte(text[end])) end += 1;
      if (end >= text.length) break; // abgeschnittene Folge am Zeilenende
      if (text[end] === "m") {
        flush();
        style = applySgr(style, text.slice(index + 2, end));
      }
      index = end + 1;
      continue;
    }
    if (kind === "]") {
      // OSC: bis BEL oder ESC-Backslash.
      let end = index + 2;
      while (end < text.length && text[end] !== BEL && !(text[end] === ESC && text[end + 1] === "\\")) end += 1;
      index = end >= text.length ? end : text[end] === BEL ? end + 1 : end + 2;
      continue;
    }
    // Jede andere Folge: ESC, ihre Zwischenbytes (0x20–0x2F, etwa das `(` in
    // `ESC(B`, der Zeichensatzwahl) und das Endbyte fallen weg.
    let end = index + 1;
    while (end < text.length && text.charCodeAt(end) >= 0x20 && text.charCodeAt(end) <= 0x2f) end += 1;
    index = end + 1;
  }
  flush();
  return segments;
}

/** Der Text ohne jede Steuerfolge — für die Erkennung der Stufe. */
export function stripAnsi(text: string): string {
  return parseAnsi(text)
    .map((segment) => segment.text)
    .join("");
}
