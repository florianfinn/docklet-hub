// The calls of the feature `files` (#263): the file surface and the choice of
// its share. Until #263 this was `web/src/api/files.ts`; a feature imports
// nothing from `web/src/api/`, so the calls moved along. The guards read them
// here (`web/tests/client-files.mjs`, `featureApiFiles`). The reasons below are
// unchanged.
//
// Der Zugang der Oberfläche zur Datei-Fläche eines Containers (Web-FTP) —
// Paket B5, Etappe E5a (#5).
//
// Warum eine eigene Datei neben `client.ts`: jene Datei ist auf 866 Zeilen
// gewachsen und trägt die Marke aus `web/tests/source-file-size.test.mjs`
// (LIMIT 1000) schon sichtbar. Die Datei-Fläche bringt fünf Routen und vier
// Formen mit, und in E5b kommen Editor, Upload und Ordneroperationen dazu —
// das ist ein Thema mit eigenem Namen und nicht ein Anhang an die Sammeldatei.
//
// Der TRANSPORT ist trotzdem geteilt und nicht abgeschrieben: `request`,
// `requestNoContent` und `putJson` kommen aus `../platform/http/transport`, wo sie seit
// Etappe E5a stehen. Die Begründung samt Messweg steht im Kopf jener Datei.
//
// ⚠️ The shapes come from the contract since #248
// (`contract/src/api/files.ts`), not from `server/src/agent/files.ts`: that
// file imports the connection pool and the agent client as VALUES, and the web
// would pull half the server into its bundle graph. Every response here is
// parsed against its schema.
//
// ⚠️ HIER STEHT KEINE GRENZE DES AGENTEN. `MAX_UPLOAD_BYTES`, `MAX_TEXT_BYTES`
// und `MAX_ENTRIES` sind Werte der Gegenseite und stehen ausschließlich in
// `contract/src/agent/`; `SINGLE_DECLARATION` in
// `web/tests/agent-protocol-values.test.mjs` wird rot, sobald
// einer davon ein zweites Mal deklariert wird — auch im Web. Diese Fläche prüft
// keine Größe selbst, sie zeigt den Fehler des Servers.
//
// ⚠️ SEIT ETAPPE E5b GIBT ES `GET …/share`, und der Absatz, der hier stand
// („es gibt sie nicht, die Auskunft steckt in der `409` auf die Liste"), gilt
// nicht mehr. Sein Einwand war richtig und trifft die neue Route nicht: sie ist
// keine ZWEITE Quelle, sondern dieselbe — sie liest `readShare`, dieselbe
// Funktion, die `requireShare` liest (`server/src/features/files/service.ts`). Ein
// Auseinanderlaufen ist damit ausgeschlossen. Gebaut wurde sie, weil der
// Texteditor, das Hochladen und die Ordneroperationen die Auskunft ebenfalls
// brauchen: dreimal ein Fehlercode als Auskunft ist einmal zu oft, und wer
// einen Fehler als Fehler behandelt, zeigt eine Störung, wo keine ist.
//
// ⚠️ ZWEI DER AUFRUFE HIER GEHEN NICHT ÜBER DIE VIER HELFER, und das ist keine
// Nachlässigkeit: `saveFileText` und `uploadContainerFile` schicken einen ROHEN
// Rumpf mit eigenem `content-type`. Der Grund steht am Server
// (`server/src/features/files/routes.ts`, `PUT …/file-text`) und ist gemessen:
// `express.json({ limit: "64kb" })` hängt in `server/src/index.ts:184` vor dem
// GANZEN `/api`-Router, während eine Textdatei bis `MAX_TEXT_BYTES` (1 MiB)
// groß sein darf. Ein JSON-Rumpf würde zwischen 64 kB und 1 MiB abgewiesen,
// BEVOR die Route ihn sieht — mit dem HTML des Express-Fehlerbehandlers statt
// einer Fehlerkennung. Die Route antwortet auf `application/json` deshalb
// `415`. Wer das hier „vereinheitlicht", baut den Fall wieder ein.
//
// ⚠️ SEIT #136 BENUTZT `uploadContainerFile` DAZU `XMLHttpRequest` STATT
// `fetch`, und auch das ist gemessen und keine Vorliebe: `fetch` meldet den
// Fortschritt des SENDENS nicht — es gibt keinen Rückruf dafür, und der
// Ersatzweg über einen `ReadableStream` als Rumpf verlangt `duplex: "half"`
// und HTTP/2. Ohne Fortschritt gibt es keinen Balken und keine Abbruchtaste,
// die auf etwas zeigt. Die Begründung im Langen steht an der Funktion selbst.
//
// ⚠️ The raw calls are held against the router all the same. The second
// reader of `web/tests/api-mirror.test.mjs` (`rawCalls`) finds a call —
// `fetch(…)` as well as `xhr.open(…)` — when it can put its path together,
// from a literal in the call or from a `const` in the same function, and cuts
// at the `?`. A path that comes in as a PARAMETER is a transport and is
// skipped.

