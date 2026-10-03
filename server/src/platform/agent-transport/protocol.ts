// Der schmale Teil des Agenten-Protokolls, den diese Phase braucht.
//
// ⚠️ Das ist NICHT der Protokoll-Client aus dem Quellsystem. Der
// (`docker-agent-client.ts`, 2.064 Zeilen) wird in Phase 5 übernommen und
// dabei aufgeteilt — concept-and-plan.md §4. Hier steht nur, was der Nachweis
// dieser Phase verlangt: eine beglaubigte Anfrage und eine rein lesende Route.
//
// Seit dem Registry-Abgleich (Phase 5a, #5) kommt die schreibende Richtung
// dazu — `agentPut`. Sie ist kein zweiter Weg zum Agenten, sondern dieselbe
// Anfrage mit Rumpf: siehe `agentRequest`.
//
// Seit dem Log-Strom (Etappe B4b-F, #5) kommt `agentStream` dazu, und DAS ist
// tatsächlich ein zweiter Weg — notgedrungen: `agentRequest` liest den Rumpf
// mit `response.json()` am Stück und legt eine feste Frist über den ganzen
// Aufruf. Beides ist für einen Strom falsch. Was beide Wege trotzdem teilen,
// steht an einer Stelle: die drei Kopfzeilen aus `contract/src/agent/`, die
// Übersetzung der Fehlerstatus in `assertAgentAccepted`.
//
// Seit der Datei-Fläche (Etappe B5/E1, #5) kommen drei Wege dazu, und sie sind
// NICHT drei zweite Wege:
//
//   agentPost      `agentPut` mit anderer Methode — dieselbe Funktion, weil
//                  `POST /containers/:id/files` sich nur in Methode und Rumpf
//                  von einem `PUT` unterscheidet.
//   agentUpload    ebenfalls durch `agentRequest`, aber mit ROHEN BYTES statt
//                  `JSON.stringify`. Der Agent nimmt den nackten Rumpf.
//   agentDownload  der einzige echte dritte Weg, und aus demselben Grund wie
//                  `agentStream`: die Antwort ist `application/octet-stream`
//                  von UNBEKANNTER Größe, und `agentRequest` läse sie mit
//                  `response.json()` am Stück in den Speicher.
//
// Was alle teilen, steht weiter an einer Stelle: die drei Kopfzeilen aus
// `contract/src/agent/` und die Übersetzung der Fehlerstatus in
// `assertAgentAccepted`. Ein Weg an der Übersetzung vorbei wäre eine zweite
// Wahrheit — ein `403` hieße dann je nach Route etwas anderes.
//
// Der Nachweis ist der Zweck. Ohne ihn funktioniert nichts Weiteres: jede
// spätere Phase setzt darauf auf, dass Hub und Agent sich einig sind — über
// die Kopfzeilen, über die Route und über die Form der Antwort.

// Die drei Kopfzeilen und die Netzstufe stehen seit #272 in
// `contract/src/agent/` und werden von dort IMPORTIERT — zusammen mit allem
// anderen, was am Agenten abgelesen und nicht vom Hub erfunden ist. Ein
// Re-Export von hier wäre ein zweiter Name für dieselbe Sache und verfehlte
// den Zweck der Vertragsdatei; wer sie braucht, holt sie dort.
//
// Was gleich bleibt: es sind Konstanten und keine Zeichenketten an der
// Aufrufstelle. Ein Tippfehler in einem Kopfzeilennamen ergibt keine
// Fehlermeldung, sondern eine Anfrage, die als unbeglaubigt gilt.
import { ACTOR_HEADER, HUB_TIER, SECRET_HEADER, TIER_HEADER } from "contract";
import { streamFetch } from "./stream-fetch.js";

