// Entry kinds of the file-browser listing. A value of the agent, passed on
// word for word to the web.

/**
 * The kinds of a directory entry (`agent/src/webftp.ts`, `WebftpKind`).
 *
 * ⚠️ English since contract 6 (#278); German until then.
 * `changedAt` is a number in **seconds** since the epoch
 * (`Math.floor(stat.mtimeMs / 1000)` in `agent/src/webftp.ts`), not an ISO
 * text as `docs/design/phase-5-write-access.md` §6 says; measured against
 * `6ffc3c8`.
 *
 * ⚠️ HIER STAND „Millisekunden", nachgemessen am 2026-09-07. Der Wert kam aus
 * einem Auftrag und nicht aus der Quelle — und er ist der gefährlichere
 * Fehler: eine Sekundenzahl an `new Date` gegeben wirft nicht, sie liefert
 * einen Zeitpunkt kurz nach 1970. Keine Prüfkette dieses Repos wäre davon rot
 * geworden.
 */
export const WEBFTP_ENTRY_KINDS = ["file", "directory", "symlink", "other"] as const;

export type WebftpEntryKind = (typeof WEBFTP_ENTRY_KINDS)[number];
