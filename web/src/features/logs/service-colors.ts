// Die Farbe eines Dienstes im gemischten Protokoll des Stacks.
//
// ⚠️ NACH STELLE UND NICHT NACH NAMEN. Ein Streuwert über den Namen gäbe zwei
// Diensten desselben Stacks ohne Weiteres dieselbe Farbe; die Stelle in der
// Liste des Stacks gibt den ersten acht acht verschiedene, und dieselbe Seite
// zeigt jedem Dienst bei jedem Öffnen dieselbe.
//
// ⚠️ KEIN ROT IN DER REIHE. Rot trägt im Feld die Stufe „Fehler"; ein Dienst in
// Rot sähe in jeder Zeile aus wie ein Fehler. Die Farben sind die des
// Terminals (`--terminal-ansi-*`) und folgen damit dem hellen und dem dunklen
// Schema.
//
// ⚠️ KEIN `data-hue`: der Wächter `web/tests/host-palette.test.mjs` hält jedes
// `data-hue` unter `web/src/app/screens/` am Weg über `hostDisplay(…)` — und das ist
// die Farbe eines Arms, nicht die eines Dienstes.

const SERVICE_COLORS = [
  "var(--terminal-ansi-cyan)",
  "var(--terminal-ansi-magenta)",
  "var(--terminal-ansi-green)",
  "var(--terminal-ansi-yellow)",
  "var(--terminal-ansi-blue)",
  "var(--terminal-ansi-bright-magenta)",
  "var(--terminal-ansi-bright-cyan)",
  "var(--terminal-ansi-bright-green)"
];

export function serviceColor(position: number): string {
  const index = ((position % SERVICE_COLORS.length) + SERVICE_COLORS.length) % SERVICE_COLORS.length;
  return SERVICE_COLORS[index];
}
