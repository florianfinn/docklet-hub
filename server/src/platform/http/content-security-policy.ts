// Die Content-Security-Policy des Hubs — die Direktivenliste als reine
// Funktion, ohne Express und ohne Netz.
//
// ── WOFÜR SIE STEHT ────────────────────────────────────────────────────────
//
// Die Herkunftsprüfung nebenan (`api/request-origin.ts`) hält ab, was von
// außen HEREIN wirkt. Die CSP hält ab, was aus dem ausgelieferten Dokument
// HERAUS geht: ein eingeschleustes `<script>`, ein Bild von einem fremden
// Server, ein `fetch` an eine fremde Adresse, das Einbetten der Anwendung in
// einen fremden Rahmen. Beide zusammen sind die Zusage, keine von beiden
// allein.
//
// Der Kopf kommt MIT Phase 5 und VOR den Logs (#28, Abschluss). Gemessen am
// 2026-09-07 hatte dieses Repo bis hierher keine CSP:
// `grep -rn "setHeader\|helmet\|Content-Security-Policy" server/src/` fand
// ausser drei Kopfzeilen am Host-Archiv nichts, und weder `helmet` noch `cors`
// stand in einer `package.json`.
//
// ── WARUM KEIN `helmet` ────────────────────────────────────────────────────
//
// Ein Paket für zwei Dutzend Zeilen, und AGENTS.md verlangt für jede
// Abhängigkeit eine Begründung. Was `helmet` hier zusätzlich brächte, sind
// Kopfzeilen, über die niemand entschieden hat — und eine Vorgabeliste, die
// sich mit der nächsten Nebenversion ändern kann, ohne dass es in diesem Repo
// im Diff steht. Die Liste unten ist die Entscheidung selbst, nicht ihre
// Auslieferung.
//
// ── ⚠️ DIE EINE LOCKERUNG, UND WARUM SIE KEINE BEQUEMLICHKEIT IST ──────────
//
// `style-src` behält `'unsafe-inline'`. Entschieden am 2026-09-04 in #28 (der
// dritte der vier dort erwogenen Wege). Der Grund ist gemessen: `@xterm` —
// das die Shell in Phase 5c mitbringt — schreibt zwei `<style>`-Elemente mit
// BERECHNETEM Inhalt in das Dokument: die Zellmasse bei jedem Resize neu, dazu
// die Themefarben. Die drei Auswege scheitern jeder an einer eigenen Stelle:
//
//   * Ein `nonce` setzt xterm nicht und bietet es auch nicht an — es gibt
//     keine Stelle, an der man ihm einen mitgäbe.
//   * Ein `sha256-` veraltet bei jedem Resize, denn der Inhalt ändert sich.
//   * Eine pfadgenaue Ausnahme gibt es nicht: die Anwendung ist EIN Dokument,
//     und die CSP gilt dokumentweit. Dass die Shell xterm erst beim Öffnen
//     ihres Reiters nachlädt, ändert daran nichts — sie lädt es in dasselbe
//     Dokument.
//
// ⚠️ Diese Lockerung gilt `style-src` und NUR `style-src`. Ein
// `'unsafe-inline'` in `script-src` wäre die ganze Zusage aufgegeben — dann
// dürfte jedes eingeschleuste `<script>` laufen. Ein eigener Fall in
// `content-security-policy.test.ts` hält das fest, damit es rot wird und nicht
// auffallen muss.

/**
 * Die Direktiven in der Reihenfolge, in der sie ausgeliefert werden — je eine
 * Zeile, je mit dem Satz, der sie trägt.
 *
 * Als Paarliste und nicht als Objekt: die Reihenfolge ist damit im Diff
 * sichtbar, und ein doppelter Name fiele beim Lesen auf statt still die
 * frühere Zeile zu überschreiben.
 */
export const CONTENT_SECURITY_POLICY_DIRECTIVES: readonly (readonly [string, string])[] = [
  // Der Rückfall für alles, was unten keine eigene Zeile hat. `'self'` und
  // nicht `'none'`: eine neue Ladeart soll aus dem eigenen Ursprung noch
  // gehen und erst dann auffallen, wenn sie nach außen greift.
  ["default-src", "'self'"],
  // Skripte nur aus dem eigenen Ursprung — ohne `'unsafe-inline'` und ohne
  // `'unsafe-eval'`. Das ist die Zeile, die ein eingeschleustes `<script>`
  // wirkungslos macht.
  ["script-src", "'self'"],
  // ⚠️ Die eine Lockerung, begründet im Dateikopf: #28 vom 2026-09-04, wegen
  // der berechneten `<style>`-Elemente von `@xterm` (Zellmasse je Resize,
  // Themefarben). Weder `nonce` noch `sha256-` noch eine pfadgenaue Ausnahme
  // trägt hier.
  ["style-src", "'self' 'unsafe-inline'"],
  // Bilder aus dem eigenen Ursprung, dazu `data:`. Gemessen am 2026-09-07
  // trägt der Bestand heute KEINE `data:`-URI
  // (`grep -rn "data:" web/src --include=*.ts --include=*.tsx --include=*.css`
  // findet nichts); die Erlaubnis steht als die eine Ladeart, die ein Bündler
  // für kleine Symbole von sich aus erzeugt, ohne dass es jemand schreibt.
  ["img-src", "'self' data:"],
  // Schriften nur aus dem eigenen Ursprung. Das ist keine Einschränkung,
  // sondern der bereits gebaute Zustand: `web/src/platform/theme/fonts.css` lädt
  // IBM Plex aus `@fontsource/*`, Vite bündelt die woff2-Dateien nach
  // `dist/assets/`. Ein Ladeversuch gegen fonts.gstatic.com fiele hier auf.
  ["font-src", "'self'"],
  // `fetch`, XHR, WebSocket und EventSource nur zum eigenen Ursprung. Der Hub
  // liefert Oberfläche und API von derselben Herkunft aus; ein `fetch` nach
  // außen ist hier immer ein Abfluss und nie ein Merkmal.
  ["connect-src", "'self'"],
  // `<object>`, `<embed>`, `<applet>`: keine. Es gibt keinen Fall dafür, und
  // sie sind der älteste Weg, an `script-src` vorbei Code auszuführen.
  ["object-src", "'none'"],
  // Ein eingeschleustes `<base href="…">` verbögte jeden relativen Pfad des
  // Dokuments auf einen fremden Server — auch die Skriptpfade. `'self'`
  // schließt das.
  ["base-uri", "'self'"],
  // Niemand darf den Hub in einen Rahmen setzen. Das ist der Schutz gegen
  // Clickjacking, und er ist hier besonders billig zu haben: es gibt keinen
  // Fall, in dem diese Oberfläche eingebettet gehört.
  ["frame-ancestors", "'none'"],
  // Ein Formular darf nur an den eigenen Ursprung abschicken. Sonst trüge ein
  // eingeschleustes `<form action="https://fremd/">` die Eingaben des
  // Betreibers — Anmeldedaten eingeschlossen — nach außen.
  ["form-action", "'self'"]
];

/**
 * Die Direktiven als eine Kopfzeile.
 *
 * Rein und ohne Express, damit jede Direktive einzeln prüfbar ist — dieselbe
 * Bauart wie `api/request-origin.ts` gegenüber `api/request-origin-guard.ts`,
 * und aus demselben Grund: die Liste ist der Gegenstand, die Zwischenschicht
 * nur ihre Auslieferung.
 */
export function buildContentSecurityPolicy(): string {
  return CONTENT_SECURITY_POLICY_DIRECTIVES.map(([name, value]) => `${name} ${value}`).join("; ");
}
