// Wann die Erstanmeldung offensteht — und wann nicht mehr.
//
// Es gibt ZWEI Wege zum Admin, und sie werden gern verwechselt (Issue #3):
//
//   1. Die Erstanmeldung. Sie gilt dem frischen Betrieb: solange kein Konto
//      existiert, darf sich das erste anlegen, und es wird Admin. Danach ist
//      der Weg zu — nicht abschaltbar, nicht konfigurierbar, sondern zu.
//   2. Das Break-Glass. Es gilt dem ausgesperrten Betrieb und läuft ohne
//      Weboberfläche (server/src/platform/auth/break-glass.ts). Das System, über das
//      man sich sonst wieder hereinließe, ist ja genau dieses.
//
// Diese Datei trägt den ersten Weg, und zwar nur die Entscheidung: ob offen
// oder zu. Wer die Zeilen liest und schreibt, steht in setup-store.ts. Getrennt,
// weil die Entscheidung die Stelle ist, an der man sich irren kann, und weil
// sie ohne Datenbank prüfbar sein muss (AGENTS.md, Tests).

// Wie lange ein belegter Platz gilt, dem kein Konto folgte.
//
// Der Fall entsteht, wenn die Erstanmeldung nach dem Belegen scheitert — ein
// zu kurzes Passwort etwa. Ohne Frist bliebe der Betreiber danach vor einem
// System stehen, in dem es noch nichts zu schützen gibt, und käme nur über das
// Break-Glass wieder herein. Mit Frist kostet derselbe Fehler eine Wartezeit.
//
// Zehn Minuten sind lang genug, dass zwei gleichzeitige Anfragen sich nicht
// überholen, und kurz genug, dass niemand aufgibt.
export const CLAIM_STALE_AFTER_MS = 10 * 60 * 1000;

export type SetupState = {
  // Ob mindestens ein Konto existiert. Sobald das gilt, ist der Weg für immer
  // zu — unabhängig von jedem Platz.
  userExists: boolean;
  // Wann der Platz belegt wurde, oder `null`, wenn er frei ist.
  claimedAt: Date | null;
};

export type SetupDecision =
  | { open: true }
  | { open: false; reason: "users-exist" | "claim-held" };

/**
 * Entscheidet, ob die Erstanmeldung offensteht.
 *
 * ⚠️ Diese Funktion entscheidet, sie belegt nicht. Das Belegen ist eine
 * einzige Anweisung in der Datenbank (setup-store.ts), weil zwei Schritte hier
 * ein Fenster wären: beide Anfragen sähen eine leere Tabelle, beide legten
 * einen Admin an.
 */
export function decideSetupAccess(
  state: SetupState,
  now: Date,
  staleAfterMs: number = CLAIM_STALE_AFTER_MS
): SetupDecision {
  if (state.userExists) return { open: false, reason: "users-exist" };
  if (state.claimedAt === null) return { open: true };

  const age = now.getTime() - state.claimedAt.getTime();
  // Ein Platz aus der Zukunft — Uhren laufen auseinander, und der Hub steht
  // nicht auf demselben Rechner wie die Datenbank — gilt als frisch. Sonst
  // wäre eine vorgehende Datenbankuhr ein dauerhaft offener Weg.
  if (age < staleAfterMs) return { open: false, reason: "claim-held" };
  return { open: true };
}