// Warum dieser Hub dauerhaft `internal` meldet. Die Begründung bleibt HIER und
// wandert nicht in den Vertrag: sie ist eine Entscheidung dieses Hubs und
// keine Messung am Agenten.
//
// Sie ist eine Konstante, und zwar nicht aus Bequemlichkeit: der Agent
// beantwortet mit `tier` die Frage „auf welchem Weg kam DER MENSCH herein"
// (`src/route-policy.ts`, Kommentar zu #536). Dieser Hub steht ausschließlich
// im eigenen Netz — LAN oder VPN, nie öffentlich (SECURITY.md, Grundsatz 4).
// Es gibt damit nur einen Weg, und eine Skala mit einem Wert ist eine
// Konstante.
//
// ⚠️ Damit ist die Tier-Prüfung des Agenten für diesen Hub dauerhaft
// erfüllt — das gehört ehrlich benannt. Was an ihre Stelle tritt, sind die
// Schranken, die ohnehin die tragenden sind: die Anmeldung des Hubs, das
// gemeinsame Geheimnis, die Allowlist des Agenten und seine Härtungsprüfung,
// die von der Netzstufe unabhängig arbeitet. Und für einen Arm außerhalb des
// eigenen Netzes die Tunnelverbindung selbst (SECURITY.md, Grundsatz 1):
// Sicherheit sitzt dort an der Verbindung, nicht an den Rechten des Agenten.
//
// Die frühere Fassung meldete `external`, um die Delegationssperren des
// Agenten scharf zu halten. Das war eine Fehllesung der Skala: sie sagt nichts
// über das Vertrauen in den Aufrufer, sondern über die Herkunft des Menschen —
// und mit `external` bleiben `PUT /registry`, `GET /host-containers`,
// `GET /host-info` sowie die Compose-, Env- und Exec-Routen zu, auf denen die
// Phasen 5 bis 7 stehen.
//
// Der Wert steht an genau EINER Stelle — seit #272 in `contract/src/agent/`,
// als `HUB_TIER`: eine spätere Änderung ist dort eine Zeile und keine Suche durch
// den Bestand.

// Wer die Anfrage ausgelöst hat. Der Agent schreibt den Wert in sein
// Audit-Log; er ist dort die einzige Spur, die von diesem Hub zurück auf einen
// Menschen zeigt.
export type Actor = { kind: "user"; id: string } | { kind: "system"; name: string };

export function actorHeaderValue(actor: Actor): string {
  return actor.kind === "user" ? `user:${actor.id}` : `system:${actor.name}`;
}

export class AgentError extends Error {
  readonly status: number | null;

  /**
   * Der ausgewertete Fehlerrumpf des Agenten — `null`, wo es keinen gibt.
   *
   * ⚠️ ER IST NICHT SCHMUCK, sondern für eine Antwort der Datei-Fläche
   * notwendig: `PUT /containers/:id/file-text` lehnt mit `409` ab und legt
   * `{ error: "file-changed-externally", hash }` bei — und dieser Hash ist die
   * einzige Auskunft darüber, WAS jetzt in der Datei steht. Ohne ihn kann der
   * Editor dem Betreiber nur „ging nicht" sagen und ihn seine Änderung neu
   * tippen lassen.
   *
   * ⚠️ Gefüllt wird er NUR in `agentRequest`. Dort gehört der Rumpf niemandem
   * sonst: die Antwort ist JSON und wird ohnehin gelesen. Bei `agentStream` und
   * `agentDownload` gehört er dem Aufrufer, und ein hier verbrauchter Rumpf
   * wäre dort für immer weg — deshalb bleibt er dort `null`.
   */
  readonly detail: unknown;

  constructor(message: string, status: number | null = null, options?: { cause?: unknown; detail?: unknown }) {
    super(message, options);
    this.name = "AgentError";
    this.status = status;
    this.detail = options?.detail ?? null;
  }
}

export type AgentTarget = {
  baseUrl: string;
  secret: string;
};

