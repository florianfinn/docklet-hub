// Der Client für die sieben Routen der Datei-Fläche (Web-FTP).
//
// ── WAS HIER STEHT ──────────────────────────────────────────────────────────
//
// One function per route and nothing else: no cache, no convenience merge of
// several routes, no check the agent makes anyway. The shapes were MEASURED against the agent (v0.24.0,
// `agent/src/webftp.ts`, `agent/src/request-keys.ts`,
// `agent/src/route-policy.ts`), not copied from the draft.
//
// ── DREI FESTLEGUNGEN, DIE HIER UND NICHT ANDERSWO STEHEN ───────────────────
//
// 1. THE FIVE KEYS GO OUT UNDER THEIR NEW NAME ONLY.
//    `share` instead of `freigabe`, `path` instead of its German old form;
//    the request schemas in `contract/src/agent/` carry only the new names,
//    so the type check holds this since #272.
//
// 2. DER AUFRUFER IST IMMER EIN MENSCH.
//    `FileRequestOptions` lässt als `actor` nur `{ kind: "user", id }` zu, und
//    das ist keine Bequemlichkeit, sondern der Grund für den eigenen Typ. Der
//    Agent schreibt den Wert in sein Audit-Log; er ist dort die einzige Spur,
//    die von diesem Hub auf einen Menschen zeigt. Ein `system:hub` an einer
//    dieser Routen löschte genau diese Spur — und zwar unbemerkt, weil der
//    Aufruf gelingt. Hier ist das ein Typfehler und keine Verabredung.
//
// 3. DIE GRENZEN DES AGENTEN WERDEN NICHT NACHGEBAUT.
//    `MAX_UPLOAD_BYTES`, `MAX_TEXT_BYTES` und `MAX_ENTRIES` stehen in der
//    Vertragsdatei und werden von hier EXPORTIERT, damit ein Aufrufer dem
//    Betreiber früh etwas sagen kann. Entschieden wird beim Agenten: er
//    antwortet über der Grenze mit `413`. Eine Schranke in diesem Modul wäre
//    die zweite Wahrheit über eine fremde Grenze — die eine, die still falsch
//    wird, sobald der Agent seine ändert.
//
// ── THE AGENT'S VALUES ──────────────────────────────────────────────────────
//
// `kind` of a directory entry carries `file`, `directory`, `symlink`, `other`;
// the actions are `create-folder`, `rename` and `delete`. English since
// contract 6 (#278), and mirrored word for word: the hub's own action names
// differ (`create-directory`), and sending one of them would end in a `400`.

import {
  WEBFTP_ENTRY_KINDS,
  type FileActionDone,
  type FileListing,
  type FileText,
  type FileUploaded,
  type ShareCandidate,
  type ShareDiagnostics,
  type WebftpEntry
} from "contract";

import { type FileAction, MAX_ENTRIES, MAX_TEXT_BYTES, MAX_UPLOAD_BYTES } from "contract";
import {
  agentDownload,
  AgentError,
  agentGet,
  agentPost,
  agentPut,
  type AgentTarget,
  agentUpload,
  type RequestOptions
} from "../../platform/agent-transport/protocol.js";
import { watchStreamRejection } from "../../platform/agent-transport/stream-rejection.js";

// Die Grenzen der Gegenseite gehen unverändert weiter — ein Aufrufer soll sie
// nicht ein zweites Mal irgendwo herholen müssen und schon gar nicht neu
// hinschreiben.
export { MAX_ENTRIES, MAX_TEXT_BYTES, MAX_UPLOAD_BYTES, WEBFTP_ENTRY_KINDS };
export type { FileAction };

/**
 * Der Aufrufer einer Datei-Route: immer ein angemeldeter Mensch.
 *
 * ⚠️ Der Typ ist die Durchsetzung von Festlegung 2 oben. `Actor` aus
 * `protocol.ts` lässt auch `{ kind: "system", name }` zu — richtig für den
 * Registry-Abgleich, der wirklich niemandem gehört, und falsch für jede Route
 * dieser Fläche.
 */
export type SessionActor = { kind: "user"; id: string };