import {
  fileSourcesResponseSchema,
  type FileSource,
  containerShareLookupSchema,
  containerShareResponseSchema,
  fileActionResponseSchema,
  fileListingResponseSchema,
  fileTextResponseSchema,
  fileTextSavedSchema,
  fileUploadResponseSchema,
  shareCandidatesSchema,
  type ContainerShare,
  type FileActionDone,
  type FileCommand,
  type FileCommandAction,
  type FileListing,
  type FileText,
  type FileUploaded,
  type ShareCandidate,
  type ShareDiagnostics,
  type WebftpEntry
} from "contract";

import { ApiError, parseResponse, readErrorDetail, postJson, putJson, request, requestNoContent } from "../../platform/http/transport";

// The shapes of the file surface: since #248 schemas in the contract
// (`contract/src/api/files.ts`), with the meaning of every field next to it —
// `changedAt` in SECONDS, `kind` as a string, `relative` as the value of a
// choice, `hash` as the lock against overwriting. Every function below parses
// its response against them.
//
// `FileCommand` is the hub's request body with the hub's action names; the
// agent's names (`create-folder` for `create-directory`) and the translation
// stay in the server.
export type {
  ContainerShare,
  FileActionDone,
  FileCommand,
  FileCommandAction,
  FileListing,
  FileText,
  FileUploaded,
  ShareCandidate,
  ShareDiagnostics,
  WebftpEntry
};

/**
 * Die Änderungszeit eines Eintrags als `Date`.
 *
 * ⚠️ DAS `* 1000` IST DER GANZE ZWECK DIESER FUNKTION. `changedAt` kommt in
 * SEKUNDEN (siehe `WebftpEntry`), und `new Date(<Sekunden>)` wirft nicht,
 * sondern liefert einen Zeitpunkt kurz nach 1970. Dieser Fehler stand in
 * diesem Paket schon einmal in drei Dateien, ohne dass eine Prüfkette davon
 * rot wurde. Er steht hier EINMAL, damit keine Fläche ihn ein zweites Mal
 * machen kann; geprüft wird er in `web/tests/files-view.test.tsx`.
 */
export function entryChangedAt(entry: WebftpEntry): Date {
  return new Date(entry.changedAt * 1000);
}

// Every function names its whole path in a `const url` of its own and does not
// get it from a helper: the guard reads a path from a literal or from a
// `const` in the same function, and a path returned by a helper would drop out
// of the check against the router. The repetition is the price of a guard
// that grips.

/**
 * Die Abfrage `?path=…` für die zwei Routen, die einen Pfad in der Freigabe
 * nehmen. Ein LEERER Pfad ergibt eine leere Abfrage — der Server liest ein
 * fehlendes `path` als „die Wurzel der Freigabe" (`queryText` in
 * `server/src/features/files/service.ts` gibt für `undefined` den leeren Text).
 *
 * ⚠️ SIE WIRD AN DEN PFAD GEHÄNGT UND STEHT NICHT IM LITERAL. Ein
 * `…/files?path=${…}` im Literal machte aus dem gelesenen Pfad
 * `/hosts/:param/containers/:param/files?path=:param`, und der findet keine
 * angemeldete Route mehr — `api-mirror` schneidet bei den Helfer-Aufrufen
 * nicht am `?`. So bleibt das Literal der reine Pfad, und die Abfrage kommt
 * dahinter.
 */
function pathQuery(path: string, sourceId?: string): string {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (sourceId) params.set("sourceId", sourceId);
  return params.size ? `?${params}` : "";
}

/**
 * Welche Bind-Mounts dieses Containers als Freigabe taugen.
 *
 * Eine leere Liste ist eine gültige Antwort und kein Fehler: ein Container
 * ohne Bind-Mount unterhalb seines Projektverzeichnisses hat keine Kandidaten,
 * und die Fläche erklärt das, statt eine leere Tabelle zu zeigen.
 */
