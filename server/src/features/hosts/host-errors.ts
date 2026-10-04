import type { Response } from "express";

import { HostError } from "../../domain/hosts/index.js";
import { ConfigError } from "../../platform/config/config.js";
import { failWith } from "../../platform/http/route-responses.js";
import { EnrollmentError } from "./enrollment.js";

// What leaves an error of the host inventory as an HTTP answer, and the file
// name of the archive, which can fail or succeed in the same breath
// (`GET /hosts/:hostId/archive` sets both). Moved here from
// `api/domain-errors.ts` with #266; the German comments below are unchanged
// from there.

// Was aus einem Fehler des Bestands nach draußen geht: ein Code für die
// Oberfläche und der Text der Meldung für den Menschen davor.
//
// ⚠️ Der Text stammt ausschließlich aus HostError, EnrollmentError und
// ConfigError — alle drei sind Nachrichten an den Betreiber. Ein beliebiger
// Fehler wird NICHT weitergereicht: seine Meldung nennt Pfade, Spalten und
// Verbindungszeichenketten.
export function handleHostError(error: unknown, response: Response): boolean {
  if (error instanceof HostError) {
    const status = error.reason === "name-taken" ? 409 : error.reason === "address-pool-exhausted" ? 507 : 400;
    failWith(response, status, error.reason, error.message);
    return true;
  }
  if (error instanceof EnrollmentError) {
    // 409 for the local host and for a stored record today's rules refuse;
    // 400 for a missing usable address, which the caller can supply; 404 else.
    const status =
      error.reason === "host-is-local" || error.reason === "host-record-invalid"
        ? 409
        : error.reason === "endpoint-unreachable"
          ? 400
          : 404;
    failWith(response, status, error.reason, error.message);
    return true;
  }
  // Der Einlösepunkt der Zusage aus §2 des Konzepts: der Endpoint fehlt nicht
  // beim Start, sondern beim Anlegen des ersten Arms — dort trifft die Frage
  // nur den, der einen anbindet. Deshalb der TEXT der Meldung und kein Code:
  // sie sagt, welche Zeile in der .env fehlt.
  if (error instanceof ConfigError) {
    failWith(response, 400, "config-incomplete", error.message);
    return true;
  }
  return false;
}

// Ein Dateiname für die Kopfzeile — und nichts, was dort eine eigene Anweisung
// beginnen könnte.
//
// ⚠️ Der Hostname kommt vom Betreiber. Ein Anführungszeichen darin zerlegte
// den `filename`-Parameter, ein Zeilenumbruch begänne eine eigene Kopfzeile
// (Node wirft dann, und aus dem Archiv würde eine 500). Deshalb ein ASCII-Kern
// aus wenigen Zeichen; der vollständige Name reist zusätzlich als `filename*`
// nach RFC 5987, wo er kodiert ist.
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "host";
  const encoded = encodeURIComponent(`${name}-agent.tar.gz`);
  return `attachment; filename="${ascii}-agent.tar.gz"; filename*=UTF-8''${encoded}`;
}
