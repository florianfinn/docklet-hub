// Die Anordnung der Hosts auf „Übersicht", „Container" und „Hosts" — der
// Gruppen der beiden ersten und der Host-Karten der dritten. Sie steht hier
// und nicht in einem der Unterordner, weil sie keiner der drei Flächen gehört.
//
// Die Gruppen stehen nebeneinander, sobald die Breite eine zweite Spalte von
// mindestens 30rem trägt, und sonst untereinander. `auto-fill` und nicht
// `auto-fit`: ein einzelner Host bleibt eine Spalte breit, statt eine
// 21:9-Zeile zu füllen, in der Name und Statustext weit auseinanderstehen.
//
// ⚠️ `items-start`: eine aufgeklappte Stack-Zeile verlängert nur ihre Gruppe.
// Mit der Vorgabe `stretch` wüchse der Nachbar in derselben Rasterzeile als
// leere Fläche mit.
//
// ⚠️ `min(100%, 30rem)`: schmaler als 30rem wird die Spalte nur, wenn die
// Fläche selbst schmaler ist — ohne das `min` liefe das Raster auf einem
// Telefon seitlich aus dem Bild.
export const HOST_GRID_CLASS =
  "grid grid-cols-[repeat(auto-fill,minmax(min(100%,30rem),1fr))] items-start gap-4";

// Die Breite der ganzen Fläche. Bis hierher stand `max-w-4xl` (56rem) — das
// ließ auf einem breiten Bildschirm keinen Platz für eine zweite Spalte.
export const HOST_SCREEN_CLASS = "mx-auto flex w-full max-w-[120rem] flex-col gap-5 px-8 py-7";