export type RequestOptions = {
  actor: Actor;
  // Einspeisbar, damit der Weg ohne laufenden Agenten prüfbar ist — AGENTS.md
  // verlangt Tests ohne echte Dienste.
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

// Die Frist der beiden binären Wege — Übertragung, nicht Antwortzeit.
//
// ⚠️ SIE IST EINE ANDERE GRÖSSE als `DEFAULT_TIMEOUT_MS` und keine großzügigere
// Fassung davon. Zehn Sekunden sind die Antwortzeit einer Auskunft; ein Upload
// darf beim Agenten bis zu `MAX_UPLOAD_BYTES` tragen (64 MiB, gemessen), und
// über eine Tunnelverbindung ist das eine Übertragung von Minuten. Mit der
// alten Frist bräche jeder größere Upload nach zehn Sekunden ab — und zwar als
// „der Agent antwortete nicht", also mit einer Meldung, die auf die falsche
// Ursache zeigt.
//
// Sie ist eine Entscheidung DIESES HUBS und kein Wert der Gegenseite; deshalb
// steht sie hier und nicht in `contract/src/agent/`.
const BINARY_TIMEOUT_MS = 120_000;

// Die Form einer Anfrage: rein lesend, mit JSON-Rumpf oder mit rohen Bytes.
//
// ⚠️ Sie steht hier als Aufzählung und nicht als freier Methodenname, weil an
// ihr genau zwei Dinge hängen — die Kopfzeile `content-type` und der Rumpf.
// Ein freier Name lüde dazu ein, eine dritte Methode zu ergänzen, ohne zu
// entscheiden, was sie mit beidem tut.
//
// ⚠️ `POST` kam mit der Datei-Fläche (B5) dazu und trägt DASSELBE wie `PUT`:
// einen JSON-Rumpf. Es steht trotzdem als eigener Zweig da und nicht als
// „irgendein Name mit Rumpf" — der Unterschied zwischen den beiden ist eine
// Aussage über die Gegenseite (`POST /containers/:id/files` legt an, benennt
// um und löscht; `PUT` ersetzt), und die gehört nicht hinter einen Sammelnamen.
//
// ⚠️ Der dritte Zweig ist der EINZIGE, der keinen `JSON.stringify` sieht. Ein
// Upload durch `JSON.stringify` zu schicken hieße base64 und ein Drittel mehr
// Speicher an genau der Stelle, an der er beim Agenten knapp ist — er nimmt
// den nackten Rumpf entgegen (`src/index.ts:1436` ff.).
type RequestShape =
  | { method: "GET" | "DELETE" }
  | { method: "POST" | "PUT"; payload: unknown }
  | { method: "PUT"; body: Uint8Array };

/**
 * Die Übersetzung der Fehlerstatus des Agenten — für JEDEN Weg zu ihm.
 *
 * ⚠️ Sie stand bis zur Etappe B4b-F (#5) INNERHALB von `agentRequest`. Mit
 * `agentStream` kam ein zweiter Weg dazu, und damit stünde sie zweimal da.
 * Das ist der Grund für diesen Helfer und nicht Sparsamkeit: zwei Abschriften
 * derselben Meldung sind zwei Wahrheiten — wer die eine schärft, schärft die
 * andere nicht, und ein `403` hieße dann je nach Route etwas anderes. Die
 * Auskunft „Hub und Agent tragen verschiedene Geheimnisse" ist aber dieselbe,
 * ob sie beim Holen einer Liste oder beim Öffnen eines Log-Stroms entsteht.
 *
 * Das Argument ist absichtlich nur der schmale Teil der Antwort, den diese
 * Funktion liest: sie fasst den Rumpf nicht an. Bei einem Strom gehört er dem
 * Aufrufer, und ein hier verbrauchter Rumpf wäre dort für immer weg.
 */
function assertAgentAccepted(response: { status: number; ok: boolean }, path: string): void {
  if (response.status === 401) {
    throw new AgentError(
      "Der Agent hat das Geheimnis abgelehnt (401). Hub und Agent teilen sich DOCKER_AGENT_SECRET — " +
        "in der .env steht es einmal und wird an beide Dienste gereicht.",
      401
    );
  }
  if (response.status === 403) {
    // ⚠️ Mit `internal` ist die Netzstufe kein Grund mehr für eine
    // Ablehnung. Was übrig bleibt, sind die Schranken darunter: eine Route,
    // die an genau einen Aufrufer gebunden ist, ein Container außerhalb der
    // Allowlist, eine Delegationssperre der Härtung. Die Meldung nennt
    // deshalb keine Ursache, die sie nicht kennt — sie nennt die Stelle, an
    // der sie steht.
    throw new AgentError(
      `Der Agent hat „${path}" abgelehnt (403). Sein Audit-Log auf dem Zielhost nennt den Grund; ` +
        "in Frage kommen die Allowlist, eine Delegationssperre der Härtung oder eine Route, die an einen anderen Aufrufer gebunden ist.",
      403
    );
  }
  if (!response.ok) {
    throw new AgentError(`Der Agent antwortete auf „${path}" mit HTTP ${response.status}.`, response.status);
  }
}

/**
 * Der eine Weg zum Agenten — lesend wie schreibend.
 *
 * Die Fehlerfälle sind hier das Produkt: `401` heißt, dass Hub und Agent
 * verschiedene Geheimnisse tragen, `403` heißt, dass die Route den externen
 * Weg nicht zulässt, und beides sieht ohne diese Übersetzung gleich aus.
 *
 * ⚠️ Beide Richtungen teilen sich diese Funktion und laufen nicht
 * nebeneinander her. Die drei Kopfzeilen, die Frist und die Übersetzung der
 * Fehler sind für beide dieselben — eine zweite Fassung davon wäre die Stelle,
 * an der eine später ergänzte Kopfzeile in genau einem der Wege fehlt. Das
 * fiele nicht auf: die Anfrage gälte dann als unbeglaubigt, und der Agent
 * antwortete mit einem `401`, das wie ein falsches Geheimnis aussieht.
 */
async function agentRequest(
  target: AgentTarget,
  path: string,
  options: RequestOptions,
  shape: RequestShape
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;

  // Der Rumpf und seine Kopfzeile werden EINMAL entschieden und nicht zweimal
  // an zwei Stellen des Aufrufs. Die frühere Fassung fragte `shape.method`
  // zweimal ab — einmal für `content-type`, einmal für `body`. Mit drei Formen
  // wäre das die Stelle, an der eine Form ihre Kopfzeile bekommt und ihren
  // Rumpf nicht.
  const sent =
    "body" in shape
      ? { contentType: "application/octet-stream", body: shape.body as BodyInit }
      : "payload" in shape
        ? { contentType: "application/json", body: JSON.stringify(shape.payload) }
        : null;

  // Ein binärer Rumpf braucht die Frist der Übertragung, kein binärer die der
  // Antwort — siehe `BINARY_TIMEOUT_MS`.
  const timeoutMs =
    options.timeoutMs ?? (sent?.contentType === "application/octet-stream" ? BINARY_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

  // Ohne Frist bleibt ein Aufruf gegen einen Agenten, der die Verbindung
  // annimmt und dann schweigt, bis zum Prozessende offen.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${target.baseUrl}${path}`, {
      method: shape.method,
      signal: controller.signal,
      headers: {
        [SECRET_HEADER]: target.secret,
        [ACTOR_HEADER]: actorHeaderValue(options.actor),
        [TIER_HEADER]: HUB_TIER,
        // Auch beim binären Upload: die ANTWORT ist JSON
        // (`{ ok: true, name, size }`). `accept` beschreibt die Rückrichtung,
        // `content-type` die Hinrichtung — sie sind hier verschieden, und das
        // ist kein Versehen.
        accept: "application/json",
        ...(sent === null ? {} : { "content-type": sent.contentType })
      },
      ...(sent === null ? {} : { body: sent.body })
    });

    try {
      assertAgentAccepted(response, path);
    } catch (error) {
      if (!(error instanceof AgentError)) throw error;
      // ⚠️ NUR HIER wird ein Fehlerrumpf gelesen, und nur, weil er sonst
      // verfiele: die Antwort dieses Weges ist JSON und wird ohnehin gelesen.
      // `assertAgentAccepted` selbst fasst ihn weiterhin NICHT an — bei einem
      // Strom gehört er dem Aufrufer, und dort wäre er danach für immer weg.
      // Deshalb steht die Ergänzung hier und nicht in der Übersetzung.
      //
      // `catch(() => null)`: ein Agent, der mit `502` und einer HTML-Seite des
      // Proxys antwortet, soll denselben Fehler ergeben wie vorher — kein
      // zweiter Fehler beim Lesen des ersten.
      const detail = await response.json().catch(() => null);
      throw new AgentError(error.message, error.status, { detail });
    }

    try {
      return await response.json();
    } catch (error) {
      throw new AgentError(`Die Antwort des Agenten auf „${path}" ist kein JSON.`, response.status, { cause: error });
    }
  } catch (error) {
    if (error instanceof AgentError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new AgentError(`Der Agent antwortete nicht innerhalb von ${timeoutMs} ms auf „${path}".`);
    }
    throw new AgentError(
      `Der Agent war nicht erreichbar: ${error instanceof Error ? error.message : String(error)}`,
      null,
      { cause: error }
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Eine beglaubigte GET-Anfrage an den Agenten. */
export async function agentGet(
  target: AgentTarget,
  path: string,
  options: RequestOptions
): Promise<unknown> {
  return agentRequest(target, path, options, { method: "GET" });
}

/**
 * Eine beglaubigte PUT-Anfrage mit JSON-Rumpf.
 *
 * ⚠️ Der Rückgabewert ist der ausgewertete Rumpf der ANTWORT und nicht nichts.
 * Der Agent quittiert `PUT /registry` mit `{ ok: true, entries: <Zahl> }` —
 * und diese Zahl ist die einzige Auskunft darüber, wie viele Einträge er
 * tatsächlich übernommen hat (er lässt abgelehnte still weg und antwortet
 * trotzdem `200`). Ein Aufrufer, der die Antwort wegwirft, wirft den einzigen
 * Beleg weg, dass sein Schreibvorgang etwas bewirkt hat.
 */
export async function agentPut(
  target: AgentTarget,
  path: string,
  payload: unknown,
  options: RequestOptions
): Promise<unknown> {
  return agentRequest(target, path, options, { method: "PUT", payload });
}

/**
 * Eine beglaubigte POST-Anfrage mit JSON-Rumpf.
 *
 * Sie ist `agentPut` mit einer anderen Methode und teilt sich alles Übrige:
 * die drei Kopfzeilen, die Frist, die Übersetzung der Fehlerstatus.
 *
 * ⚠️ SIE IST TROTZDEM NICHT DASSELBE, und der Unterschied liegt bei der
 * Gegenseite. `POST /containers/:id/files` ist die einzige mutierende Route
 * der Datei-Fläche, die nicht ersetzt, sondern eine ANWEISUNG trägt
 * (`{ action, path, name? }`) — anlegen, umbenennen, löschen. Der Agent führt
 * sie als eigene Zeile seiner Routentabelle
 * (`agent/src/route-policy.ts`); `POST` und
 * `PUT` auf denselben Pfad sind dort zwei Einträge und nicht einer.
 *
 * ⚠️ Auch hier ist der Rückgabewert die ausgewertete ANTWORT: der Agent
 * quittiert je nach Aktion mit `{ ok: true, name }` oder `{ ok: true, kind }`,
 * und `kind` ist die einzige Auskunft darüber, WAS gelöscht wurde.
 */
export async function agentPost(
  target: AgentTarget,
  path: string,
  payload: unknown,
  options: RequestOptions
): Promise<unknown> {
  return agentRequest(target, path, options, { method: "POST", payload });
}

/**
 * An authenticated DELETE without a body.
 *
 * The first caller is clearing a compose selection (#185,
 * `DELETE /containers/:id/compose-selection`). As with `agentPut`, the return
 * value is the parsed ANSWER: the agent acknowledges with
 * `{ ok: true, selectedFilePath: null }`.
 */
export async function agentDelete(
  target: AgentTarget,
  path: string,
  options: RequestOptions
): Promise<unknown> {
  return agentRequest(target, path, options, { method: "DELETE" });
}

/**
 * Ein beglaubigter PUT mit ROHEN BYTES statt JSON.
 *
 * `PUT /containers/:id/file` nimmt den nackten Rumpf entgegen. Der Grund steht
 * beim Agenten und ist gemessen: eine hochgeladene Datei ist binär, und sie
 * durch base64 zu schicken kostete ein Drittel mehr Speicher an genau der
 * Stelle, an der Speicher knapp ist — sein Host hat 2 GB und läuft im Swap.
 *
 * ⚠️ KEIN ZWEITER WEG ZUM AGENTEN. Er läuft durch `agentRequest` wie `agentPut`
 * und damit durch dieselben drei Kopfzeilen und dieselbe Fehlerübersetzung. Ein
 * eigener `fetch` an `assertAgentAccepted` vorbei wäre eine zweite Wahrheit:
 * ein `403` hieße dann je nach Route etwas anderes.
 *
 * ⚠️ Der Rumpf wird NICHT vorgeprüft. Über `MAX_UPLOAD_BYTES` antwortet der
 * Agent mit `413` und `file-too-large` — die Entscheidung fällt bei ihm. Wer
 * dem Betreiber früher etwas sagen will, prüft VOR diesem Aufruf und nicht in
 * ihm; eine Schranke hier wäre die zweite Wahrheit über eine fremde Grenze.
 */
export async function agentUpload(
  target: AgentTarget,
  path: string,
  body: Uint8Array,
  options: RequestOptions
): Promise<unknown> {
  return agentRequest(target, path, options, { method: "PUT", body });
}

/**
 * Ein beglaubigter GET, dessen Antwort ROHE BYTES sind.
 *
 * Zurück kommt die `Response` und nicht ihr Inhalt. Das ist der ganze Punkt:
 * `GET /containers/:id/file` antwortet mit `application/octet-stream` und
 * gesetztem `content-length`. Ein `await response.arrayBuffer()` an dieser
 * Stelle hielte die ganze Datei im Speicher des Hubs, nur um sie gleich darauf
 * weiterzugeben — der Rumpf gehört dem Aufrufer und wird durchgereicht, nicht
 * gesammelt.
 *
 * ⚠️ FÜR DIESE RICHTUNG GILT `MAX_UPLOAD_BYTES` NICHT. Die 64 MiB stehen beim
 * Agenten in `readRawBody` und decken damit nur, was HEREINKOMMT; der Download
 * hat keine Schranke — der Agent nimmt `content-length` aus `stat` und
 * schreibt, was da ist. Wer die Zahl hier als Obergrenze läse, rechnete mit
 * einer Größe, an die sich niemand hält.
 *
 * ⚠️ ER IST NICHT `agentStream`, UND DER UNTERSCHIED IST NICHT DER MIME-TYP.
 * Ein Log-Strom endet von selbst nur, wenn der Container verschwindet, und
 * braucht deshalb ein `signal` als Pflicht. Ein Download ist endlich: er hört
 * bei `content-length` auf. `signal` ist hier deshalb möglich und nicht Pflicht
 * — wer es mitgibt, kann abbrechen; wer nicht, bekommt trotzdem ein Ende.
 *
 * ⚠️ ZWEI FRISTEN, DIE NICHT DASSELBE SIND — dieselbe Unterscheidung wie bei
 * `agentStream`. `timeoutMs` gilt für den VERBINDUNGSAUFBAU bis zur ersten
 * Kopfzeile; danach wird der Zeitgeber abgeräumt. Eine Gesamtfrist träfe genau
 * die große Datei über die langsame Leitung, für die es diesen Weg gibt.
 */
export async function agentDownload(
  target: AgentTarget,
  path: string,
  options: RequestOptions & { signal?: AbortSignal }
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const connectTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Derselbe eigene Halter wie in `agentStream` und aus demselben Grund: nur so
  // lässt sich die Frist des Aufbaus wieder wegnehmen, ohne den Abbruchweg des
  // Aufrufers mitzunehmen.
  const controller = new AbortController();
  const caller = options.signal;
  if (caller !== undefined) {
    if (caller.aborted) controller.abort();
    else caller.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let connectTimedOut = false;
  const timer = setTimeout(() => {
    connectTimedOut = true;
    controller.abort();
  }, connectTimeoutMs);

  try {
    const response = await fetchImpl(`${target.baseUrl}${path}`, {
      method: "GET",
      signal: controller.signal,
      headers: {
        [SECRET_HEADER]: target.secret,
        [ACTOR_HEADER]: actorHeaderValue(options.actor),
        [TIER_HEADER]: HUB_TIER,
        // Der einzige Unterschied zu `agentRequest` in den Kopfzeilen.
        accept: "application/octet-stream"
      }
    });

    // ⚠️ HIER und nur hier steht der Status noch zur Verfügung — dieselbe
    // Stelle wie bei `agentStream`. Ein `404` (die Datei fehlt) und ein `403`
    // (die Freigabe deckt sie nicht) sehen im Rumpf gleich aus, sobald der
    // erste Byte draußen ist.
    assertAgentAccepted(response, path);
    return response;
  } catch (error) {
    if (error instanceof AgentError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      if (connectTimedOut) {
        throw new AgentError(`Der Agent antwortete nicht innerhalb von ${connectTimeoutMs} ms auf „${path}".`);
      }
      // Der Aufrufer wollte es so — unverändert weiter nach außen.
      throw error;
    }
    throw new AgentError(
      `Der Agent war nicht erreichbar: ${error instanceof Error ? error.message : String(error)}`,
      null,
      { cause: error }
    );
  } finally {
    // Nur der Zeitgeber. Ein Zuhörer am `signal` des Aufrufers bleibt — er ist
    // ab jetzt die Leitung, über die der Download abgebrochen wird.
    clearTimeout(timer);
  }
}

/**
 * Die Optionen eines Stroms.
 *
 * ⚠️ `signal` ist PFLICHT und nicht optional. Ein Strom ohne Abbruchmöglichkeit
 * endet von selbst nur, wenn der Container verschwindet
 * (`agent/src/engine.ts`: die Engine hängt mit `follow=1` an den laufenden
 * Strom an) — der Aufrufer MUSS ihn beenden
 * können, sonst belegt er einen der Plätze des Agenten, bis der es selbst
 * merkt (`MAX_OPEN_STREAMS`, seit #272 in `contract/src/agent/limits.ts`).
 *
 * `timeoutMs` bedeutet hier etwas anderes als bei `agentRequest` — siehe
 * `agentStream`.
 */
export type StreamOptions = RequestOptions & {
  signal: AbortSignal;
  /**
   * Der Rumpf eines Stroms, der einen hat — gesetzt AUSSCHLIESSLICH von
   * `agentStreamPost`.
   *
   * ⚠️ IT IS NOT WHERE THE METHOD IS DECIDED, and it was for one draft. A
   * method that stands in an object field three lines below the call cannot
   * be seen at the call site; it stands in the NAME of the function instead.
   */
  body?: unknown;
};

/**
 * Eine beglaubigte GET-Anfrage, deren Rumpf ein laufender Strom ist.
 *
 * Zurück kommt die rohe `Response`. Kein `response.json()`: der Rumpf gehört
 * dem Aufrufer, und ein hier ausgelesener Rumpf wäre dort für immer weg.
 * `agentRequest` ist für diesen Fall unbrauchbar — es liest den Rumpf am Stück
 * und legt eine feste Frist über den GANZEN Aufruf.
 *
 * ⚠️ ZWEI FRISTEN, DIE NICHT DASSELBE SIND. `timeoutMs` gilt hier
 * ausschließlich für den VERBINDUNGSAUFBAU, also bis zur ersten Kopfzeile der
 * Antwort; danach wird der Zeitgeber abgeräumt. Der Grund ist die Natur der
 * Sache: ein Container, der eine halbe Stunde nichts protokolliert, ist kein
 * Fehler, sondern ein ruhiger Container. Eine Gesamtfrist träfe genau ihn und
 * risse ihm den Strom weg, ohne dass irgendetwas kaputt wäre. Ein Agent
 * dagegen, der die Verbindung annimmt und dann gar nicht erst antwortet, ist
 * sehr wohl ein Fehler — und den fängt die eine Frist, die bleibt.
 *
 * Die LEBENSDAUER des Stroms hängt deshalb allein am `signal` des Aufrufers.
 * Bei der Log-Route ist das die Verbindung des Browsers
 * (`features/logs/routes.ts`).
 *
 * ⚠️ DIE FRIST DES AUFBAUS BLEIBT AUCH BEIM ANWENDE-STROM DIE ÜBLICHE, und das
 * ist gemessen und keine Nachlässigkeit. Man könnte meinen, sie müsse dort so
 * groß sein wie die Strecke selbst — zehn Minuten. Muss sie nicht: der Agent
 * entscheidet den STATUS, bevor die erste Zeile hinausgeht, und eine belegte
 * Projektsperre wirft dort sofort (`409 stack-busy`) statt zu warten.
 * Was lange dauert, steht im Rumpf, und der hat gar keine Frist — erst seit
 * `streamFetch`: das eingebaute `fetch` riss ihn nach 300 s Stille ab,
 * gemessen am 2026-09-29 (`stream-fetch.ts`). Genau das ist
 * der Gewinn des Stroms gegenüber dem synchronen Weg, für den dieser Hub sich
 * eine eigene 660-Sekunden-Frist ausrechnen musste.
 *
 * ⚠️ Der Abbruch über `options.signal` reist als AbortError des Aufrufers nach
 * außen und NICHT als `AgentError`. Er ist kein Befund: der Browser hat die
 * Seite verlassen. Nur die Frist des Verbindungsaufbaus wird zum `AgentError`,
 * und die Unterscheidung trifft `connectTimedOut` — von außen sehen beide
 * Abbrüche gleich aus.
 */
export async function agentStream(
  target: AgentTarget,
  path: string,
  options: Omit<StreamOptions, "body">
): Promise<Response> {
  return await openStream(target, path, options);
}

/**
 * Dasselbe mit einem Rumpf und als `POST`.
 *
 * Gebraucht vom Anwende-Strom (`compose-raw-stream`, v0.22.0): er trägt den
 * Compose-Entwurf und die vier Bestätigungslisten, und die passen in keine
 * Adresse.
 *
 * ⚠️ EIGENE FUNKTION UND KEIN FLAG. Die Methode gehört an die Aufrufstelle,
 * wo der Leser sie sieht. Die IMPLEMENTIERUNG ist
 * trotzdem geteilt: der Aufbau mit seinen zwei verschiedenen Fristen steht in
 * `openStream` genau einmal.
 */
export async function agentStreamPost(
  target: AgentTarget,
  path: string,
  body: unknown,
  options: Omit<StreamOptions, "body">
): Promise<Response> {
  return await openStream(target, path, { ...options, body });
}

async function openStream(
  target: AgentTarget,
  path: string,
  options: StreamOptions
): Promise<Response> {
  // ⚠️ `streamFetch` UND NICHT DAS EINGEBAUTE `fetch`: dessen Rumpf reißt
  // nach 300 s Stille ab (`stream-fetch.ts`).
  const fetchImpl = options.fetchImpl ?? streamFetch;
  const connectTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Ein eigener Halter statt `options.signal` direkt an `fetch`: nur so lässt
  // sich die Frist des Aufbaus wieder wegnehmen, ohne den Abbruchweg des
  // Aufrufers mitzunehmen. Der Zuhörer unten wird ABSICHTLICH nicht wieder
  // abgemeldet — er ist die Leitung, über die der Aufrufer den laufenden
  // Strom später beendet.
  const controller = new AbortController();
  if (options.signal.aborted) controller.abort();
  else options.signal.addEventListener("abort", () => controller.abort(), { once: true });

  let connectTimedOut = false;
  const timer = setTimeout(() => {
    connectTimedOut = true;
    controller.abort();
  }, connectTimeoutMs);

  try {
    const sending = options.body !== undefined;
    const response = await fetchImpl(`${target.baseUrl}${path}`, {
      method: sending ? "POST" : "GET",
      signal: controller.signal,
      headers: {
        [SECRET_HEADER]: target.secret,
        [ACTOR_HEADER]: actorHeaderValue(options.actor),
        [TIER_HEADER]: HUB_TIER,
        // Der einzige Unterschied zu `agentRequest` in den Kopfzeilen. Der
        // Agent antwortet auf den Log-Strom mit
        // `application/x-ndjson; charset=utf-8`.
        accept: "application/x-ndjson",
        ...(sending ? { "content-type": "application/json" } : {})
      },
      ...(sending ? { body: JSON.stringify(options.body) } : {})
    });

    // ⚠️ HIER und nur hier steht der Status noch zur Verfügung. Sobald die
    // erste Zeile des Rumpfs draußen ist, kann ein Fehler nur noch IM Strom
    // stehen — deshalb wird die Übersetzung vor der Rückgabe erledigt und
    // nicht dem Aufrufer überlassen. Ein `429` (der Deckel `MAX_OPEN_STREAMS`)
    // fällt dabei in den `!ok`-Zweig und behält seinen Status.
    assertAgentAccepted(response, path);
    return response;
  } catch (error) {
    if (error instanceof AgentError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      if (connectTimedOut) {
        throw new AgentError(`Der Agent antwortete nicht innerhalb von ${connectTimeoutMs} ms auf „${path}".`);
      }
      // Der Aufrufer wollte es so. Unverändert weiter nach außen, damit er
      // seinen eigenen Abbruch wiedererkennt und nicht als Serverfehler liest.
      throw error;
    }
    throw new AgentError(
      `Der Agent war nicht erreichbar: ${error instanceof Error ? error.message : String(error)}`,
      null,
      { cause: error }
    );
  } finally {
    // Nur der Zeitgeber. Der Zuhörer am `signal` des Aufrufers bleibt — er
    // wird ab jetzt erst gebraucht.
    clearTimeout(timer);
  }
}

/** The body of a stream response — or a named error instead of `null`. */
export function streamBodyOf(response: Response, path: string): ReadableStream<Uint8Array> {
  const body = response.body;
  if (!body) throw new AgentError(`Der Agent antwortete auf „${path}" ohne Rumpf.`, response.status);
  return body;
}
