import express from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import {
  MAX_REGISTRATION_ATTEMPTS,
  MIN_REGISTRATION_TOKEN_LENGTH,
  normalizeTunnelAddress
} from "../../domain/hosts/index.js";

// Die Anmeldung eines Arms — eine eigene, minimale Anwendung mit GENAU EINER
// Route (SECURITY.md, Grundsatz 2; docs/design/phase-4-bootstrap-and-registration.md §5).
//
// Sie läuft ohne Sitzung, denn ein frisch aufgesetzter Host hat keine. Ihr
// Vertrauen stiftet sie aus fünf Quellen gleichzeitig — Quelladresse,
// Einmal-Token, Zustand des Datensatzes, Fehlzähler und einer Gegenprobe am
// Agenten. Die Reihenfolge der Bedingungen ist Teil der Zusage und steht in §1
// des Entwurfs; sie ist so gewählt, dass eine Bedingung, die noch kein
// Geheimnis gesehen hat, auch keines verbrauchen kann.
//
// ⚠️ Drei Bauarten hier sind gegen Fehler gebaut, die grün durch jeden Test
// kommen und erst im Betrieb auffallen:
//
//   1. `trust proxy` bleibt AUS, und die Quelladresse kommt aus
//      `request.socket.remoteAddress` — nie aus `X-Forwarded-For` und nie aus
//      `request.ip`. Mit einer geglaubten Kopfzeile bestimmte der Anrufer
//      seine eigene Herkunft, und die Bedingungen 3 und 4 wären wertlos, ohne
//      dass ein Testlauf etwas anderes zeigt. Vor dieser App steht kein Proxy:
//      sie lauscht im Tunnel, und der Absender IST die Gegenstelle des Sockets.
//   2. Die Gegenprobe (Bedingung 9) läuft VOR dem Verbrauch des Tokens
//      (Bedingung 10). Andersherum kostete ein Tunnel, der eine Sekunde zu
//      spät steht, dem Betreiber das ganze Archiv: das Token wäre verbraucht,
//      der Arm hinge auf halbem Weg, und der Agent bekäme darauf eine Antwort,
//      aus der er nicht schließen kann, dass eine Wiederholung sinnlos ist.
//   3. Kein Token und kein Secret erreicht jemals eine Logzeile — auch nicht
//      im Fehlerfall, auch nicht als Teil eines Rumpfes. Heraus gehen
//      Bedingungsnummer, Status, die Quelladresse und die Kennung des Hosts
//      aus dem Bestand. Der Pfad der Anfrage geht bewusst NICHT ins Log: er
//      gehört dem Aufrufer, und wer sein Token dort hineinschreibt, hätte es
//      sonst dauerhaft im Protokoll stehen.
//
// Die Antwortcodes sind vom Agenten her gelesen (§2): `5xx` heißt für ihn
// „gleich nochmal", jedes `4xx` außer 408/425/429 heißt „nie wieder". Deshalb
// ist die einzige vorübergehende Lage — der Tunnel steht noch nicht ganz —
// eine 503 und keine 4xx.

export type RegistrationHost = {
  id: string;
  agentUrl: string;
  state: "pending" | "registered";
  tunnelAddress: string | null;
  failedAttempts: number;
};

export type RegistrationDeps = {
  findHostByTunnelAddress: (address: string) => Promise<RegistrationHost | null>;
  probeAgent: (baseUrl: string, hostId: string) => Promise<boolean>;
  consumeToken: (claim: {
    hostId: string;
    token: string;
    sourceAddress: string;
    listenPort: number;
  }) => Promise<RegistrationHost | null>;
  recordFailure: (hostId: string) => Promise<void>;
  log?: (message: string) => void;
};

export const REGISTRATION_ROUTE = "/hosts/:hostId/register";

// Die Kopfzeile, auf der das Einmal-Token reist (Agent v0.18.1,
// `bootstrap-registration.ts`). Eine Kopfzeile und nicht `?token=`: die
// Abfragezeichenkette steht im Zugriffslog jedes Proxys auf dem Weg.
const REGISTRATION_HEADER = "x-docker-host-registration";