/** Die Optionen einer Datei-Anfrage — wie `RequestOptions`, aber ohne System. */
export type FileRequestOptions = Omit<RequestOptions, "actor"> & { actor: SessionActor };

/** Ein Verzeichnis der Freigabe, in dem gearbeitet wird. */
export type SharePath = {
  /** Der relative Pfad der Freigabe, wie ihn `share-candidates` nennt. */
  share: string;
  /** Der Pfad INNERHALB der Freigabe; leer heißt ihre Wurzel. */
  path: string;
};

// The shapes the hub passes on from the agent live in the contract
// (`contract/src/api/files.ts`, #248), together with what each field means.
// The one this side must never forget: `WebftpEntry.changedAt` is SECONDS
// since the epoch (`Math.floor(stat.mtimeMs / 1000)`, `agent/src/webftp.ts`).
export type { FileListing, ShareCandidate, ShareDiagnostics, WebftpEntry };

/**
 * Eine laufende Übertragung von `GET /containers/:id/file`.
 *
 * ⚠️ `stream` ist der ROHE Rumpf der Antwort und wird durchgereicht, nicht
 * gesammelt. Wer ihn hier in einen Puffer liest, hält die ganze Datei im
 * Speicher des Hubs, nur um sie gleich darauf weiterzugeben.
 *
 * ⚠️ UND ZWAR OHNE OBERGRENZE. `MAX_UPLOAD_BYTES` (64 MiB) gilt nur für das
 * Hochladen; in dieser Richtung kennt der Agent keine Schranke und nennt in
 * `content-length` schlicht, was `stat` sagt. `size` ist deshalb eine Auskunft
 * und keine Zusicherung.
 */
export type FileDownload = {
  /** Aus `content-length`; `null`, wenn der Agent sie ausnahmsweise nicht nennt. */
  size: number | null;
  stream: ReadableStream<Uint8Array>;
};

// Receipt of an upload and a text file: shapes of the contract (#248).
export type { FileText, FileUploaded };

/**
 * Das Ergebnis eines Speicherversuchs im Texteditor.
 *
 * ⚠️ DER KONFLIKT IST KEIN FEHLER, sondern eine Antwort — deshalb steht er als
 * Zweig hier und nicht als geworfener `AgentError`. Der Agent lehnt mit `409`
 * ab, wenn die Datei sich seit dem Laden geändert hat, und legt den JETZIGEN
 * Hash bei. Ohne diesen Zweig könnte der Editor dem Betreiber nur „ging nicht"
 * sagen und ihn seine Änderung neu tippen lassen.
 */
export type FileTextWrite = { ok: true; hash: string } | { ok: false; reason: string; hash: string };

// The receipt of `POST /containers/:id/files`: a shape of the contract (#248).
export type { FileActionDone };

/**
 * The body of `POST /containers/:id/files` AT THE AGENT, with its own
 * action names. Not the hub's API body (`FileCommand` in the contract): the
 * route translates between the two (`OWN_ACTION_NAMES`, `file-routes.ts`).
 */
export type FileCommand = {
  action: FileAction;
  /** Bei `create-folder` das Zielverzeichnis, sonst der Eintrag selbst. */
  path: string;
  /** Nur bei `create-folder` und `rename`. */
  name?: string;
};

// ---------------------------------------------------------------------------
// Die Abfrageteile — an EINER Stelle
// ---------------------------------------------------------------------------

// ⚠️ JEDER Abfrageteil dieser Fläche entsteht hier und nicht an sieben
// Aufrufstellen. Das ist der Ort, an dem ein Rückfall auf einen Alt-Schlüssel
// entstünde: sieben Stellen, von denen eine übersehen wird, sähen im Diff
// alle richtig aus. Mit einer Stelle ist der Rückfall eine Zeile, und Fall 3
// des Wächters liest genau sie.
function shareQuery(location: SharePath): string {
  const params = new URLSearchParams();
  params.set("share", location.share);
  params.set("path", location.path);
  return params.toString();
}

// Der Container steht im Pfad und nicht in der Abfrage. `encodeURIComponent`
// ist hier keine Förmlichkeit: eine Kennung mit einem Schrägstrich verschöbe
// sonst die Route selbst.
//
// Each route spells out its path and carries its own name for it, so a
// reader sees at the call which route it is.
function encodeId(id: string): string {
  return encodeURIComponent(id);
}

