import type { RequestHandler } from "express";

import { resolveSession } from "./session.js";
import type { Auth } from "./auth.js";

// „User liest, Admin schreibt" (#17, concept-and-plan.md §2) — als eine
// Zwischenschicht, die vor eine schreibende Route gehängt wird.
//
// Es gibt keine Einstellung dazu und keine Zwischenstufe. Zwei Rollen, eine
// Regel: wer schreibt, ist Admin. Die Shell in Phase 5 ist derselbe Fall und
// bekommt keine Ausnahme.
//
// ⚠️ WAS DIESE DATEI NICHT LEISTET, und wo ihre Fehlerklasse liegt:
//
// Eine Zwischenschicht wirkt nur dort, wo sie angemeldet ist. Eine schreibende
// Route, die ohne sie entsteht, ist nicht halb geschützt, sondern offen — und
// sie sieht im Diff genauso aus wie eine, die sie hat. Das ist derselbe
// Fehlermodus, den SECURITY.md (Grundsatz 2) für den Registrierungsweg
// beschreibt: still offen beim Vergessen.
//
// Solange die API vollständig lesend ist, hält `web/tests/api-read-only.test.mjs`
// den Deckel. Welle 3 nimmt ihn weg und schreibt in dieselbe Änderung den
// Wächter, der an seine Stelle tritt: eine schreibende Route ohne diese
// Zwischenschicht muss rot werden, nicht warnen.

export type AdminGuardOptions = {
  // Einspeisbar, damit die Regel ohne better-auth und ohne Datenbank prüfbar
  // ist. Der Regelweg lässt sie weg und bekommt die echte Auflösung.
  resolve?: typeof resolveSession;
};

/**
 * Lässt nur Admins durch.
 *
 * Fail closed in jedem Zweig, der nicht „ist Admin" heißt:
 *
 *   - keine Sitzung          → 401, kein `next()`
 *   - Sitzung mit Rolle user → 403, kein `next()`
 *   - Fehler beim Auflösen   → `next(error)`, also 500 aus dem Fehlerbehandler
 *
 * ⚠️ Der letzte Fall ist der, der leicht falsch gebaut wird: ein `catch`, das
 * die Anfrage weiterlaufen lässt, macht aus einer nicht erreichbaren Datenbank
 * einen offenen Schreibzugriff. Eine Sitzung, die sich nicht auflösen lässt,
 * ist keine.
 *
 * Die Rolle kommt über `toRole` herein und ist damit ebenfalls fail closed:
 * ein `null` in der Spalte wird zu `user`, nicht zu `admin` (auth/roles.ts).
 */
export function requireAdmin(auth: Auth, options: AdminGuardOptions = {}): RequestHandler {
  const resolve = options.resolve ?? resolveSession;
  return (request, response, next) => {
    void (async () => {
      try {
        const user = await resolve(auth, request);
        if (!user) {
          // Dieselbe knappe Antwort wie `withSession`: ein 401 sagt „nicht
          // angemeldet" und nicht, ob es das Konto gibt.
          response.status(401).json({ error: "unauthenticated" });
          return;
        }
        if (user.role !== "admin") {
          response.status(403).json({ error: "admin-required" });
          return;
        }
        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}
