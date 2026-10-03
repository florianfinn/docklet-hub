import type { NextFunction, Request, Response } from "express";

import { buildContentSecurityPolicy } from "./content-security-policy.js";

// Die Zwischenschicht, die die CSP ausliefert. Sie trifft KEINE Entscheidung —
// die ganze Liste steht daneben in `content-security-policy.ts` und ist dort
// ohne Server prüfbar. Dieselbe Bauart wie `api/request-origin-guard.ts`
// gegenüber `api/request-origin.ts`.
//
// ── ⚠️ WO SIE HÄNGT, UND WARUM DORT ────────────────────────────────────────
//
// App-weit als erste Zwischenschicht in `index.ts`, direkt nach
// `const app = express()`. Tragen muss sie die AUSLIEFERUNG DES DOKUMENTS
// (`express.static` und `createIndexFallback`) — nur dort gibt es ein
// Dokument, auf das ein Browser eine CSP überhaupt anwendet. Dass sie
// zusätzlich auf `/api`, `/api/auth` und `/health` liegt, ist die Antwort auf
// die Frage „auch dort?", und sie lautet ja, aus drei Gründen:
//
//   1. Ein Kopf auf einer JSON-Antwort schadet nicht. Es gibt kein Dokument,
//      auf das der Browser die Direktiven anwenden könnte; er liest sie und
//      hat nichts zu tun.
//   2. `frame-ancestors 'none'` wirkt sehr wohl: es hält auch eine
//      JSON-Antwort aus einem fremden Rahmen heraus.
//   3. Und der eigentliche Grund: eine Schicht, die überall liegt, kann beim
//      nächsten neuen Auslieferungsweg nicht vergessen werden. Läge sie nur
//      im `if (existsSync(webRoot))`-Zweig, hinge die ganze Zusage an einem
//      Verzeichnis, das im Entwicklungsbetrieb regelmässig fehlt — und die
//      Frage „warum nur dort" wäre teurer als der Kopf.
//
// ⚠️ Sie steht VOR `app.all("/api/auth/*splat", …)`. Ein `setHeader` bleibt an
// der Antwort, auch wenn ein späterer Handler sie schreibt; hinter dem
// Anmeldeweg gehängt trüge dessen Antwort den Kopf dagegen nicht.
//
// ── WAS SIE NICHT TUT ──────────────────────────────────────────────────────
//
// Sie liest nichts aus der Anfrage und unterscheidet keine Pfade. Eine CSP,
// die je nach Pfad anders lautete, wäre eine Zusage, die man nur noch mit dem
// Router in der Hand lesen kann — und die Anwendung ist ohnehin EIN Dokument.
// Sie setzt auch keinen `Report-Only`-Kopf: er meldete Verstösse, ohne sie
// abzuwehren, und die Meldung ginge an eine Sammelstelle, die es hier nicht
// gibt.

/**
 * Der Name der Kopfzeile. Als Konstante, damit der Test denselben Namen prüft,
 * der auch gesetzt wird — und ein Tippfehler nicht auf beiden Seiten steht.
 */
export const CONTENT_SECURITY_POLICY_HEADER = "Content-Security-Policy";

/**
 * Hängt die CSP an jede Antwort. Die Zeichenkette wird EINMAL beim Bau der
 * Zwischenschicht gebildet und nicht je Anfrage: sie hängt an nichts, was sich
 * zwischen zwei Anfragen ändert.
 */
export function createContentSecurityPolicyHeader(): (
  request: Request,
  response: Response,
  next: NextFunction
) => void {
  const policy = buildContentSecurityPolicy();
  return (_request, response, next) => {
    response.setHeader(CONTENT_SECURITY_POLICY_HEADER, policy);
    next();
  };
}