export async function fetchShareCandidates(
  hostId: string,
  containerId: string
): Promise<{ candidates: ShareCandidate[] }> {
  const url = `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/share-candidates`;
  return parseResponse(url, shareCandidatesSchema, await request(url));
}

/**
 * Die Wahl des Betreibers speichern.
 *
 * ⚠️ `path` ist der `relative` EINES KANDIDATEN und nichts Selbstgebautes. Der
 * Server prüft ihn zeichengenau gegen seine eigene Kandidatenliste und
 * antwortet sonst mit `409 share-unknown`.
 *
 * ⚠️ `PUT` und nicht `POST`: zweimal dieselbe Wahl absenden ergibt denselben
 * Zustand.
 */
export async function setContainerShare(
  hostId: string,
  containerId: string,
  path: string
): Promise<{ share: ContainerShare }> {
  const url = `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/share`;
  return parseResponse(url, containerShareResponseSchema, await putJson(url, { path }));
}

/**
 * Die Wahl zurücknehmen. `204` ohne Rumpf — deshalb `requestNoContent`.
 *
 * Idempotent: kein Fehler, wenn keine Freigabe bestand.
 */
export function removeContainerShare(hostId: string, containerId: string): Promise<void> {
  return requestNoContent(
    `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/share`,
    { method: "DELETE" }
  );
}

/**
 * Ein Verzeichnis der Freigabe auflisten. `path` leer heißt ihre Wurzel.
 *
 * ⚠️ OHNE GEWÄHLTE FREIGABE ANTWORTET DIESE ROUTE `409` mit
 * `error: "share-unset"`. Das ist der Normalfall vor der ersten Wahl und kein
 * Fehler — die Fläche zeigt daraufhin die Kandidaten.
 *
 * ⚠️ `maxUploadBytes` GEHÖRT ZUM UMSCHLAG UND NICHT ZUR LISTE. Die Liste ist die
 * Form des Agenten (`FileListing`, beschrieben in `contract/src/api/files.ts`);
 * die Grenze ist eine Auskunft des Hubs daneben. Sie kommt als ZAHL herein und
 * steht deshalb nirgends im Web als Konstante — `MAX_UPLOAD_BYTES` bleibt in
 * `contract/src/agent/` (`web/tests/agent-protocol-values.test.mjs`), und die Fläche hält die
 * gewählte Datei damit ab, bevor sie hinausgeht (#136).
 */
export async function fetchFileListing(
  hostId: string,
  containerId: string,
  path: string,
  sourceId?: string
): Promise<{ listing: FileListing; maxUploadBytes: number }> {
  const url =
    `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/files` + pathQuery(path, sourceId);
  return parseResponse(url, fileListingResponseSchema, await request(url));
}

/**
 * Die Adresse, unter der eine Datei heruntergeladen wird.
 *
 * ⚠️ KEIN HELFER UND KEIN `fetch` + Blob, sondern nur die Adresse — dieselbe
 * Bauart wie `hostArchiveUrl` in `client.ts`. Ein `fetch` in einen Blob
 * verlöre den Dateinamen aus `content-disposition` (den der Server aus dem
 * Namen auf dem fremden Host baut) und in manchen Browsern die Cookie-Sitzung;
 * dazu hielte es die ganze Datei im Speicher des Reiters — und die kann jede
 * Größe haben, weil `MAX_UPLOAD_BYTES` nur für das Hochladen gilt und diese
 * Richtung beim Agenten keine Schranke hat. Diese Adresse ist für
 * ein `<a download>`-Element gedacht: der Browser holt die Datei selbst,
 * `same-origin`, und schickt die Sitzung wie bei jeder anderen Navigation mit.
 *
 * ⚠️ `path` ZEIGT AUF EINE DATEI, nicht auf ein Verzeichnis — ein leerer Pfad
 * ergibt beim Server eine `400`. Deshalb steht hier `pathQuery` NICHT: eine
 * leere Abfrage wäre die Bitte, ein Verzeichnis herunterzuladen, und die soll
 * gar nicht erst absendbar aussehen.
 */
export function containerFileUrl(hostId: string, containerId: string, path: string, sourceId?: string): string {
  return (
    `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/file` +
    `?path=${encodeURIComponent(path)}${sourceId ? `&sourceId=${encodeURIComponent(sourceId)}` : ""}`
  );
}