// ---------------------------------------------------------------------------
// Die Antworten lesen
// ---------------------------------------------------------------------------

// ⚠️ KEIN VOLLSTÄNDIGER PARSER, und das ist eine Entscheidung. Geprüft wird
// nur so viel, dass ein Fehlgriff als solcher gemeldet wird statt als
// `undefined`, das drei Schichten weiter oben auffällt. Was der Agent an
// zusätzlichen Feldern schickt, bleibt unangetastet — ein Modul, das die
// Antwort der Gegenseite nachbaut, ist die zweite Wahrheit, gegen die die
// Vertragsdatei steht.

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentError(`Die Antwort des Agenten auf „${path}" ist kein Objekt.`);
  }
  return value as Record<string, unknown>;
}

function asText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asFlag(value: unknown): boolean {
  return value === true;
}

function readEntry(raw: unknown): WebftpEntry {
  const entry = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    name: asText(entry.name),
    // Unverändert durchgereicht — auch ein unbekannter Wert. Siehe `WebftpEntry`.
    kind: asText(entry.kind),
    size: asNumber(entry.size),
    changedAt: asNumber(entry.changedAt),
    uid: asNumber(entry.uid, -1),
    gid: asNumber(entry.gid, -1)
  };
}

function readDiagnostics(raw: unknown): ShareDiagnostics | null {
  if (typeof raw !== "object" || raw === null) return null;
  const diagnostics = raw as Record<string, unknown>;
  return {
    readable: asFlag(diagnostics.readable),
    deletable: asFlag(diagnostics.deletable),
    uid: asNumber(diagnostics.uid, -1),
    gid: asNumber(diagnostics.gid, -1),
    uploadable: asFlag(diagnostics.uploadable)
  };
}

// ---------------------------------------------------------------------------
// Die sieben Routen
// ---------------------------------------------------------------------------

/**
 * Welche Bind-Mounts als Freigabe taugen (`GET /containers/:id/share-candidates`).
 *
 * ⚠️ DIE EINZIGE INTERN-ONLY-ROUTE DIESER FLÄCHE, und der Grund steht in der
 * Antwort: sie nennt die Bind-Mounts des Containers, also die Struktur des
 * Hosts. Beim Agenten steht sie deshalb nicht bei den sechs anderen, sondern
 * unter den intern-only-Routen (`src/route-policy.ts:110`). Nicht der
 * Schreibzugriff entscheidet dort über die Stufe, sondern ob die Antwort den
 * Host verrät.
 */
export async function listShareCandidates(
  target: AgentTarget,
  containerId: string,
  options: FileRequestOptions
): Promise<ShareCandidate[]> {
  const id = encodeId(containerId);
  const candidatesRoute = `/containers/${id}/share-candidates`;
  const answer = asRecord(await agentGet(target, candidatesRoute, options), candidatesRoute);
  const raw = Array.isArray(answer.candidates) ? answer.candidates : [];
  return raw.map((item) => {
    const candidate = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    return {
      relative: asText(candidate.relative),
      destination: asText(candidate.destination),
      writable: asFlag(candidate.writable)
    };
  });
}

/**
 * Ein Verzeichnis der Freigabe auflisten (`GET /containers/:id/files`).
 *
 * ⚠️ Die Liste endet bei `MAX_ENTRIES`; dass gekürzt wurde, steht in
 * `truncated` und wird vom Agenten nicht verschwiegen. Wer das Feld wegwirft,
 * verschweigt es an seiner Stelle.
 */
export async function listFiles(
  target: AgentTarget,
  containerId: string,
  location: SharePath,
  options: FileRequestOptions
): Promise<FileListing> {
  const id = encodeId(containerId);
  const listingRoute = `/containers/${id}/files?${shareQuery(location)}`;
  const answer = asRecord(await agentGet(target, listingRoute, options), listingRoute);
  return {
    share: asText(answer.share, location.share),
    path: asText(answer.path, location.path),
    entries: (Array.isArray(answer.entries) ? answer.entries : []).map(readEntry),
    truncated: asFlag(answer.truncated),
    diagnostics: readDiagnostics(answer.diagnostics)
  };
}

