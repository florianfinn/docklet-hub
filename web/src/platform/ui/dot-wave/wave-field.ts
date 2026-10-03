// Die Rechnung hinter dem Grund: aus Breite und Höhe ein Raster, aus Ort und
// Zeit eine Höhe. Sonst nichts.
//
// ⚠️ Diese Datei enthält keine einzige Zeile `import` — kein React, kein DOM,
// keine Anwendung. Das ist keine Sparsamkeit, sondern der Zweck des Schnitts:
// was nichts kennt, lässt sich rechnen und prüfen, ohne einen Browser zu
// starten. Erlaubt ist `Math`, sonst nichts.
//
// Warum überhaupt gerechnet und nicht animiert: die Welle ist nicht EINE
// Schwingung, sondern die Summe aus dreien mit verschiedenen Längen,
// Richtungen und Umlaufzeiten. Ein Element hat je Eigenschaft genau eine
// Animation, und `animation-delay` ist ein Phasenversatz — damit ließe sich
// genau eine der drei bauen. Über 1440×900 trägt das Raster 2 402 Punkte
// (gemessen: `createWaveField(1440, 900).length`); drei übereinandergelegte
// Elemente je Punkt wären 7 206 Knoten für einen Hintergrund. Auf einer
// Leinwand ist es ein Element und die Rechnung frei.

// Der Horizont liegt bei 33 % der Höhe; darüber entsteht kein Punkt. Das obere
// Drittel bleibt leer — das ist der Entwurf, kein Versehen.
export const HORIZON_RATIO = 0.33;

// 30 Zeilen. Der Exponent drängt sie zum Horizont hin zusammen; er ist die
// ganze Perspektive und der einzige Grund, warum die Fläche nach hinten und
// nicht nach oben läuft. Wer ihn auf 1 stellt, bekommt ein gleichmäßiges
// Gitter zurück, ohne dass ein Zeichen rot wird.
export const ROW_COUNT = 30;
export const DEPTH_EXPONENT = 1.8;

// Rasterweite ganz vorn. Dieselbe Zahl steht in drei Rollen: als Punktabstand
// der vordersten Zeile, als Zugabe unter dem unteren Rand (damit die erste
// Zeile nicht angeschnitten in der Kante klebt) und als Maß für die Tiefe in
// der Welt.
export const GRID_STEP = 28;

// Untergrenze für den Punktabstand. Ohne sie liefe er in den hintersten Zeilen
// auf 28 · 0,4 = 11,2 px hinunter — dichter, als ein Punkt von 2 px
// Durchmesser noch auflöst, und jede dieser Zeilen trüge dafür gut die Hälfte
// mehr Punkte (17 / 11,2 = 1,52).
export const MIN_SPACING = 17;

// Ein Punkt kennt zwei Orte: den auf dem Schirm und den in der Welt.
export type WaveDot = {
  /** Ort auf dem Schirm, waagerecht. */
  x: number;
  /** Ruhelage auf dem Schirm, senkrecht; der Ausschlag kommt beim Zeichnen dazu. */
  y: number;
  /** Perspektivfaktor: 1 ganz vorn, 0 am Horizont. Aus ihm folgt alles Weitere. */
  df: number;
  /** Seitenlage in der Welt — der Schirm ist gestaucht, die Welt ist es nicht. */
  u: number;
  /** Tiefe in der Welt; in ihr sind alle Zeilen gleich weit auseinander. */
  v: number;
  /** Ausschlag in Pixeln, ±14 hinten bis ±70 vorn. */
  amp: number;
  /** Durchmesser in Pixeln, 2,0 hinten bis 6,2 vorn. */
  size: number;
  /** Grunddeckung, 16 % hinten bis 62 % vorn; die Höhe moduliert sie noch. */
  alpha: number;
};