/**
 * Welche Freigabe für diesen Container gewählt ist — oder keine.
 *
 * ⚠️ `share: null` IST DIE ANTWORT „NIEMAND HAT GEWÄHLT" UND KEIN FEHLER. Sie
 * kommt mit `200`. Wer sie als Fehler behandelt, zeigt eine Störung, wo der
 * Betreiber nur eine Entscheidung treffen soll.
 *
 * ⚠️ SIE BRAUCHT EINEN ERREICHBAREN ARM, obwohl die Auskunft in der Datenbank
 * des Hubs steht: die Ablage liegt je CONTAINERNAME, der Pfad trägt eine
 * Container-ID, und die Zuordnung entsteht nur aus dem Bestand des Arms
 * (`server/src/features/files/service.ts`). Bei nicht erreichbarem Arm ist die Antwort
 * `503` und nicht „keine Freigabe" — die beiden Fälle dürfen nicht
 * zusammenfallen.
 */
export async function fetchContainerShare(
  hostId: string,
  containerId: string
): Promise<{ share: ContainerShare | null }> {
  const url = `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/share`;
  return parseResponse(url, containerShareLookupSchema, await request(url));
}

/**
 * Eine Textdatei zum Bearbeiten holen.
 *
 * ⚠️ `pathQuery` STEHT HIER NICHT, aus demselben Grund wie bei
 * `containerFileUrl`: `path` zeigt auf eine DATEI. Ein leerer Pfad wäre die
 * Bitte, ein Verzeichnis als Text zu lesen, und der Agent antwortete
 * `path-traversal`.
 */
export async function fetchFileText(
  hostId: string,
  containerId: string,
  path: string,
  sourceId?: string
): Promise<{ text: FileText }> {
  const url =
    `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/file-text` +
    `?path=${encodeURIComponent(path)}${sourceId ? `&sourceId=${encodeURIComponent(sourceId)}` : ""}`;
  return parseResponse(url, fileTextResponseSchema, await request(url));
}

/**
 * Anlegen, umbenennen, entfernen.
 *
 * `POST` und nicht `PUT`: die Route trägt eine ANWEISUNG und keinen Inhalt, und
 * zweimal „anlegen" ergibt beim zweiten Mal einen Fehler und nicht denselben
 * Zustand.
 */
export async function applyFileCommand(
  hostId: string,
  containerId: string,
  command: FileCommand,
  sourceId?: string
): Promise<{ done: FileActionDone }> {
  const url = `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/files`;
  return parseResponse(url, fileActionResponseSchema, await postJson(url, sourceId ? { ...command, sourceId } : command));
}

// ── Die zwei Aufrufe mit rohem Rumpf ────────────────────────────────────────
//
// ⚠️ WARUM SIE NICHT ÜBER DIE VIER HELFER GEHEN, steht ausführlich im Kopf
// dieser Datei: der Rumpf ist der Text bzw. sind die Bytes selbst, und ein
// JSON-Rumpf würde von `express.json({ limit: "64kb" })` vor dem Router
// gelesen und über 64 kB abgewiesen, bevor die Route ihn sieht.
//
// ⚠️ WARUM DER `fetch`-AUFRUF ZWEIMAL DASTEHT und nicht in einen Helfer
// gewandert ist: `rawFetchCalls` in `web/tests/api-mirror.test.mjs` überspringt
// einen `fetch`, dessen erstes Argument ein PARAMETER der Funktion ist — ein
// Helfer `rawRequest(path, init)` wäre damit unsichtbar, und beide Aufrufe
// fielen aus der Prüfung gegen den Router. Gemeinsam ist deshalb nur die
// Auswertung der ANTWORT (`readRaw`), die keinen Pfad kennt.

/**
 * Die Antwort eines rohen Aufrufs — Fehler als `ApiError`, sonst der Rumpf.
 *
 * Dieselbe Auswertung wie in `request` (`../platform/http/transport`), damit ein Fehler dieser
 * beiden Aufrufe bei den Aufrufern genauso ankommt wie jeder andere: als
 * `ApiError` mit Status und dem Rumpf als Text. `file-errors.ts` liest den
 * Fehlercode und beim Konflikt den beigelegten Hash daraus.
 */
async function readRaw(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new ApiError(response.status, await readErrorDetail(response));
  }
  return response.json();
}

