// Die Gründe, die DIESER HUB selbst in eine `error`-Zeile schreibt — für den
// Log-Strom und den Shell-Strom an einer Stelle.
//
// ⚠️ SIE SIND WÖRTER DES HUBS UND KEINE DES AGENTEN — darum stehen sie hier
// und nicht unter `contract/src/agent/`. They are what the hub tells the
// browser, so they live in `contract` since #271 (until then in
// `server/src/platform/streams/`, and the web's guards imported them from
// the server: the last imports from `web/` into `server/`). Bis #130 (Log-Strom) und #173 (Shell-Strom) schrieb
// der Hub an diesen Stellen `abgebrochen`, und das war der Wert, mit dem der
// Agent bis v0.23.0 ausschließlich „der Aufrufer hat abgebrochen" meinte. Der
// Browser konnte einen Ausfall des Arms damit nicht von seinem eigenen Abbruch
// unterscheiden: zwei verschiedene Vorgänge, ein Wort.
//
// ⚠️ ENGLISCH, weil der Hub sie selbst erfindet (AGENTS.md, Abschnitt
// Sprache) — wie `too-many-streams`, `host-unknown` und `agent-unreachable`.
//
// ⚠️ KEINER DARF MIT EINEM WERT DES AGENTEN ZUSAMMENFALLEN. Fiele einer mit
// einem zusammen, stünde derselbe Wortlaut für zwei verschiedene Ereignisse,
// und die Anzeige entschiede sich zwangsläufig für das falsche. Ein Wächter
// hält die Sätze auseinander (`web/tests/hub-stream-reasons.test.mjs`).
//
// ⚠️ EIN ABBRUCH DES BROWSERS HAT HIER KEINEN WERT, und das ist die Sache
// selbst: die Verbindung, auf der die Zeile ankommen müsste, ist genau die,
// die gerade zugegangen ist. Beide Routen schweigen dann (#130, #173) —
// derselbe Schluss wie beim Agenten seit v0.24.0 (`dashboard-docker-agent#80`).

/**
 * Die Leitung zum Arm ist geendet, ohne dass jemand einen Abschluss gesagt
 * hat — nachdem der Status längst vergeben ist.
 *
 * Der Zusatz `agent-` sagt, WORAN es lag: nicht am Browser und nicht am Hub,
 * sondern an der Strecke zum Arm. Im Shell-Strom trägt er ZWEI Vorgänge, die
 * der Hub nicht weiter aufschlüsseln kann: einen Rumpf, der mit einem Fehler
 * abreißt, und den Ausgang `unterminated` des Agenten, der nicht vom Hub
 * ausgelöst war (der Agent hat zurückgestaut oder den Strom fallen lassen).
 * Der Mensch macht bei beiden dasselbe — neu verbinden —, und eine
 * Unterscheidung, die nur der Agent in seinem Audit-Log kennt, erfände dieser
 * Wert bloß.
 */
export const HUB_STREAM_BROKEN = "agent-stream-broken";

/**
 * Der Hub hat die Shell selbst beendet: über `…/exec/:session/close` oder den
 * Sweep nach der Höchstdauer — und der Browser hört noch zu.
 *
 * ⚠️ NICHT DASSELBE WIE `HUB_STREAM_BROKEN`. Hier ist nichts gerissen; es gibt
 * einen Auftrag, und er ist ausgeführt. Wer beides gleich beschriftet, schickt
 * einen Menschen auf Fehlersuche, der gerade selbst geschlossen hat.
 */
export const HUB_SESSION_CLOSED = "session-closed";

/**
 * Die wiederholte Rechteprüfung neben einer laufenden Shell hat kein Recht
 * mehr gefunden (`features/shell/permission-watch.ts`, `startPermissionWatch`). Bis #173 hieß der Wert
 * `recht-entzogen`.
 */
export const HUB_PERMISSION_REVOKED = "permission-revoked";

/** Alle Gründe des Hubs im Log-Strom. */
export const HUB_LOG_STREAM_REASONS: readonly string[] = [HUB_STREAM_BROKEN];

/** Alle Gründe des Hubs im Shell-Strom — der Agent schickt dort keinen. */
export const HUB_SHELL_STREAM_REASONS: readonly string[] = [
  HUB_STREAM_BROKEN,
  HUB_SESSION_CLOSED,
  HUB_PERMISSION_REVOKED
];

/**
 * Alle Gründe des Hubs im Anwende-Strom (#176). Der Agent schickt dort seine
 * eigenen, und die reicht die Route wörtlich durch; dieser hier steht nur, wenn
 * keiner von ihm kam — der Strom ohne Abschlusszeile, ein abgerissener Rumpf,
 * ein Ausfall des synchronen Rückfalls nach der `start`-Zeile.
 */
export const HUB_COMPOSE_STREAM_REASONS: readonly string[] = [HUB_STREAM_BROKEN];

// ⚠️ EIN FEHLENDER GRUND HAT KEINEN WERT, sondern `null` (#176). Schickt die
// Gegenseite eine `error`-Zeile ohne `reason`, schreibt weder Hub noch
// Browser ein Wort hinein. Bis #176 stand dort `unbekannt`: deutsch, in dem
// Feld, in dem sonst die Werte des Agenten stehen, und auf dem Bildschirm als
// Klammer „(unbekannt)" — das sah aus wie eine Auskunft und war keine. Die
// Anzeige hat für `null` einen eigenen Satz ohne Klammer.
