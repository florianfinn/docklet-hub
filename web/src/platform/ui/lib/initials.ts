// Eigene Datei, kein Herkunftskopf — nicht übernommen.
//
// Warum es sie gibt: dieselbe Rechnung lag am 2026-09-05 zweimal im Baum, in
// `web/src/features/account/AuthCard.tsx` und in `web/src/app/shell/AppSidebar.tsx`, beide
// Male byteidentisch (je 190 Zeichen, Prüfsumme
// 594c6a904e2695072b8fb09d237ed48b, gemessen mit `awk` auf den Rumpf und
// `md5sum`). Zwei Abschriften derselben Rechnung sind zwei Wahrheiten: wer
// die eine ändert, ändert die andere nicht, und niemand merkt es, weil beide
// für sich weiterlaufen.
//
// Die beiden Verwender sind der Markenblock der Seitenleiste
// (`AppSidebar.tsx`) und der über der Formularkarte (`AuthCard.tsx`).
//
// ⚠️ Das Kürzel wird GERECHNET und steht bewusst NICHT als Text in der
// Sprachdatei: ein „DV", das neben dem Namen steht, aus dem es kommt, wäre
// eine zweite Stelle, die bei jeder Umbenennung mitgepflegt werden müsste —
// und ein fest im JSX stehendes Literal, das der Wächter `ui-texts` zu Recht
// rot machte.

// Die Initialen aus einem Namen: der erste Buchstabe der ersten beiden
// Wörter.
//
// Getrennt wird an allem, was weder Buchstabe noch Ziffer ist —
// „Docker-Verwaltung" gibt deshalb „DV" und nicht „D". Ein Bild gibt es
// nicht: die CSP des Hubs ist `default-src 'self'`, ein externes Logo lädt
// schlicht nicht. Deshalb trägt auch der Markenblock nur ein Kürzel, keine
// Datei.
export function initials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.slice(0, 2).map((word) => word.slice(0, 1).toUpperCase()).join("");
}