// Ein knappes Limit ist an einer Tür ohne Anmeldung die billigste Grenze gegen
// einen Aufrufer, der nur Speicher verbrauchen will. Der echte Rumpf des
// Agenten misst gut hundert Zeichen.
const MAX_BODY_SIZE = "64kb";

const MIN_PORT = 1;
const MAX_PORT = 65535;

type Outcome = {
  status: number;
  // Was nach draußen geht: kurz, ohne Auskunft darüber, welche der fünf
  // Quellen nicht getragen hat. Die Nummer der Bedingung steht im Log.
  error: string;
  condition: number;
  // Nur aus dem Bestand des Hubs gespeist (Kennung, Quelladresse, Zahlen) —
  // niemals aus einer Kopfzeile oder dem Rumpf der Anfrage.
  detail?: string;
};

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}

// Ein Fehler des Rumpf-Lesers (`express.json`): zu groß, kein JSON, unbekannte
// Kodierung. Er trägt `type` und einen Status unter 500.
//
// ⚠️ Von ihm wird NUR `type` weiterverwendet. Seine Meldung zitiert bei
// kaputtem JSON den Rumpf, und ein Aufrufer, der sein Token dort hineinlegt,
// hätte es damit im Log — genau die Zeile, die niemand mehr aus den
// Protokollen bekommt.
function bodyReaderIssue(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { type?: unknown; status?: unknown; statusCode?: unknown };
  const status =
    typeof candidate.status === "number"
      ? candidate.status
      : typeof candidate.statusCode === "number"
        ? candidate.statusCode
        : null;
  if (status === null || status >= 500) return null;
  return typeof candidate.type === "string" ? candidate.type : null;
}

export function createRegistrationApp(deps: RegistrationDeps): express.Express {
  const app = express();

  // ⚠️ Ausdrücklich aus, obwohl es die Vorgabe ist. Wer hier später „nur
  // schnell" einen Proxy davorstellt, sieht an dieser Zeile, dass die
  // Quelladresse dieser App eine Eigenschaft des Sockets ist und keine
  // Kopfzeile.
  app.set("trust proxy", false);
  app.set("etag", false);
  app.disable("x-powered-by");

  const readBody = express.json({ limit: MAX_BODY_SIZE, type: "application/json" });

  const deny = (response: Response, outcome: Outcome): void => {
    deps.log?.(
      `[registration] abgelehnt: Bedingung ${outcome.condition}, HTTP ${outcome.status}` +
        (outcome.detail ? ` (${outcome.detail})` : "")
    );
    response.status(outcome.status).json({ error: outcome.error });
  };

  const handle: RequestHandler = (request, response, next) => {
    // Kein `void` ohne Fang: eine abgelehnte Zusage ginge sonst am eigenen
    // Fehlerbehandler vorbei — je nach Express-Fassung als Antwort ohne
    // Logzeile oder als unbehandelte Ablehnung im Prozess.
    handleRegistration(deps, deny, request, response).catch(next);
  };

  // GENAU EINE Route. Wer hier eine zweite einträgt, veröffentlicht sie im
  // Tunnelnetz ohne Anmeldung (SECURITY.md, Grundsatz 2). Alles andere fällt
  // auf den 404 von Express — Bedingung 1, ohne eigenes Zutun.
  //
  // Der Fehlerbehandler hängt als vierstellige Funktion am Ende DIESER Route
  // und nicht als `app.use`: so trägt die Anwendung genau einen angemeldeten
  // Pfad, und Rumpf-Leser, Ablauf und Fehlerfall stehen in einer Zeile
  // beieinander.
  app.post(REGISTRATION_ROUTE, readBody, handle, createErrorHandler(deps));

  return app;
}