// Die drei Schwingungen. Die erste läuft von hinten rechts nach vorne links —
// ihr Kamm wandert dorthin, wo (ax·u + av·v) kleiner wird.
//
// ⚠️ Die Laufrichtung steht in den VORZEICHEN von `ax` und `av` der ersten
// Zeile und nirgends sonst. Wer dort ein Minus setzt, dreht die ganze Welle um,
// ohne dass sich eine andere Zahl ändert.
//
// ⚠️ Und die drei Umlaufzeiten sind paarweise KEIN ganzzahliges Vielfaches
// voneinander: 13,5/9 = 1,5, 21/9 = 2,3̅, 21/13,5 = 1,5̅. Genau daher kommt der
// organische Eindruck — die Summe fällt erst nach dem kleinsten gemeinsamen
// Vielfachen der drei Zeiten wieder mit sich zusammen, und das sind hier 189 s
// (189/9 = 21, 189/13,5 = 14, 189/21 = 9). Wer die Zeiten auf ein Vielfaches
// zieht, etwa 9/18/27, holt sich diesen Punkt auf 54 s heran und bekommt eine
// sauber atmende Tapete zurück — ohne dass ein Test rot wird.
export type WavePart = {
  ax: number;
  av: number;
  len: number;
  period: number;
  weight: number;
};

export const WAVE_PARTS: readonly WavePart[] = [
  // Hauptwelle, hinten rechts nach vorne links
  { ax: 0.55, av: 0.85, len: 620, period: 9, weight: 1 },
  // Querwelle, gegen die erste
  { ax: -0.8, av: 0.35, len: 380, period: 13.5, weight: 0.5 },
  // lange, langsame Dünung, fast von hinten
  { ax: 0.1, av: 1, len: 1000, period: 21, weight: 0.75 }
];

const TAU = Math.PI * 2;

const TOTAL_WEIGHT = WAVE_PARTS.reduce((sum, part) => sum + part.weight, 0);

/**
 * Das Raster über einer gemessenen Fläche. Es wird bei jeder Größenänderung
 * neu gerechnet und nicht skaliert: ein gestrecktes Raster hätte hinten andere
 * Abstände, als die Perspektive verlangt.
 */
export function createWaveField(width: number, height: number): WaveDot[] {
  const horizon = height * HORIZON_RATIO;
  const dots: WaveDot[] = [];

  for (let row = 0; row < ROW_COUNT; row++) {
    const t = row / (ROW_COUNT - 1);
    const df = Math.pow(1 - t, DEPTH_EXPONENT);
    const y = horizon + (height + GRID_STEP - horizon) * df;
    const spacing = Math.max(GRID_STEP * (0.4 + 0.6 * df), MIN_SPACING);
    // In der Welt liegen die Zeilen gleich weit auseinander; auf dem Schirm
    // rücken sie zum Horizont hin zusammen. Liefe die Welle über den
    // Schirmabstand, wäre sie hinten schneller als vorn.
    const worldDepth = row * GRID_STEP * 1.7;

    // Eine halbe Rasterweite über beide Ränder hinaus, damit am Rand kein
    // Punkt fehlt, sobald der Ausschlag ihn ins Bild schiebt.
    for (let x = -GRID_STEP; x <= width + GRID_STEP; x += spacing) {
      dots.push({
        x,
        y,
        df,
        u: (x - width / 2) / (0.4 + 0.6 * df),
        v: worldDepth,
        // ⚠️ Der Ausschlag ist größer als der Zeilenabstand — benachbarte
        // Zeilen überschneiden sich. Das ist gewollt: erst dadurch sieht man
        // eine Fläche und keine Reihen. Wer ihn zurücknimmt, weil sich Punkte
        // „überlagern", nimmt der Welle genau das, was sie zur Welle macht.
        amp: 14 + 56 * df,
        size: 2 + 4.2 * df,
        alpha: 0.16 + 0.46 * df
      });
    }
  }

  return dots;
}

/**
 * Die Höhe eines Punktes zu einem Zeitpunkt, im Bereich −1 bis 1: die
 * gewichtete Summe der drei Schwingungen, geteilt durch die Summe der
 * Gewichte.
 */
export function waveHeight(dot: WaveDot, time: number): number {
  let sum = 0;
  for (const part of WAVE_PARTS) {
    sum +=
      part.weight *
      Math.sin(TAU * ((part.ax * dot.u + part.av * dot.v) / part.len + time / part.period));
  }
  return sum / TOTAL_WEIGHT;
}
