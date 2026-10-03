import type { NextFunction, Request, Response } from "express";

import { decideRequestOrigin } from "./request-origin.js";

// Die Zwischenschicht zur Herkunftsprüfung. Sie trifft KEINE Entscheidung —
// sie liest die vier Kopfzeilen, fragt `decideRequestOrigin` und antwortet
// `403` oder ruft `next()`. Die ganze Bedingungsliste steht daneben in
// `request-origin.ts` und ist dort ohne Server prüfbar.
//
// ⚠️ WO SIE HÄNGT, und warum dort: als ERSTE Zeile in `createApiRouter`
// (`router.ts`) und nicht in `index.ts` vor dem Mount. Beides greift vor jeder
// Route unter `/api` — auch vor den drei schreibenden Host-Routen aus Phase
// 4a. Den Ausschlag gibt, wer es nachhält: gezählt am 2026-09-07 mit
// `grep -rln 'createApiRouter(' server/src --include=*.test.ts | wc -l`
// fahren ELF Testdateien echte Anfragen durch `createApiRouter` — neun unter
// `api/`, dazu `app/enrollment-integration.test.ts` und
// `app/index-fallback.test.ts`. (Diese Zahl las „ACHT" und war beim Nachmessen
// in Etappe B5-E3, #5, auf ELF gewachsen; `router.ts` nennt beim `router.use`
// denselben Messweg und dieselbe Fehlerklasse.) Hängt die Schranke INNERHALB,
// prüfen alle elf sie bei jedem Lauf mit; hängt sie draussen, prüft sie dort
// niemand, und der
// Tag, an dem jemand den Mount in `index.ts` umbaut, sieht im Diff aus wie
// ein Umzug und ist eine offene Tür. Der Preis ist ehrlich zu nennen: eine
// künftige zweite Montage desselben Routers bekäme die Schranke mit, ob sie will
// oder nicht — das ist hier der gewünschte Weg herum.
//
// ⚠️ WAS SIE NICHT TUT: den Rumpf der abgelehnten Anfrage protokollieren.
// Bei einer fremd ausgelösten Anfrage stammt er von der fremden Seite, und
// ein Log, das ihn aufnimmt, nimmt auf, was jemand anderes hineinschreibt
// (docs/design/phase-5-write-access.md §1, „Was in kein Log gehört"). Auch
// nicht „nur zum Suchen".

/**
 * Prüft die Herkunft jeder Anfrage, die etwas bewirken kann, und lehnt sie mit
 * `403` ab, BEVOR ein Handler sie sieht. Die Antwort trägt dieselbe Form wie
 * das 404-Sammelbecken am Ende des Routers: ein JSON-Objekt mit `error`.
 */
export function requireTrustedOrigin(request: Request, response: Response, next: NextFunction): void {
  const decision = decideRequestOrigin({
    method: request.method,
    // ⚠️ `request.path` und nicht `request.originalUrl`: innerhalb des unter
    // `/api` gemounteten Routers trägt `path` den Pfad OHNE das Präfix
    // (gemessen am 2026-09-07 gegen Express 5.2.1; der Beleg ist ein eigener
    // Fall in `request-origin-routing.test.ts`). Die Muster in
    // `GET_ROUTES_WITH_EFFECT` sind genauso geschrieben.
    path: request.path,
    headers: {
      secFetchSite: headerValue(request, "sec-fetch-site"),
      origin: headerValue(request, "origin"),
      referer: headerValue(request, "referer"),
      host: headerValue(request, "host")
    }
  });

  if (decision.allowed) {
    next();
    return;
  }

  response.status(403).json({ error: "forbidden-origin" });
}

/**
 * Eine Kopfzeile als einzelner Wert. Node liefert bei mehrfach gesendeten
 * Kopfzeilen ein Array; ein Array, das hier als `undefined` durchginge, fiele
 * auf die Zeile „weder noch" und damit ohnehin auf `403` — der ausdrückliche
 * Griff auf den ersten Wert macht das nur sichtbar statt zufällig.
 */
function headerValue(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}
