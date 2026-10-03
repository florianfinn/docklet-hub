// Ein Zeitpunkt für die Oberfläche: absolut („29.09.26, 22:15“) und als Alter
// („vor 3 Minuten“) (#205).
//
// ⚠️ ÜBER `Intl` UND NICHT ÜBER `useFormatter` von use-intl. Dessen
// Datumsformat verlangt eine Zeitzone am `IntlProvider` und meldet ohne sie
// bei jedem Aufruf einen Fehler auf der Konsole; die Zeitzone des Browsers ist
// hier aber genau die richtige. `Intl` nimmt sie ohne Angabe.

const STEPS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", Number.POSITIVE_INFINITY]
];

/** „vor 3 Minuten“, „jetzt“, „gestern“ — in der Sprache der Oberfläche. */
export function formatAgo(language: string, at: Date, now: Date): string {
  // Eine Uhr des Hubs, die ein paar Sekunden vor der des Browsers geht, ergäbe
  // sonst „in 4 Sekunden“ für etwas, das eben geschehen ist.
  let value = Math.min(0, (at.getTime() - now.getTime()) / 1_000);
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  for (const [unit, size] of STEPS) {
    if (Math.abs(value) < size) return format.format(Math.round(value), unit);
    value /= size;
  }
  return format.format(Math.round(value), "day");
}

/** „29.09.26, 22:15“ — Datum und Uhrzeit, kurz, in der Zeitzone des Browsers. */
export function formatDateTime(language: string, at: Date): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" }).format(at);
}

/** „22:15:04“ — nur die Uhrzeit, mit Sekunden. */
export function formatClock(language: string, at: Date): string {
  return new Intl.DateTimeFormat(language, { timeStyle: "medium" }).format(at);
}