/**
 * Eine Datei herunterladen (`GET /containers/:id/file`).
 *
 * Zurück kommt der Strom und nicht sein Inhalt — der Agent deckelt diese
 * Richtung nicht, `MAX_UPLOAD_BYTES` gilt nur für das Hochladen. Der Aufrufer
 * leitet ihn weiter; erst wer ihn liest, bezahlt ihn.
 *
 * ⚠️ `path` zeigt hier auf die DATEI und nicht auf ihr Verzeichnis. Ein leerer
 * Pfad ist die Freigabe selbst, und der Agent lehnt ihn mit `path-traversal`
 * ab — er lädt kein Verzeichnis herunter.
 */
export async function downloadFile(
  target: AgentTarget,
  containerId: string,
  location: SharePath,
  options: FileRequestOptions & { signal?: AbortSignal }
): Promise<FileDownload> {
  const id = encodeId(containerId);
  const downloadRoute = `/containers/${id}/file?${shareQuery(location)}`;
  // ⚠️ THE ERROR BODY OF A REFUSAL IS FETCHED AFTERWARDS (#262). `agentDownload`
  // leaves the body to the caller, so a refused download carried no `reason`:
  // `503 agent-read-only` and `404 not-allowlisted` reached the browser as a
  // bare status, unlike on every other route of this surface. Why this is not
  // in `protocol.ts` is written in `stream-rejection.ts`. The plain `fetch` is
  // passed on purpose: the transport of the download stays what it was.
  const watch = watchStreamRejection(options.fetchImpl ?? fetch);
  let response: Response;
  try {
    response = await agentDownload(target, downloadRoute, { ...options, fetchImpl: watch.fetchImpl });
  } catch (error) {
    throw await watch.withDetail(error);
  }

  const announced = response.headers.get("content-length");
  const size = announced === null ? null : Number.parseInt(announced, 10);
  if (response.body === null) {
    // Gemessen ausgeschlossen: der Agent setzt bei einer leeren Datei `200` mit
    // `content-length: 0` und einem leeren Rumpf. Ein fehlender Rumpf wäre
    // etwas anderes als ein leerer, und dieser Fall sagt das, statt später an
    // einem `null` zu scheitern.
    throw new AgentError(`Die Antwort des Agenten auf „${downloadRoute}" trägt keinen Rumpf.`, response.status);
  }
  return { size: size !== null && Number.isFinite(size) ? size : null, stream: response.body };
}

/**
 * Eine Datei hochladen (`PUT /containers/:id/file`).
 *
 * ⚠️ `location.path` ist das ZIELVERZEICHNIS, `name` der Dateiname — und beide
 * gehen getrennt hinaus. Der Agent schickt sie durch zwei verschiedene
 * Prüfungen: `checkEntryPath` trennt an Schrägstrichen, `checkName` prüft den
 * Namen byteweise. Ein zusammengesetzter Pfad liefe an der zweiten vorbei.
 *
 * ⚠️ Nicht vorgeprüft. Über `MAX_UPLOAD_BYTES` antwortet der Agent mit `413`;
 * wer dem Betreiber früher etwas sagen will, prüft VOR diesem Aufruf.
 */
export async function uploadFile(
  target: AgentTarget,
  containerId: string,
  destination: SharePath & { name: string },
  content: Uint8Array,
  options: FileRequestOptions
): Promise<FileUploaded> {
  const params = new URLSearchParams();
  params.set("share", destination.share);
  params.set("path", destination.path);
  params.set("name", destination.name);
  const id = encodeId(containerId);
  const uploadRoute = `/containers/${id}/file?${params.toString()}`;
  const answer = asRecord(await agentUpload(target, uploadRoute, content, options), uploadRoute);
  return { ok: true, name: asText(answer.name, destination.name), size: asNumber(answer.size, content.length) };
}

