import type { FileCommandAction } from "contract";

import type { FileAction } from "./agent-client.js";

// The names of the three folder actions, on the hub's side and on the agent's.
// Moved out of the file routes in #262 so the service reads them without
// Express.

/**
 * Die Übersetzung der eigenen Aktionsnamen auf die Werte der Gegenseite.
 *
 * ⚠️ DIE RICHTUNG IST ABSICHT. Geschrieben steht `FileAction → eigener Name`
 * und nicht umgekehrt, weil nur diese Richtung mit `satisfies` vollständig
 * geprüft wird: kommt beim Agenten eine vierte Aktion dazu oder wird eine
 * umbenannt, meldet `tsc` diese Tabelle als unvollständig. Die Richtung, die
 * der Handler braucht, entsteht daraus einmalig weiter unten.
 *
 * ⚠️ THE KEYS ARE THE AGENT'S VALUES (`FILE_ACTIONS` in
 * `contract/src/agent/`), the values the names of the hub's API. Since #278
 * both are English and two of three are the same word; the table stays,
 * because `create-folder` and `create-directory` still differ and because it
 * is what `tsc` checks for completeness.
 */
const OWN_ACTION_NAMES = {
  "create-folder": "create-directory",
  "rename": "rename",
  "delete": "delete"
} satisfies Record<FileAction, FileCommandAction>;

/** Was ein Aufrufer schicken darf, und was daraus beim Agenten wird. */
export const AGENT_ACTIONS = new Map<string, FileAction>(
  (Object.entries(OWN_ACTION_NAMES) as [FileAction, string][]).map(([value, name]) => [name, value])
);
