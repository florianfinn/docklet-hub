import { useEffect, useRef } from "react";

import "./dot-wave.css";
import { createWaveField, waveHeight, type WaveDot } from "./wave-field";

// Die Hülle um die Rechnung: Leinwand, Größe, Schleife, Farbe. Alles, was den
// Browser anfasst, steht hier — und nur hier. Die Nachbardatei `wave-field.ts`
// kennt weder React noch das DOM.
//
// ⚠️ Keine Eigenschaften. Der Aufruf ist `<DotWave />` — kein `width`, kein
// `color`, kein `speed`, auch kein `className`. Was das Bauteil wissen muss,
// misst es selbst; was es nicht messen kann, ist genau eine Variable der
// Palette (`--accent-foreground`, abgelesen über `.dot-wave-ink`). Ein Bauteil
// ohne Schnittstelle hat keine, die veralten kann — und der Rückbau ist zwei
// Handgriffe: diesen Ordner löschen, die Zeile in `AuthCard.tsx` streichen.

const TAU = Math.PI * 2;

// Ein Punkt von wenigen Pixeln gewinnt über dem Doppelten nichts mehr an
// Zeichnung, die Kosten wachsen aber im Quadrat: ungedeckelt trüge ein
// 3x-Schirm je Bild das 2,25-Fache an Bildpunkten.
const MAX_PIXEL_RATIO = 2;

