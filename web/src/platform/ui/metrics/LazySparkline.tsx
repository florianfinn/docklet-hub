import { lazy, Suspense, type ComponentProps } from "react";

import type { Sparkline as SparklineComponent } from "./Sparkline";

// Die Sparkline, nachgeladen (#213, #214).
//
// ⚠️ NACHGELADEN, WEIL `recharts` GROSS IST. Gemessen am 2026-09-30 mit
// `pnpm --filter web run build`: das Hauptbündel wuchs mit einer fest
// importierten Sparkline von 805,53 kB (gzip 236,75 kB) auf 1.145,03 kB
// (gzip 337,76 kB). Die Übersicht nach der Anmeldung zeichnet keine
// Sparkline; sie soll dafür nicht bezahlen. Die Diagramme brauchen erst das
// Container-Detail und die Hosts-Seite.
//
// ⚠️ DER PLATZHALTER HAT DIE HÖHE DER LINIE (`h-12`, wie in `Sparkline`).
// Ohne ihn spränge die Karte beim Nachladen um eine Zeile.

const Sparkline = lazy(() => import("./Sparkline").then((module) => ({ default: module.Sparkline })));

export function LazySparkline(props: ComponentProps<typeof SparklineComponent>) {
  return (
    <Suspense fallback={<div className="h-12 w-full" aria-hidden="true" />}>
      <Sparkline {...props} />
    </Suspense>
  );
}