/**
 * Eine Textdatei speichern — mit dem Hash, unter dem sie geladen wurde.
 *
 * ⚠️ `expectedHash` IST DER HASH AUS DEM LADEN und kein Platzhalter. Er ist die
 * einzige Sperre gegen das stille Überschreiben fremder Änderungen; der Server
 * lehnt einen fehlenden mit `400 invalid-input` ab, einen veralteten mit
 * `409 file-changed` — und dieser `409` LEGT DEN JETZIGEN HASH BEI. Er ist eine
 * Auskunft und kein Ausfall: er sagt, was jetzt in der Datei steht.
 *
 * ⚠️ DER TEXT REIST ALS ROHER RUMPF mit `text/plain; charset=utf-8`. Schickt
 * jemand `application/json`, antwortet die Route `415` — sie kann den Rumpf
 * dann nicht mehr lesen, weil `express.json` ihn verbraucht hätte, und würde
 * sonst eine LEERE Datei über die des Betreibers schreiben.
 *
 * ⚠️ DIESE FLÄCHE PRÜFT DIE GRÖSSE NICHT SELBST. `MAX_TEXT_BYTES` ist ein Wert
 * der Gegenseite und steht ausschließlich in
 * `contract/src/agent/`; hier wird der Fehler des Servers
 * gezeigt (`413 too-large`).
 */
export async function saveFileText(
  hostId: string,
  containerId: string,
  path: string,
  content: string,
  expectedHash: string,
  sourceId?: string
): Promise<{ hash: string }> {
  const url =
    `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/file-text` +
    `?path=${encodeURIComponent(path)}&expectedHash=${encodeURIComponent(expectedHash)}${sourceId ? `&sourceId=${encodeURIComponent(sourceId)}` : ""}`;
  const response = await fetch(url, {
      credentials: "include",
      method: "PUT",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: content
    });
  return parseResponse(url, fileTextSavedSchema, await readRaw(response));
}

/**
 * Wie weit ein laufender Upload ist — in Bytes, nicht in Prozent.
 *
 * ⚠️ DIE PROZENTZAHL ENTSTEHT ERST BEI DER ANZEIGE. Wer hier schon teilt,
 * verliert die beiden Zahlen, aus denen der Satz „12 von 40 MB" wird — und
 * `total` ist die Zahl, an der die Anzeige merkt, dass der Browser die Länge
 * gar nicht kennt.
 */
export type UploadProgress = { sent: number; total: number };

/** Der Abbruch durch den Betreiber — kein Fehler, sondern seine Entscheidung. */
export class UploadAborted extends Error {
  constructor() {
    super("Der Upload wurde abgebrochen.");
    this.name = "UploadAborted";
  }
}

/**
 * Eine Datei in das gezeigte Verzeichnis hochladen.
 *
 * ⚠️ `path` IST DAS ZIELVERZEICHNIS und `name` der Dateiname — GETRENNT, weil
 * der Server sie durch zwei verschiedene Prüfungen des Agenten schickt
 * (`checkEntryPath` trennt an Schrägstrichen, `checkName` prüft byteweise). Ein
 * zusammengesetzter Pfad liefe an der zweiten vorbei. Ein LEERER `path` ist
 * hier richtig und heißt die Wurzel der Freigabe.
 *
 * ⚠️ DIE BYTES REISEN UNVERÄNDERT. Das `File` geht direkt als Rumpf hinaus —
 * kein `FormData` (der Server erwartet keinen Multipart-Rahmen), keine
 * Base64-Umkodierung (die käme beim Agenten als kaputte Datei an), und der
 * Rumpf ist der Blob selbst, damit der Browser ihn strömen kann statt ihn zu
 * lesen.
 *
 * ⚠️ DIESER EINE AUFRUF LÄUFT ÜBER `XMLHttpRequest` UND NICHT ÜBER `fetch`,
 * und das ist der Grund und keine Vorliebe (#136): `fetch` meldet den
 * FORTSCHRITT DES SENDENS nicht. Es gibt dafür keinen Rückruf, und der
 * Ersatzweg — ein `ReadableStream` als Rumpf mit einem Zähler darin — verlangt
 * `duplex: "half"` und läuft nur über HTTP/2. `xhr.upload.onprogress` ist der
 * Weg, den jeder Browser trägt. Ein Abbruch (`xhr.abort()`) kommt damit
 * ebenfalls: `fetch` könnte den zwar über einen `AbortController`, aber ohne
 * Fortschritt zeigt eine Abbruchtaste auf nichts.
 *
 * ⚠️ AUCH ER WIRD GEGEN DEN ROUTER GEHALTEN. Der zweite Leser von
 * `web/tests/api-mirror.test.mjs` kennt seit #136 neben `fetch(` auch
 * `xhr.open(<Methode>, <Pfad>)`; das Pfadliteral steht deshalb UNMITTELBAR im
 * Aufruf, und der Abfrageteil hängt als zweites Literal daran.
 *
 * ⚠️ DIE GRÖSSE PRÜFT DIESE FUNKTION NICHT. `MAX_UPLOAD_BYTES` ist ein Wert der
 * Gegenseite und steht ausschließlich in `contract/src/agent/`;
 * die Fläche bekommt ihn als Zahl aus dem Umschlag von `GET …/files` und hält
 * die Datei davor (`FileUpload.tsx`).
 */
