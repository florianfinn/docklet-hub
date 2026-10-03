import type { Language } from "./languages";

// Wann sich ein Konto zuletzt angemeldet hat, als lesbare Zeit.
//
// Lives in `platform/i18n/` since #269: the page of accounts (feature `account`)
// and the start time of a container (`app/screens/ContainerScreen.tsx`) both use it,
// and a feature may not be imported by a screen's sibling feature.
//
// ⚠️ ABSOLUT UND NICHT RELATIV. Das Artboard schreibt „vor 2 Minuten", „vor 6
// Stunden", „vor 3 Tagen" (hub-palette.html Z. 748–751). Eine relative Angabe
// ist zur Ansichtszeit richtig und eine Minute später falsch, ohne dass sich
// etwas bewegt hätte — sie müsste an einem Zeitgeber hängen, der die Fläche
// im Takt neu zeichnet. Dafür gibt es hier keinen Anlass: die Liste wird
// gelesen, nicht überwacht. Der Zeitpunkt selbst bleibt dagegen wahr, solange
// er dasteht.
//
// Die Sprache kommt als Parameter und NICHT aus `navigator.language`: sie
// hängt am Konto (docs/design/language-layer.md), und ein Browser mit anderer
// Einstellung schriebe sonst das Datum in einer Ordnung, die zur Oberfläche
// daneben nicht passt.
export function formatSignInTime(iso: string, language: Language): string {
  const date = new Date(iso);
  // ⚠️ Ein unbrauchbares Datum wird DURCHGEREICHT und nicht verschluckt.
  // `Intl.DateTimeFormat.format` wirft bei `Invalid Date` einen RangeError,
  // und der risse die ganze Fläche mit. Was der Server geschickt hat, steht
  // dann so da, wie er es geschickt hat — das ist die Spur, an der sich ein
  // Formatfehler finden lässt.
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