/**
 * Eine Textdatei zum Bearbeiten holen (`GET /containers/:id/file-text`).
 *
 * ⚠️ Der `hash` ist kein Beiwerk: er geht beim Speichern als `expectedHash`
 * zurück und ist die einzige Sperre gegen das stille Überschreiben fremder
 * Änderungen. Ein Aufrufer, der ihn wegwirft, kann nicht mehr speichern — der
 * Agent verlangt ihn und kennt keinen „egal"-Wert.
 */
export async function readFileText(
  target: AgentTarget,
  containerId: string,
  location: SharePath,
  options: FileRequestOptions
): Promise<FileText> {
  const id = encodeId(containerId);
  const textRoute = `/containers/${id}/file-text?${shareQuery(location)}`;
  const answer = asRecord(await agentGet(target, textRoute, options), textRoute);
  return { path: asText(answer.path, location.path), content: asText(answer.content), hash: asText(answer.hash) };
}

/**
 * Eine Textdatei speichern (`PUT /containers/:id/file-text`).
 *
 * ⚠️ DER KONFLIKT WIRD NICHT GEWORFEN, sondern zurückgegeben. Ein `409` heißt
 * hier nicht „kaputt", sondern „jemand anders war schneller" — und die Antwort
 * trägt den JETZIGEN Hash, mit dem der Editor dem Betreiber seine Änderung
 * erhalten kann. Ihn als Ausnahme zu behandeln hieße, die einzige verwertbare
 * Auskunft des Fehlers wegzuwerfen.
 *
 * Jeder ANDERE Fehlerstatus bleibt eine Ausnahme und reist unverändert weiter.
 */
export async function writeFileText(
  target: AgentTarget,
  containerId: string,
  location: SharePath,
  edit: { content: string; expectedHash: string },
  options: FileRequestOptions
): Promise<FileTextWrite> {
  const id = encodeId(containerId);
  const editRoute = `/containers/${id}/file-text?${shareQuery(location)}`;
  try {
    const answer = asRecord(
      await agentPut(target, editRoute, { content: edit.content, expectedHash: edit.expectedHash }, options),
      editRoute
    );
    return { ok: true, hash: asText(answer.hash) };
  } catch (error) {
    if (!(error instanceof AgentError) || error.status !== 409) throw error;
    // `detail` trägt den Rumpf des `409` — siehe `AgentError.detail`. Fehlt er
    // ausnahmsweise, bleibt der Konflikt ein Konflikt: nur ohne den Hash, mit
    // dem der Editor sonst weiterarbeiten könnte.
    const refusal = typeof error.detail === "object" && error.detail !== null
      ? (error.detail as Record<string, unknown>)
      : {};
    return { ok: false, reason: asText(refusal.error, "konflikt"), hash: asText(refusal.hash) };
  }
}

/**
 * Anlegen, umbenennen, entfernen (`POST /containers/:id/files`).
 *
 * ⚠️ DIE EINZIGE ROUTE DIESER FLÄCHE, DIE EINE ANWEISUNG TRÄGT statt eines
 * Inhalts — und deshalb `POST` und nicht `PUT`. Die drei erlaubten Werte für
 * `action` stehen als `FILE_ACTIONS` in der Vertragsdatei. Der Agent
 * vergleicht sie wörtlich, und ein Name der Hub-API endet dort in einem
 * `400`.
 *
 * ⚠️ Der Abfrageteil trägt hier NUR `share`. Der Pfad steht im Rumpf, weil er
 * je nach Aktion etwas anderes bezeichnet — bei `create-folder` das
 * Zielverzeichnis, sonst den Eintrag selbst.
 */
export async function applyFileAction(
  target: AgentTarget,
  containerId: string,
  share: string,
  command: FileCommand,
  options: FileRequestOptions
): Promise<FileActionDone> {
  const params = new URLSearchParams();
  params.set("share", share);
  const id = encodeId(containerId);
  const actionRoute = `/containers/${id}/files?${params.toString()}`;
  const payload: Record<string, unknown> = { action: command.action, path: command.path };
  if (command.name !== undefined) payload.name = command.name;
  const answer = asRecord(await agentPost(target, actionRoute, payload, options), actionRoute);
  return {
    name: typeof answer.name === "string" ? answer.name : null,
    kind: typeof answer.kind === "string" ? answer.kind : null
  };
}
