import { join } from "node:path";

import type { RequestHandler } from "express";

// Der Rückfall auf `index.html` — damit ein Neuladen unter `/containers`
// die Anwendung bekommt und keinen 404.
//
// D6b führt in der Oberfläche einen echten Router ein (Entscheidung des
// Betreibers vom 2026-09-06). Von da an gibt es Adressen, die der Browser
// kennt und der Server nicht: `express.static` findet unter `/containers`
// keine Datei und antwortet 404. Die Anwendung liegt aber in der einen
// `index.html`, die den Router startet — sie auszuliefern ist die ganze
// Aufgabe.
//
// ⚠️ WAS DIESER RÜCKFALL NICHT TUN DARF, und das ist der Teil, der still
// bricht:
//
//   1. Er darf keine API-Anfrage beantworten. Eine unbekannte Route unter
//      `/api` muss weiterhin einen 404 als JSON liefern. Bekäme sie HTML,
//      liefe jeder Tippfehler in einem Pfad des API-Klienten in einen
//      Parserfehler statt in eine Fehlermeldung — und ein `fetch`, das auf
//      `response.ok` prüft, sähe eine erfolgreiche Antwort.
//   2. Er darf keine fehlende DATEI beantworten. `/assets/index-a1b2.js`
//      gibt es entweder oder nicht; bekäme das fehlende Bündel HTML, zeigte
//      sich der Fehler im Browser als Syntaxfehler in einer JavaScript-Datei
//      statt als 404 — und die Ursache (ein halber Build, ein falscher
//      Basispfad) stünde nirgends. Deshalb: ein Pfad, dessen letztes
//      Segment einen Punkt trägt, bleibt 404.
//   3. Er darf nur auf LESENDE Methoden antworten. Ein `POST` auf einen
//      unbekannten Pfad ist ein Fehler des Aufrufers und keine Seite.

/**
 * Die Präfixe, die dieser Rückfall auslässt.
 *
 * `/api` deckt beides, was auf dieser Anwendung unter der API hängt: den
 * eigenen Router (`/api/...`) und den Anmeldeweg von better-auth
 * (`/api/auth/*splat`) — der ist damit ausdrücklich mitgemeint und braucht
 * keinen eigenen Eintrag. `/health` ist der Healthcheck von Compose; er
 * antwortet JSON, und ein `/health/etwas` soll nicht plötzlich eine Seite
 * sein.
 *
 * ⚠️ NICHT hier steht der Anmeldeweg der ARME. Er ist eine eigene Anwendung
 * auf einem eigenen Port (`createRegistrationApp`, SECURITY.md Grundsatz 2)
 * und läuft nie durch diese Zwischenschicht.
 */
export const NON_PAGE_PREFIXES = ["/api", "/health"] as const;

function underPrefix(path: string, prefix: string): boolean {
  // `/apixyz` ist nicht `/api`: nur der Pfad selbst und alles unter ihm.
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Ob dieser Pfad die Anwendung meint — und nicht eine API-Antwort, eine Datei
 * oder einen Schreibversuch.
 *
 * Rein und ohne Express, damit die Bedingungen einzeln prüfbar sind: sie sind
 * der Gegenstand, nicht die Verdrahtung.
 */
export function servesIndexHtml(method: string, path: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (NON_PAGE_PREFIXES.some((prefix) => underPrefix(path, prefix))) return false;
  // Eine Datei mit Endung gibt es oder gibt es nicht. Gezählt wird nur das
  // LETZTE Segment: `/v1.2/settings` ist eine Seite, `/foo.js` nicht.
  const lastSegment = path.slice(path.lastIndexOf("/") + 1);
  if (lastSegment.includes(".")) return false;
  return true;
}

/**
 * Die Zwischenschicht.
 *
 * ⚠️ Sie gehört HINTER `express.static` und nur in den Zweig, in dem die
 * gebaute Oberfläche wirklich liegt. Ohne `web/dist` gibt es keine
 * `index.html`, und ein Rückfall darauf machte aus einem fehlenden Build eine
 * Antwort mit einem Dateisystemfehler statt eines schlichten 404.
 */
export function createIndexFallback(webRoot: string): RequestHandler {
  const indexFile = join(webRoot, "index.html");
  return (request, response, next) => {
    if (!servesIndexHtml(request.method, request.path)) {
      next();
      return;
    }
    response.sendFile(indexFile, (error: unknown) => {
      // Fehlt die Datei trotz vorhandenem Verzeichnis, ist das ein Baufehler
      // und keine Seite: er geht an den Fehlerbehandler und nicht ins Leere.
      if (error) next(error);
    });
  };
}