export function uploadContainerFile(
  hostId: string,
  containerId: string,
  path: string,
  file: File,
  options: { sourceId?: string; signal?: AbortSignal; onProgress?: (progress: UploadProgress) => void } = {}
): Promise<{ uploaded: FileUploaded }> {
  return new Promise<{ uploaded: FileUploaded }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url =
      `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/file` +
      `?path=${encodeURIComponent(path)}&name=${encodeURIComponent(file.name)}${options.sourceId ? `&sourceId=${encodeURIComponent(options.sourceId)}` : ""}`;
    xhr.open("PUT", url);
    // Dasselbe wie `credentials: "include"` bei den vier Helfern: ohne das
    // schickt der Browser das Sitzungscookie bei einer Adresse neben der des
    // Dokuments nicht mit, und die Antwort sähe wie eine abgelaufene Anmeldung
    // aus.
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", "application/octet-stream");

    // ⚠️ `lengthComputable` IST DIE FRAGE, OB ES ÜBERHAUPT EINEN BALKEN GIBT.
    // Ohne bekannte Gesamtlänge meldet der Browser nur gesendete Bytes; ein
    // Balken daraus stünde bei einem geratenen Nenner.
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      options.onProgress?.({ sent: event.loaded, total: event.total });
    });

    const abort = () => xhr.abort();
    options.signal?.addEventListener("abort", abort);
    const done = () => options.signal?.removeEventListener("abort", abort);

    xhr.addEventListener("load", () => {
      done();
      if (xhr.status < 200 || xhr.status > 299) {
        reject(new ApiError(xhr.status, errorDetail(xhr)));
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Eine `200` ohne lesbares JSON ist kein Erfolg: der Aufrufer bekäme
        // sonst eine Quittung ohne Namen und meldete einen Upload, dessen
        // Ausgang niemand kennt.
        reject(new ApiError(xhr.status, xhr.responseText));
        return;
      }
      // Readable JSON in the wrong shape is a `ResponseShapeError` (#248), not
      // an `ApiError`: the hub answered successfully, the shape is wrong.
      try {
        resolve(parseResponse(url, fileUploadResponseSchema, body));
      } catch (error) {
        reject(error);
      }
    });
    // Ein Netzfehler nennt keinen Status — die `0` ist genau das und wird von
    // `fileErrorKey` auf den unbestimmten Satz abgebildet.
    xhr.addEventListener("error", () => {
      done();
      reject(new ApiError(0, xhr.statusText));
    });
    xhr.addEventListener("abort", () => {
      done();
      reject(new UploadAborted());
    });

    xhr.send(file);
  });
}

/**
 * Der Rumpf einer Fehlerantwort als Text — dieselbe Form, die `readErrorDetail`
 * (`../platform/http/transport`) für eine `Response` liefert.
 *
 * ⚠️ DER UMWEG ÜBER `JSON.parse` UND ZURÜCK IST ABSICHT und keine Zierde:
 * `file-errors.ts` liest den Fehlercode mit `JSON.parse(error.message)`. Ein
 * Rumpf, der kein JSON ist (das HTML eines Express-Fehlerbehandlers etwa),
 * fällt auf `statusText` zurück — und der Aufrufer bekommt den unbestimmten
 * Satz statt eines zuversichtlich falschen.
 */
function errorDetail(xhr: XMLHttpRequest): string {
  try {
    return JSON.stringify(JSON.parse(xhr.responseText));
  } catch {
    return xhr.statusText;
  }
}

export async function fetchFileSources(hostId: string, containerId: string): Promise<{ sources: FileSource[] }> {
  const url = `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/file-sources`;
  return parseResponse(url, fileSourcesResponseSchema, await request(url));
}
