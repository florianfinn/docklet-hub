import type { NextFunction, Request, Response } from "express";

// Die Sicherheitsköpfe neben der CSP (#133) — an EINER Stelle statt je Route.
// Dieselbe Bauart wie `content-security-policy-header.ts`: die Zwischenschicht
// trifft keine Entscheidung je Anfrage, sie hängt feste Köpfe an.
//
// ── ⚠️ WO SIE HÄNGEN ───────────────────────────────────────────────────────
//
// `createSecurityHeaders` app-weit, direkt hinter der CSP in `index.ts` —
// aus demselben Grund wie dort: eine Schicht, die überall liegt, kann beim
// nächsten Auslieferungsweg nicht vergessen werden. `createNoStoreHeader`
// nur unter `/api`, aber VOR `app.all("/api/auth/*splat", …)`, damit auch die
// Antworten des Anmeldewegs sie tragen.
//
// Eine Route, die selbst `Cache-Control` setzt (die Ströme in
// `api/stream-response.ts` mit `no-transform`), überschreibt den Wert dieser
// Schicht; ein `setHeader` später gewinnt. Das ist gewollt: strenger als
// `no-store` wird es dort nicht, nur genauer.

/**
 * Die drei Köpfe mit ihren Werten. Als Tabelle, damit der Test dieselben
 * Namen und Werte prüft, die auch gesetzt werden.
 *
 * ⚠️ `Referrer-Policy: same-origin` und NICHT die Stufe, die den `Referer`
 * ganz unterdrückt. Die Herkunftsprüfung (`api/request-origin.ts`) fällt auf
 * `Referer` zurück, wenn `Origin` fehlt, und über reines HTTP ist das bei
 * einem GET der Regelfall (`web/tests/referrer-kept.test.mjs`). Unter der
 * strengsten Stufe serialisiert ein Browser bei einem POST außerdem `Origin`
 * als `null` (Fetch-Standard, „serializing a request origin"). `same-origin`
 * gibt beides an den Hub selbst weiter und nichts nach draußen.
 *
 * `X-Frame-Options: DENY` doppelt `frame-ancestors 'none'` aus der CSP für
 * Browser, die die CSP-Direktive nicht kennen.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY"
};

export const NO_STORE_VALUE = "no-store";

type Middleware = (request: Request, response: Response, next: NextFunction) => void;

/** Hängt die drei Köpfe an jede Antwort. */
export function createSecurityHeaders(): Middleware {
  const entries = Object.entries(SECURITY_HEADERS);
  return (_request, response, next) => {
    for (const [name, value] of entries) response.setHeader(name, value);
    next();
  };
}

/**
 * `Cache-Control: no-store` für jede Antwort unter `/api`. Die Antworten
 * tragen Benutzerlisten, Sitzungen und Einrichtungsstände; kein Zwischenspeicher
 * und kein Verlauf des Browsers soll sie behalten.
 */
export function createNoStoreHeader(): Middleware {
  return (_request, response, next) => {
    response.setHeader("Cache-Control", NO_STORE_VALUE);
    next();
  };
}