export function DotWave() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inkRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const inkElement = inkRef.current;
    if (!canvas || !inkElement) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    // Die Farbe kommt aus der Palette und nie aus dieser Datei: das
    // Ablese-Element trägt `color: var(--accent-foreground)`, hier wird
    // abgelesen, was der Browser daraus gerechnet hat.
    //
    // ⚠️ Ein `fillStyle`, den der Browser nicht versteht, wird STILL verworfen
    // — die Leinwand zeichnete dann schwarz auf schwarz, und nichts meldete
    // etwas. Deshalb wird nach dem Setzen zurückgelesen.
    //
    // Verglichen wird dabei nicht mit der gesetzten Zeichenkette, sondern mit
    // dem Stand davor. Der Grund: der Getter gibt eine NORMALISIERTE
    // Schreibweise zurück, und ob die der Eingabe gleicht, hängt an der Farbe.
    // Gemessen am 2026-09-05 in Chromium, jeweils gesetzt und zurückgelesen:
    //
    //   oklch(0.86 0.033408 265) → oklch(0.86 0.033408 265)   zeichengleich
    //   rgba(0, 0, 0, 0.5)       → rgba(0, 0, 0, 0.5)         zeichengleich
    //   rgb(1, 2, 3)             → #010203                    normalisiert
    //   hsl(210 50% 60%)         → #6699cc                    normalisiert
    //   cornflowerblue           → #6495ed                    normalisiert
    //
    // Eine DECKENDE sRGB-Farbe kommt also in der kurzen Doppelkreuz-
    // Schreibweise heraus; was sich in sRGB nicht deckend darstellen lässt,
    // behält seine Form. Der Wert, den dieses Bauteil wirklich abliest, ist
    // heute der erste der Liste — ein Zeichenvergleich mit der Eingabe ginge
    // hier also gut.
    //
    // ⚠️ Aber nur HEUTE und nur, solange `--accent-foreground` eine
    // oklch-Farbe ist. Dreht die Palette den Ton auf einen deckenden
    // sRGB-Wert, normalisiert der Getter ihn zu Doppelkreuz, der
    // Zeichenvergleich schlüge bei einer völlig GÜLTIGEN Farbe fehl, und der
    // Grund bliebe für immer leer — ein Fehler, den niemand mehr mit der
    // Palette in Verbindung bringt. Der Vergleich gegen den Stand davor kennt
    // die Schreibweise gar nicht: bleibt der Stand unverändert, hat der
    // Browser den Wert verworfen, sonst hat er ihn genommen. Deshalb dieser
    // und nicht der kürzere.
    context.fillStyle = "transparent";
    const untouched = context.fillStyle;
    const ink = getComputedStyle(inkElement).color;
    context.fillStyle = ink;
    if (context.fillStyle === untouched) return;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

    let dots: WaveDot[] = [];
    let width = 0;
    let height = 0;
    let frame = 0;
    let startTime: number | null = null;

    const paint = (time: number) => {
      context.clearRect(0, 0, width, height);
      // Von hinten nach vorn: was näher ist, liegt oben.
      for (let index = dots.length - 1; index >= 0; index--) {
        const dot = dots[index];
        const rise = waveHeight(dot, time);
        // Ein Kamm ist größer und heller als ein Tal. Erst dadurch wandern
        // sichtbare Bänder über die Fläche, statt dass nur Punkte auf und ab
        // gehen — und erst dadurch bewegt sich der Hintergrund sichtbar anders
        // als der Vordergrund.
        const lift = (rise + 1) / 2;
        context.globalAlpha = dot.alpha * (0.15 + 0.85 * lift);
        const radius = (dot.size * (0.6 + 0.8 * lift)) / 2;
        context.beginPath();
        context.arc(dot.x, dot.y - rise * dot.amp, radius, 0, TAU);
        context.fill();
      }
    };

    const stop = () => {
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    };

    const step = (now: number) => {
      if (startTime === null) startTime = now;
      paint((now - startTime) / 1000);
      frame = requestAnimationFrame(step);
    };

    // ⚠️ `prefers-reduced-motion: reduce`: KEIN Grund. Nicht ein stehendes
    // Bild, sondern eine leere Fläche — die Schleife wird gar nicht erst
    // angeworfen, und was schon gezeichnet war, wird gelöscht.
    //
    // Die Entscheidung fiel gegen das Standbild, und zwar aus dem Zweck der
    // Einstellung: sie kommt vom Gerät desjenigen, der sich anmeldet, und wer
    // sie setzt, hat meist einen körperlichen Grund — vestibuläre Störung,
    // Migräne, Reisekrankheit. Weniger Bewegung heißt dort in aller Regel auch
    // weniger visuelles Rauschen, und 2.400 Punkte sind Rauschen, ob sie
    // wandern oder stehen. Ein Standbild hätte die halbe Zusage gehalten.
    //
    // Der Preis ist benannt und angenommen: zwei Leute bekommen denselben
    // Bildschirm verschieden beschrieben. Karte, Marke und Fußzeile tragen ihn
    // allein — sie sind der Bildschirm, der Grund ist Zierde.
    const run = () => {
      if (motion.matches) {
        stop();
        context.clearRect(0, 0, width, height);
        return;
      }
      if (frame === 0) frame = requestAnimationFrame(step);
    };

    const measure = () => {
      const box = canvas.getBoundingClientRect();
      // Eine Fläche von null Pixeln gibt es nicht: vor dem ersten Layout misst
      // der Kasten 0, und ein Raster über 0×0 hätte keinen Punkt. Der
      // Beobachter meldet gleich darauf die wirkliche Größe.
      const nextWidth = Math.max(Math.round(box.width), 1);
      const nextHeight = Math.max(Math.round(box.height), 1);
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth;
      height = nextHeight;

      const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      // ⚠️ Das Setzen von `width`/`height` setzt den Kontext ZURÜCK — Transform
      // und Farbe. Beide müssen danach neu stehen, sonst zeichnet die Leinwand
      // ab der ersten Größenänderung ungestaucht und schwarz.
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.fillStyle = ink;
      // Neu gerechnet, nicht skaliert: ein gestrecktes Raster hätte hinten
      // andere Abstände, als die Perspektive verlangt, und der Horizont läge
      // nicht mehr bei 33 % der neuen Höhe.
      dots = createWaveField(width, height);
    };

    const handleChange = () => {
      run();
    };

    // Die Größe kommt aus der gemessenen Fläche und nicht aus einer festen
    // Zahl: dasselbe Bauteil steht auf einem Telefon und auf einem breiten
    // Schirm.
    const observer = new ResizeObserver(() => {
      measure();
      run();
    });
    observer.observe(canvas);
    measure();
    run();

    // Abgehört, damit ein Umschalten im Betrieb ankommt — wer die Bewegung
    // während der Anmeldung abstellt, soll sie nicht bis zum Neuladen behalten.
    motion.addEventListener("change", handleChange);

    return () => {
      observer.disconnect();
      motion.removeEventListener("change", handleChange);
      // ⚠️ Ohne dieses Abmelden liefe die Schleife nach dem Anmelden weiter und
      // zeichnete in eine Leinwand, die niemand mehr sieht.
      stop();
    };
  }, []);

  return (
    <>
      <canvas ref={canvasRef} className="dot-wave" aria-hidden="true" />
      <span ref={inkRef} className="dot-wave-ink" />
    </>
  );
}
