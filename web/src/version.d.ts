// Die Fassung des Hubs als globale Konstante.
//
// Sie kommt nicht über eine Route und nicht über einen Import, sondern wird
// beim Bauen eingesetzt: `define` in `web/vite.config.ts` liest sie im
// Node-Kontext aus der `package.json` der Repo-Wurzel und ersetzt den Namen
// hier durch die fertige Zeichenkette. Zur Laufzeit gibt es also keine
// Variable dieses Namens mehr — nur noch den Text, der an ihrer Stelle steht.
//
// Diese Datei liegt unter `src`, weil `tsconfig.json` genau das einliest
// (`include: ["src"]`). Läge sie daneben, kennte `tsc --noEmit` den Namen
// nicht und hielte jede Verwendung für einen Tippfehler.
//
// ⚠️ Der Wert kann der leere String sein: die Wurzel-`package.json` war nicht
// lesbar oder trug kein `version`. Wer ihn anzeigt, prüft darauf und zeigt
// dann nichts — kein Platzhalter, keine erfundene Nummer.

declare const __HUB_VERSION__: string;
