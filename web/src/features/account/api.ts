// The calls of the feature `account` (#269): the list of accounts of the page
// "Benutzer & Profil" and the two ways into the hub, the first sign-in and the
// sign-in. Until #269 they stood in `web/src/api/client.ts`; a feature imports
// nothing from `web/src/api/`, so they moved along. The own session, the setup
// state and signing out are in `platform/session/api.ts` since #271: `App.tsx`
// and the shell ask for them, and neither is a feature.

import type { Role } from "../../platform/session/session-user";
import { postJson, request } from "../../platform/http/transport";

// Ein Konto in der Liste der Fläche „Benutzer & Profil" (D6b, #62).
//
// ⚠️ Die Form ist an `server/src/features/account/users.ts` (Typ `UserAccount`)
// NACHGEMESSEN und nicht abgeschrieben. Zwei Felder tragen dort eine
// Begründung, die hier mitgelesen werden muss:
//
//   * `lastSignInAt` ist ABGELEITET (`MAX("session"."createdAt")`) und
//     ausdrücklich `null`, solange sich niemand mit diesem Konto angemeldet
//     hat. Das ist kein fehlender Wert, sondern die Antwort „nie" — und die
//     Oberfläche zeigt genau die, statt ein leeres Feld.
//   * `sessionCount` zählt nur die NOCH GÜLTIGEN Sitzungen
//     (`"expiresAt" > now()`). Der Server gibt eine Zahl heraus und keine
//     Zeichenkette; das `Number()` dafür steht dort.
export type UserAccount = {
  id: string;
  name: string;
  email: string;
  role: Role;
  lastSignInAt: string | null;
  sessionCount: number;
};

// Die Konten des Hubs.
//
// ⚠️ DIESE ROUTE STEHT HINTER `requireAdmin` (server/src/features/account/
// routes.ts). Wer keine Adminrolle trägt, bekommt 403 — und deshalb fragt die
// Fläche sie für ihn GAR NICHT ERST (`useAccounts`, `enabled`). Ein Aufruf, von
// dem im Voraus feststeht, dass er abgelehnt wird, ist keine Prüfung, sondern
// ein Fehler mit Anlauf: er kostet eine Anfrage, erzeugt eine 403 im
// Serverprotokoll und endet in einer Meldung, die niemandem etwas sagt.
export function fetchUsers(): Promise<{ users: UserAccount[] }> {
  return request("/api/users");
}

// Die zwei Wege in die Anmeldung liegen bei better-auth unter /api/auth. Sie
// stehen hier als Funktionen und nicht als Zeichenketten an der Aufrufstelle:
// ein Tippfehler in einem Pfad ergibt sonst eine 404, die wie ein Serverfehler
// aussieht.
export function signUp(input: { name: string; email: string; password: string; applyComposeDefinition: boolean }): Promise<unknown> {
  return postJson("/api/auth/sign-up/email", input);
}

export function signIn(input: { email: string; password: string }): Promise<unknown> {
  return postJson("/api/auth/sign-in/email", input);
}