async function handleRegistration(
  deps: RegistrationDeps,
  deny: (response: Response, outcome: Outcome) => void,
  request: Request,
  response: Response
): Promise<void> {
  // Bedingung 2 — der Rumpf ist JSON und höchstens 64 KB.
  //
  // Ein Rumpf ohne `content-type: application/json` wird von `express.json`
  // nicht gelesen; `request.body` bleibt dann leer. Das ist eine Ablehnung mit
  // 400 und kein 500: ohne diese Prüfung fiele der Zugriff auf ein Feld eines
  // undefinierten Rumpfes in den Fehlerbehandler.
  const body: unknown = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    deny(response, { status: 400, error: "kein JSON-Rumpf", condition: 2 });
    return;
  }

  // Der Port, den der Agent für sich selbst nennt. Er wird hier geprüft und
  // nicht erst in der Datenbank: aus ihm baut die Gegenprobe ihre Adresse, und
  // ein unbrauchbarer Wert darf keinen Fehlversuch kosten (Bedingung 10 zählt,
  // Bedingung 2 nicht).
  const listenPort = (body as { listenPort?: unknown }).listenPort;
  if (!isPort(listenPort)) {
    deny(response, { status: 400, error: "listenPort fehlt oder ist unbrauchbar", condition: 2 });
    return;
  }

  // Bedingung 3 — die Quelladresse lässt sich als IPv4 lesen.
  //
  // ⚠️ `request.socket.remoteAddress` und nicht `request.ip`: letzteres liest
  // bei eingeschaltetem `trust proxy` eine Kopfzeile. `normalizeTunnelAddress`
  // führt dabei die Form `::ffff:10.254.0.2` zurück, die Node auf einem
  // Listener über beide Adressfamilien liefert.
  const sourceAddress = normalizeTunnelAddress(request.socket.remoteAddress);
  if (!sourceAddress) {
    deny(response, { status: 403, error: "unbekannte Herkunft", condition: 3 });
    return;
  }

  // Bedingung 4 — zu dieser Quelladresse gibt es einen Host.
  //
  // Die Tunneladresse ist vergeben, nicht gewählt: sie zu erreichen heißt, den
  // privaten Schlüssel aus dem Archiv zu haben.
  const host = await deps.findHostByTunnelAddress(sourceAddress);
  if (!host) {
    deny(response, { status: 403, error: "unbekannte Herkunft", condition: 4, detail: sourceAddress });
    return;
  }

  // Bedingung 5 — die Kennung im Pfad ist genau dieser Host.
  //
  // Sonst könnte ein angebundener Arm die Anmeldung eines anderen versuchen.
  // Die Kennung aus dem Pfad geht dabei nicht ins Log: sie gehört dem
  // Aufrufer.
  if (request.params.hostId !== host.id) {
    deny(response, { status: 403, error: "Host passt nicht zur Herkunft", condition: 5, detail: host.id });
    return;
  }

  // Bedingung 6 — die Kopfzeile mit dem Token ist da und lang genug.
  //
  // Dieselbe Marke, die der Agent auf seiner Seite erzwingt (mindestens 32
  // Zeichen). Geprüft wird die Länge, nicht der Inhalt: der Vergleich läuft
  // erst in Bedingung 10 und dort auf dem Abdruck.
  const token = request.get(REGISTRATION_HEADER);
  if (typeof token !== "string" || token.length < MIN_REGISTRATION_TOKEN_LENGTH) {
    deny(response, { status: 401, error: "Anmelde-Token fehlt", condition: 6, detail: host.id });
    return;
  }

  // Bedingung 7 — der Fehlzähler steht unter der Marke.
  //
  // Die Sperre geht nicht von selbst wieder auf; der Weg zurück ist ein neues
  // Archiv. Ein Zeitfenster wäre gegen einen geduldigen Aufrufer keine Sperre.
  if (host.failedAttempts >= MAX_REGISTRATION_ATTEMPTS) {
    deny(response, {
      status: 403,
      error: "Anmeldung gesperrt",
      condition: 7,
      detail: `${host.id}, ${host.failedAttempts} Fehlversuche`
    });
    return;
  }

  // Bedingung 8 — dieser Arm ist bereits angemeldet.
  //
  // Der Agent schreibt seinen Marker erst nach einer 2xx. Geht das Schreiben
  // schief, meldet er sich beim nächsten Start erneut — mit einem Token, das
  // es nicht mehr gibt. Ein 409 wäre für ihn endgültig; er schriebe seinen
  // Marker nie und versuchte es bei jedem Containerstart aufs Neue.
  //
  // Das ist keine Lücke: an dieser Stelle IST die Tunneladresse der Nachweis
  // (Bedingung 4), denn ohne den privaten Schlüssel aus dem Archiv ist sie
  // nicht erreichbar. Verbraucht wird dabei nichts.
  if (host.state === "registered") {
    deps.log?.(`[registration] bereits angemeldet: ${host.id} von ${sourceAddress}`);
    response.status(200).json({ status: "registered", hostId: host.id });
    return;
  }

  // Bedingung 9 — die Gegenprobe am Agenten, VOR dem Verbrauch des Tokens.
  //
  // ⚠️ Die Probe geht gegen die Adresse, unter der die Anfrage angekommen ist,
  // und nicht gegen eine, die der Aufrufer nennt: `listenHost` aus dem Rumpf
  // bleibt bewusst ungenutzt (§2). Der Port ist der gemeldete — genau der, aus
  // dem auch `agent_url` gebaut wird; die gespeicherte `agentUrl` eines
  // Hosts im Zustand `pending` trägt dagegen noch den Vorgabe-Port und ginge
  // ins Leere, sobald ein Agent auf einem anderen lauscht.
  const reachable = await deps.probeAgent(`http://${sourceAddress}:${listenPort}`, host.id);
  if (!reachable) {
    // 503 und nicht 4xx: der Tunnel steht vielleicht nur noch nicht ganz, und
    // 503 ist für den Agenten wiederholbar. Kein Fehlversuch — der Zähler
    // wächst allein an Bedingung 10.
    deny(response, { status: 503, error: "Agent nicht erreichbar", condition: 9, detail: host.id });
    return;
  }

  // Bedingung 10 — eine Anweisung schaltet `pending` auf `registered` und
  // verbraucht den Abdruck. Kein Treffer heißt abgelehnt.
  const registered = await deps.consumeToken({
    hostId: host.id,
    token,
    sourceAddress,
    listenPort
  });
  if (!registered) {
    // Erst hier wächst der Zähler: die Bedingungen davor haben kein Geheimnis
    // gesehen.
    await deps.recordFailure(host.id);
    deny(response, { status: 401, error: "Anmeldung abgelehnt", condition: 10, detail: host.id });
    return;
  }

  // Bedingung 11 — angemeldet. Der Agent liest den Rumpf bei Erfolg nicht; was
  // hier steht, ist für Menschen. Ein Geheimnis steht deshalb erst recht nicht
  // darin.
  deps.log?.(`[registration] angemeldet: ${registered.id} von ${sourceAddress}`);
  response.status(200).json({ status: "registered", hostId: registered.id });
}

