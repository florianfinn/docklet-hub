import type { Pool } from "pg";

import { toLanguage } from "../../platform/auth/language.js";
import { writeUserLanguage } from "../../platform/auth/language-store.js";
import { decideSetupAccess } from "../../platform/auth/setup-gate.js";
import { readSetupState } from "../../platform/auth/setup-store.js";

// The service of the feature `account` (#269): what the session routes decide
// between reading the request and writing the answer. The route reads the
// parameters, sets the status and writes the answer; `service.test.ts` checks
// the rest without Express and without Postgres.
//
// ⚠️ The outcome is a value with a `kind`, never a status code. Which status a
// `kind` becomes is the route's table; the service knows no HTTP.

/** Whether the first sign-in is open: no account exists and the window has not run out. */
export async function readSetupOpen(pool: Pool, now: Date): Promise<boolean> {
  return decideSetupAccess(await readSetupState(pool), now).open;
}

export type ChangeLanguageResult = { kind: "ok" } | { kind: "invalid-body" } | { kind: "invalid-language" };

/**
 * Sets the language of the account `userId`.
 *
 * ⚠️ `toLanguage` alone is NOT a check here: it fails closed and would turn
 * "fr" into "de" without a word. Reading, that is right; writing, it would be a
 * setting the user never chose, and they would see a German interface as the
 * answer to their wish for a French one. So the value that came in is compared
 * with what `toLanguage` made of it, and only then written.
 *
 * ⚠️ `userId` comes from the session and never from the body: a `userId` in the
 * body would make this the way for one user to switch the interface of another.
 */
export async function changeLanguage(pool: Pool, userId: string, body: unknown): Promise<ChangeLanguageResult> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { kind: "invalid-body" };
  const { language } = body as Record<string, unknown>;
  const requested = toLanguage(language);
  if (language !== requested) return { kind: "invalid-language" };
  await writeUserLanguage(pool, userId, requested);
  return { kind: "ok" };
}
