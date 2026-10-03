// Welchen Farbton und welchen Farbeinsatz ein Host trägt.
//
// D0 hat den Host zur Hauptachse des Farbsystems gemacht
// (docs/design/hub-color-and-structure.md §1): eine Farbe, die den Arm
// benennt, trägt die Information, deren Verwechslung den Schaden macht.
//
// ⚠️ WAS SICH IN D7a GEÄNDERT HAT. Bis D6b rechnete diese Datei den Ton aus
// der Kennung des Hosts (`hostHue`, FNV-1a über die `id`). Das war von Anfang
// an als Platzhalter mit Ablaufdatum beschrieben, und zwar aus einem Grund,
// den #75 beziffert hat: bei drei Armen bekommen etwa 44 von 100 Läufen
// zweimal denselben Ton (1 − 6/6 × 5/6 × 4/6). Eine Kennfarbe, die zwei Arme
// teilen, benennt nichts mehr. Ab D7a kommt der Ton aus der Ablage — der
// Betreiber vergibt ihn im Editor, der Server gibt ihn an der HostView als
// `display` heraus, und diese Datei liest ihn nur noch.
//
// ⚠️ WARUM ES KEINEN RÜCKFALL AUF DIE GERECHNETE FARBE GIBT. Ein Arm, dem
// noch niemand eine Farbe gegeben hat, steht auf `DEFAULT_HOST_THEME`, also
// auf „neutral" — grau. Bestehende Arme werden NICHT rückwirkend eingefärbt:
// D0 §2 sagt „der Betreiber vergibt", und ein automatisch zugeteilter Ton
// wäre genau die Zufallsfarbe, die #75 als Platzhalter kennzeichnet. Die
// Liste sieht deshalb nach D7a zunächst grauer aus als vorher, bis jemand im
// Editor Farben vergibt. Das ist der sichtbare Teil einer Entscheidung und
// kein Fehler — wer ihn mit einem Rückfall auf die alte Rechnung zudeckt,
// holt die Doppelfarben zurück, die dieses Paket gerade abgeschafft hat.
//
// Die Namen der Töne und der Stufen stehen NICHT hier, sondern in
// `contract/src/presets.ts` — der einen Quelle, gegen die der Server
// prüft und aus der der Editor zeichnet. Eine zweite Liste an dieser Stelle
// wäre die Fassung, die beim nächsten Ton abweicht.
//
// ⚠️ Der Importpfad ist gemessen und nicht abgeschrieben: von
// `web/src/domain/hosts/` sind es VIER Schritte hinauf bis zur Wurzel des
// Repos. Eine Datei eine Ebene unter `web/src/` braucht drei.

import { DEFAULT_HOST_THEME, type HostThemePreset } from "contract";

/**
 * Die Farbe eines Arms, wie sie an die Karte gehört.
 *
 * ⚠️ Der Parameter nimmt `display` ausdrücklich als „darf fehlen": der Typ der
 * HostView führt das Feld, aber die Antwort eines älteren Servers kennt es
 * nicht. Ohne diesen Zweig stünde dann gar kein `data-hue` in der Seite, und
 * die Karte trüge lautlos den Grundton des Hauses statt einer Kennfarbe. Mit
 * ihm steht dort „neutral" — dieselbe Antwort wie bei einem Arm, dem noch
 * niemand eine Farbe gegeben hat, und damit eine, die der Betreiber im Editor
 * beantworten kann.
 */
export function hostDisplay(host: { display?: HostThemePreset }): HostThemePreset {
  return host.display ?? DEFAULT_HOST_THEME;
}
