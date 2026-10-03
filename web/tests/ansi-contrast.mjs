// Die Farbrechnung für den Kontrastwächter des Terminals.
//
// HERKUNFT: übernommen aus `.remember/orchestration-b6/ansi-contrast.mjs` —
// dem Skript, mit dem der Leitstand die sechzehn ANSI-Töne beider Sätze für
// Paket B6 GEMESSEN hat. Seine Ausgabe liegt daneben als `ansi-messung.txt`,
// die daraus getroffene Entscheidung in `terminal-farben.md`. Das Skript selbst
// steht außerhalb des Baums; damit der Wächter im Repo dieselbe Rechnung
// benutzt wie die Messung, steht sie hier — und nicht ein zweites Mal
// hingeschrieben.
//
// Übernommen ist die RECHNUNG (oklch → OKLab → lineares sRGB, die
// Relativhelligkeit nach WCAG 2.1, der Gamut-Test). Nicht übernommen sind die
// Farbwerte: die liest `terminal-contrast.test.mjs` aus `tokens.css`. Ein
// Wächter mit einer eigenen Kopie der Farben prüft sich selbst.
//
// ⚠️ BEFUND, nicht behoben: `web/tests/theme-contrast.test.mjs` trägt seit D7a
// dieselbe Umrechnung (`oklchToRgb`, `relativeLuminance`, `contrastRatio`) und
// belegt sie dort mit einem eigenen Fall gegen unabhängige Quellen. Sie von
// dort zu importieren geht nicht: die Datei ist selbst ein Testmodul, und ein
// Import führte ihre Fälle im Lauf dieser Datei ein zweites Mal aus — die
// Zählung beider Läufe wäre danach falsch. Der saubere Weg wäre, sie aus
// `theme-contrast.test.mjs` in dieses Modul zu ziehen und dort zu
// importieren; das ist eine Änderung an einem Wächter, den diese Etappe nicht
// gebaut hat, und deshalb gemeldet statt getan.

/**
 * oklch → lineares sRGB, jeder Kanal roh (kann außerhalb 0…1 liegen).
 * OKLab-Matrizen nach Björn Ottosson, wie CSS Color Module Level 4 sie für
 * `oklch()` vorschreibt.
 */
export function oklchToLinearSrgb(lightness, chroma, hueDegrees) {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const longRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mediumRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const shortRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const long = longRoot ** 3;
  const medium = mediumRoot ** 3;
  const short = shortRoot ** 3;
  return [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short
  ];
}

/** `#rrggbb` → lineares sRGB. Die Gegenrichtung der Gammakodierung. */
export function hexToLinearSrgb(hex) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (match === null) return null;
  return [1, 2, 3].map((index) => {
    const channel = parseInt(match[index], 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
}

/** Relativhelligkeit nach WCAG 2.1 aus linearem sRGB. */
export function relativeLuminance([red, green, blue]) {
  const clamp = (value) => Math.min(1, Math.max(0, value));
  return 0.2126 * clamp(red) + 0.7152 * clamp(green) + 0.0722 * clamp(blue);
}

/** Kontrastverhältnis zweier Farben in linearem sRGB. */
export function contrastRatio(front, back) {
  const [high, low] = [relativeLuminance(front), relativeLuminance(back)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}

/**
 * Liegt die Farbe im sRGB-Raum?
 *
 * Die Toleranz von 0.001 ist die des Messskripts: eine Farbe, die um ein
 * Tausendstel herausragt, ist eine Rundung und keine andere Farbe.
 */
export function inGamut(linear) {
  return linear.every((channel) => channel >= -0.001 && channel <= 1.001);
}

/** `oklch(0.165 0.008 265)` → `[0.165, 0.008, 265]`, sonst `null`. */
export function parseOklch(value) {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value.trim());
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}
