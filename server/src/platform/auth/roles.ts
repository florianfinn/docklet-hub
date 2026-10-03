// Die zwei Rollen dieses Systems — und sonst nichts.
//
// Das Quellsystem trägt einen Katalog aus neun Scopes samt Gruppen-Abbildung.
// Er ist dort richtig: ein Mehrbenutzer-Dashboard mit externer
// Veröffentlichung braucht die Auflösung. Hier ist er es nicht
// (concept-and-plan.md §2) — die Vereinfachung ist der Zweck der Trennung und
// kein Kompromiss, den man später „richtig" macht.
//
// Deshalb steht die Rolle als Aufzählung da und nicht als Menge von Rechten:
// eine Menge lädt dazu ein, ihr ein weiteres Element hinzuzufügen, eine
// Aufzählung nicht.

export const ROLES = ["admin", "user"] as const;

export type Role = (typeof ROLES)[number];

// Die Rolle eines frisch angelegten Kontos. Sie steht auch als Vorgabe in der
// Spalte (002-auth.sql) — hier noch einmal, weil der Wert im Code gebraucht
// wird, bevor die Zeile existiert.
export const DEFAULT_ROLE: Role = "user";

/**
 * Liest eine Rolle aus einem Wert, der aus der Datenbank oder aus einer
 * Sitzung kommt.
 *
 * Fail closed: was nicht als Rolle erkennbar ist, ist die kleinere Rolle und
 * nicht die größere. Ein `null` in der Spalte — etwa aus einer Zeile, die vor
 * einer künftigen Migration entstand — macht damit keinen Admin.
 */
export function toRole(value: unknown): Role {
  return value === "admin" || value === "user" ? value : DEFAULT_ROLE;
}

export function isAdmin(value: unknown): boolean {
  return toRole(value) === "admin";
}