// Der eigene Fehlerbehandler: Stacktrace ins Log, nach draußen nur eine kurze
// Meldung (SECURITY.md, Grundsatz 2). Ohne ihn schriebe Express in der
// Entwicklungsfassung den Stacktrace in die Antwort — an einer Tür ohne
// Anmeldung.
function createErrorHandler(deps: RegistrationDeps) {
  return (error: unknown, _request: Request, response: Response, next: NextFunction): void => {
    const issue = bodyReaderIssue(error);
    if (issue) {
      // Ein zu großer oder kaputter Rumpf ist Bedingung 2 und kein Fehler des
      // Hubs. Gemeldet wird die Art des Problems, NIE die Meldung des Lesers:
      // sie zitiert den Rumpf.
      deps.log?.(`[registration] abgelehnt: Bedingung 2, HTTP 400 (${issue})`);
      if (!response.headersSent) response.status(400).json({ error: "kein JSON-Rumpf" });
      return;
    }
    deps.log?.(
      `[registration] Fehler im Anmeldeweg: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    );
    // Nach dem ersten Byte lässt sich der Status nicht mehr ändern; dann
    // übernimmt Express und beendet die Verbindung.
    if (response.headersSent) {
      next(error);
      return;
    }
    response.status(500).json({ error: "interner Fehler" });
  };
}
