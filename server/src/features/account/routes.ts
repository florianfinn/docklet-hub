import type { Router } from "express";
import type { Pool } from "pg";

import type { Auth } from "../../platform/auth/auth.js";
import { requireAdmin } from "../../platform/auth/require-admin.js";
import { failWith, guarded } from "../../platform/http/route-responses.js";
import { withSession } from "../../platform/auth/session.js";
import { changeLanguage, readSetupOpen } from "./service.js";
import { listUserAccounts } from "./users.js";

// The routes of the feature `account` (#269): the own session (whether a first
// sign-in is open, who is signed in, and the one setting everyone may change
// on their own account without being an administrator, the language of the
// interface) and the list of accounts of the page "Benutzer & Profil" (D6b).
// They took the place of the groups `session-routes` (#5, B4a-A1) and
// `user-routes`, which stood next to each other in the router, so no route
// moved. The session is not a hosts or marks matter: all of it concerns the
// account of the caller or the accounts themselves.
//
// ⚠️ `PUT /session/language` ist dabei die einzige schreibende Route dieses
// Routers, die NICHT `requireAdmin` verlangt
// (`web/tests/api-read-only.test.mjs`, `SESSION_ONLY_WRITE`). Sie steht
// deshalb ausdrücklich hinter `withSession` als erster Zwischenschicht und
// liest die Kennung, an der sie schreibt, aus der SITZUNG (`user.id`) und aus
// keinem Feld des Rumpfs — wer das beim nächsten Umbau ändert, öffnet den
// Weg, über den ein Benutzer die Oberfläche eines anderen umstellt.

export function registerAccountRoutes(router: Router, { auth, pool }: { auth: Auth; pool: Pool }): void {
  // Ob die Erstanmeldung offensteht. Ohne Anmeldung erreichbar, und das muss
  // sie sein: die Oberfläche fragt sie, BEVOR es ein Konto gibt.
  //
  // Sie verrät dabei nichts, was nicht ohnehin sichtbar wäre — dass ein
  // frischer Hub frisch ist, sieht auch, wer den Anmeldebildschirm aufruft.
  router.get("/setup", (_request, response, next) => {
    void (async () => {
      try {
        response.json({ open: await readSetupOpen(pool, new Date()) });
      } catch (error) {
        next(error);
      }
    })();
  });

  router.get(
    "/session",
    withSession(auth, (_request, response, user) => {
      response.json({ user });
    })
  );

  // Die Sprache des eigenen Kontos setzen.
  //
  // ⚠️ Hinter `withSession` und nicht hinter `requireAdmin` — siehe den
  // Dateikopf. Das Konto, an dem geschrieben wird, ist das der Sitzung und
  // kommt NICHT aus dem Rumpf: eine `userId` im Rumpf machte aus dieser Route
  // den Weg, über den ein Benutzer die Oberfläche eines anderen umstellt.
  //
  // ⚠️ Sie ist zugleich der einzige Schreibweg auf die Spalte. Der
  // Aktualisierungsweg von better-auth führt nicht dorthin, weil das Feld
  // `input: false` trägt (auth/schema-source.ts) — deshalb steht die Prüfung
  // des Werts hier und muss hier stehen.
  //
  // 204 und kein Rumpf: die Antwort trägt nichts, was der Aufrufer nicht schon
  // wüsste — er hat den Wert gerade selbst geschickt.
  router.put(
    "/session/language",
    withSession(auth, async (request, response, user) => {
      const result = await changeLanguage(pool, user.id, request.body);
      if (result.kind === "invalid-body") {
        failWith(response, 400, "invalid-input", "Der Rumpf der Anfrage ist kein JSON-Objekt.");
        return;
      }
      if (result.kind === "invalid-language") {
        failWith(response, 400, "invalid-input", "„language“ ist „de“ oder „en“.");
        return;
      }
      response.status(204).end();
    })
  );

  // The list of accounts. READING and still behind `requireAdmin`: who else has
  // an account on this hub, when they were last here and how many sessions are
  // open is what an attacker picks the next target by. "User reads, admin
  // writes" (#17) says who may write, not that everybody may read everything.
  //
  // ⚠️ It is NOT in `GET_ROUTES_WITH_EFFECT` (`platform/http/request-origin.ts`):
  // that list holds GETs that CHANGE something (`GET /hosts/:hostId/archive`
  // rotates), and this one changes nothing. `web/tests/api-read-only.test.mjs`
  // demands a `requireAdmin` route for every ENTRY of the list, never an entry
  // for every `requireAdmin` route, and the origin check reads the list too
  // (`hasEffect`): an entry here would refuse a read that someone else
  // triggered.
  router.get(
    "/users",
    requireAdmin(auth),
    guarded(async (_request, response) => {
      response.json({ users: await listUserAccounts(pool) });
    })
  );
}
