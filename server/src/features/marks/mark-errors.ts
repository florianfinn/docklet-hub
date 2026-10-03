import type { Response } from "express";

import { failWith } from "../../platform/http/route-responses.js";
import { MarkError } from "./types.js";

// What leaves an error of the marks as an HTTP answer (D7b, #62). Moved here
// from `api/domain-errors.ts` with #268; that file is gone, as `handleHostError`
// and `contentDisposition` left it with #266.

/**
 * What leaves an error of the marks (D7b, #62).
 *
 * A translator of its own and not a branch in `handleHostError`
 * (`features/hosts/host-errors.ts`): the two errors come from different
 * inventories, and a shared translator would have to decide for every reason
 * which one it came from.
 *
 * Die Statuszuordnung: ein Name, den es schon gibt, ist ein 409 wie beim Arm;
 * eine Kennung, die es nicht gibt, ist ein 404. Beides sind Anfragen, die ein
 * Aufrufer stellen kann, und keine Programmierfehler.
 */
export function handleMarkError(error: unknown, response: Response): boolean {
  if (!(error instanceof MarkError)) return false;
  failWith(response, error.reason === "name-taken" ? 409 : 404, error.reason, error.message);
  return true;
}
