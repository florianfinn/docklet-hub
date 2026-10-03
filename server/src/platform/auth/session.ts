import type { Request, RequestHandler, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";

import type { Auth } from "./auth.js";
import { toLanguage, type Language } from "./language.js";
import { toRole, type Role } from "./roles.js";

// Wer gerade fragt — und ob überhaupt jemand.
//
// ⚠️ Die Sitzung wird bei JEDER Anfrage neu aufgelöst, nicht einmal beim
// Anmelden gemerkt. Das ist der Unterschied zwischen „war angemeldet" und
// „ist angemeldet": ein gelöschtes Konto, eine abgelaufene oder vom
// Break-Glass beendete Sitzung wirkt damit sofort und nicht erst beim nächsten
// Neustart.
//
// Die Auflösung liegt hinter EINER Funktion, weil concept-and-plan.md §9 die
// Erweiterungsstelle für den optionalen Authentik-Trusted-Proxy hier vorsieht:
// eine Liste von Auflösern, von denen der erste antwortet. In dieser Phase ist
// es genau einer.

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  // Die Sprache der Oberfläche. Sie reist mit der Sitzung mit, weil die
  // Oberfläche sie bei JEDER Anfrage neu bekommt und nicht einmal beim
  // Anmelden — dieselbe Zusage wie bei der Rolle: „ist eingestellt" und nicht
  // „war eingestellt".
  language: Language;
};

export async function resolveSession(auth: Auth, request: Request): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session?.user) return null;
  const user = session.user as {
    id: string;
    name: string;
    email: string;
    role?: unknown;
    language?: unknown;
  };
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    // `toRole` ist fail closed: was nicht als Rolle erkennbar ist, ist die
    // kleinere Rolle (auth/roles.ts).
    role: toRole(user.role),
    // `toLanguage` ebenso: was nicht als Sprache erkennbar ist, ist die
    // Vorgabe (auth/language.ts). Eine Zeile, die vor 005-user-language.sql
    // entstand, zeigt damit eine deutsche Oberfläche und keine leere.
    language: toLanguage(user.language)
  };
}

export type SessionHandler = (
  request: Request,
  response: Response,
  user: SessionUser
) => Promise<void> | void;

/**
 * Umschließt eine Route, die eine Anmeldung verlangt.
 *
 * ⚠️ Bewusst ein Umschlag und keine Zwischenschicht (`app.use`), die den
 * Nutzer an die Anfrage hängt: eine Zwischenschicht muss auf jeden Pfad
 * gelegt werden, und der eine, der sie beim nächsten Umbau nicht bekommt,
 * fällt nicht auf. Hier ist die Anmeldung dagegen ein Argument der Route —
 * eine Route ohne sie hätte keinen Nutzer, und der Typcheck sagt das.
 *
 * Die Antwort ist knapp: ein 401 sagt „nicht angemeldet" und nicht, ob es das
 * Konto gibt, ob es gesperrt ist oder ob die Sitzung abgelaufen ist. Diese
 * Unterschiede sind für den Angemeldeten uninteressant und für jeden anderen
 * eine Auskunft.
 */
export function withSession(auth: Auth, handler: SessionHandler): RequestHandler {
  return (request, response, next) => {
    void (async () => {
      try {
        const user = await resolveSession(auth, request);
        if (!user) {
          response.status(401).json({ error: "unauthenticated" });
          return;
        }
        await handler(request, response, user);
      } catch (error) {
        next(error);
      }
    })();
  };
}
