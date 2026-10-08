import type { ContainerShare, FileSource } from "contract";

import { normalizeSharePath } from "../../domain/containers/index.js";
import type {
  ContainerAccess,
  ContainerAccessRequest,
  ContainerAccessResult,
  RouteWriting
} from "../../domain/hosts/index.js";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import type { RouteFailure } from "../../platform/http/route-failure.js";
import { AGENT_ACTIONS } from "./actions.js";
import * as agentClient from "./agent-client.js";
import {
  MAX_TEXT_BYTES,
  MAX_UPLOAD_BYTES,
  type FileDownload,
  type FileListing,
  type FileText,
  type FileUploaded,
  type FileActionDone,
  type ShareCandidate,
  type SharePath
} from "./agent-client.js";

// The service of the feature `files` (#262): everything between the HTTP route
// and the agent client — the chain to the container, the chosen share, the
// checks the hub makes before it asks the agent, and the agent's refusals as
// data. The route reads parameters, sets the status and writes the answer;
// what a request comes to is decided here, and `service.test.ts` decides it
// without Express, without Postgres and without an agent.
//
// ⚠️ ALL TEN ROUTES ARE ADMIN-ONLY, and the route says so, not this file
// (`requireAdmin` in `routes.ts`): the role is a layer of its own in front of
// the service. What the service never does is take a share or a caller from
// the request: the share comes from the store (`ShareStore`), the caller from
// the session (`ContainerAccessRequest.userId`).
//
// ⚠️ THE ORDER OF THE CHECKS IS THE ANSWER. A check that costs nothing comes
// first (a parameter's shape, a body's kind), then the chain to the arm
// (reachability, container), then the share, and only then the agent. An
// invalid value triggers neither a probe nor an agent call.
//
// The agent's refusals leave as `{ kind: "agent-error" }`: which status and
// code they become is one table for every surface
// (`platform/http/agent-error-translation.ts`), written by the route.

export type FilesAgent = { listFileSources?: typeof agentClient.listFileSources } & Pick<
  typeof agentClient,
  | "listShareCandidates"
  | "listFiles"
  | "downloadFile"
  | "uploadFile"
  | "readFileText"
  | "writeFileText"
  | "applyFileAction"
>;

/** The chosen share of a container, as functions and not a pool. */
export type ShareStore = {
  read: (hostId: string, containerName: string) => Promise<string | null>;
  set: (hostId: string, containerName: string, path: string) => Promise<ContainerShare>;
  remove: (hostId: string, containerName: string) => Promise<void>;
};

export type FilesServiceDeps = {
  /** The chain host → reachability → version → container. */
  openContainer: (request: ContainerAccessRequest, writing: RouteWriting) => Promise<ContainerAccessResult>;
  shares: ShareStore;
  agent?: FilesAgent;
};

/** Which container, and who asks. `userId` comes from the session. */
export type ContainerRef = ContainerAccessRequest;

type Failed = { ok: false; failure: RouteFailure };

/** What a plan for an upload or a save of text comes to before a byte is read. */
export type BodyPlan<Result> =
  | Failed
  | {
      ok: true;
      /** The cap for the body; the route stops reading above it. */
      maxBytes: number;
      /** What the route answers when the body is over the cap. */
      tooLarge: RouteFailure;
      /** Sends the body to the agent. Call it once, with the whole body. */
      send: (content: Buffer) => Promise<Result>;
    };

/**
 * The editor lost the race: someone changed the file since it was loaded.
 * `hash` is what the file carries NOW, and the point of the answer.
 */
export type TextConflict = { reason: string; hash: string };

export type FilesService = {
  listSources: (ref: ContainerRef) => Promise<Failed | { ok: true; sources: FileSource[] }>;
  listCandidates: (ref: ContainerRef) => Promise<Failed | { ok: true; candidates: ShareCandidate[] }>;
  readShare: (ref: ContainerRef) => Promise<Failed | { ok: true; share: ContainerShare | null }>;
  chooseShare: (ref: ContainerRef, body: unknown) => Promise<Failed | { ok: true; share: ContainerShare }>;
  removeShare: (ref: ContainerRef) => Promise<Failed | { ok: true }>;
  list: (
    ref: ContainerRef,
    query: { sourceId?: unknown; path: unknown }
  ) => Promise<Failed | { ok: true; listing: FileListing; maxUploadBytes: number }>;
  planDownload: (
    ref: ContainerRef,
    query: { sourceId?: unknown; path: unknown }
  ) => Promise<
    | Failed
    | {
        ok: true;
        /** The path inside the share; the name for the browser comes from it. */
        path: string;
        /** Opens the agent stream. Throws an `AgentError` for the relay to translate. */
        start: (signal: AbortSignal) => Promise<FileDownload>;
      }
  >;
  readText: (ref: ContainerRef, query: { sourceId?: unknown; path: unknown }) => Promise<Failed | { ok: true; text: FileText }>;
  planUpload: (
    ref: ContainerRef,
    query: { sourceId?: unknown; path: unknown; name: unknown; jsonBody: boolean }
  ) => Promise<BodyPlan<Failed | { ok: true; uploaded: FileUploaded }>>;
  planTextSave: (
    ref: ContainerRef,
    query: { sourceId?: unknown; path: unknown; expectedHash: unknown; jsonBody: boolean }
  ) => Promise<BodyPlan<Failed | { ok: true; hash: string } | { ok: false; conflict: TextConflict }>>;
  applyAction: (ref: ContainerRef, body: unknown) => Promise<Failed | { ok: true; done: FileActionDone }>;
};

function problem(status: number, error: string, message: string): Failed {
  return { ok: false, failure: { kind: "problem", status, error, message } };
}

/** A query part as text; missing means empty, anything but text is `null`. */
function queryText(value: unknown): string | null {
  if (value === undefined) return "";
  if (typeof value !== "string") return null;
  return value;
}

export function createFilesService(deps: FilesServiceDeps): FilesService {
  const agent: FilesAgent = deps.agent ?? agentClient;

  /** The agent call as a value: its refusal is data, anything else a bug. */
  async function asked<T>(call: () => Promise<T>): Promise<{ ok: true; value: T } | Failed> {
    try {
      return { ok: true, value: await call() };
    } catch (error) {
      if (!(error instanceof AgentError)) throw error;
      return { ok: false, failure: { kind: "agent-error", error } };
    }
  }

  /**
   * The chosen share of this container — or the hub's own `409`.
   *
   * ⚠️ IT COMES FROM THE STORE AND NEVER FROM THE REQUEST. The caller names the
   * container, not the share; which path is visible is an operator decision
   * and stands in `container_share`. A field for it in the request would
   * invite taking it from there some day.
   *
   * ⚠️ IF IT IS MISSING, THE HUB ANSWERS ITSELF. It knows without a network,
   * and a detour through the agent (its `no-share` is a `409` from
   * `checkWebftpAccess`) would cost a connection to learn the same — and pass
   * a foreign error code into the hub's contract.
   */
  async function requireShare(access: ContainerAccess): Promise<{ ok: true; share: string } | Failed> {
    const share = await deps.shares.read(access.host.id, access.container.name);
    if (share === null) {
      return problem(
        409,
        "share-unset",
        `Für „${access.container.name}" ist keine Freigabe gewählt. Der Betreiber wählt sie aus den ` +
          "Bind-Mounts des Containers; ohne sie gibt es kein Verzeichnis, in dem diese Fläche arbeitet."
      );
    }
    return { ok: true, share };
  }

  /**
   * The chain up to the place of work: path, host, reachability, container,
   * share.
   *
   * ⚠️ The path from the query is checked FIRST — a check of the shape costs
   * nothing, and an invalid value triggers neither a probe nor an agent call
   * (the same reason as `tail` at the log stream).
   */
  async function locate(
    ref: ContainerRef,
    rawPath: unknown,
    writing: RouteWriting,
    sourceId?: unknown
  ): Promise<{ ok: true; access: ContainerAccess; at: SharePath } | Failed> {
    const path = queryText(rawPath);
    if (path === null) {
      return problem(
        400,
        "invalid-input",
        "„path“ ist ein Text — der Pfad innerhalb der Freigabe; leer heißt ihre Wurzel."
      );
    }
    if (sourceId !== undefined && (typeof sourceId !== "string" || !sourceId)) return problem(400, "invalid-input", "Ungültige Quelle.");
    const opened = await deps.openContainer(ref, writing);
    if (!opened.ok) return opened;
    if (typeof sourceId === "string") return { ok: true, access: opened.access, at: { share: "", sourceId, path } };
    const share = await requireShare(opened.access);
    if (!share.ok) return share;
    return { ok: true, access: opened.access, at: { share: share.share, path } };
  }

  return {
    listSources: async (ref) => {
      const opened = await deps.openContainer(ref, "reads");
      if (!opened.ok) return opened;
      const { target, container, options } = opened.access;
      const sources = await asked(() => (agent.listFileSources ?? agentClient.listFileSources)(target, container.id, options));
      return sources.ok ? { ok: true, sources: sources.value } : sources;
    },
    listCandidates: async (ref) => {
      const opened = await deps.openContainer(ref, "reads");
      if (!opened.ok) return opened;
      const { target, container, options } = opened.access;
      const candidates = await asked(() => agent.listShareCandidates(target, container.id, options));
      return candidates.ok ? { ok: true, candidates: candidates.value } : candidates;
    },

    // ⚠️ `null` IS AN ANSWER AND NOT A FAILURE. "Nobody has chosen yet" is the
    // normal state of every container the hub sees for the first time. It is
    // the SAME read as `requireShare` — a divergence between the two is not
    // possible. And the arm has to be reachable even for this plain read: the
    // store is keyed by container NAME, the path carries the ID, and the only
    // source for the mapping is the arm's list at this moment.
    readShare: async (ref) => {
      const opened = await deps.openContainer(ref, "reads");
      if (!opened.ok) return opened;
      const path = await deps.shares.read(opened.access.host.id, opened.access.container.name);
      return {
        ok: true,
        share: path === null ? null : { containerName: opened.access.container.name, path }
      };
    },

    chooseShare: async (ref, body) => {
      const wanted = normalizeSharePath((body as { path?: unknown } | null)?.path);
      if (!wanted.ok) {
        // ⚠️ The check of the shape BEFORE the chain: it costs nothing, and a
        // malformed body must trigger neither a probe nor two agent calls. An
        // EMPTY path is the most dangerous case — it would look like an entry
        // and mean the whole project directory at the agent.
        return problem(
          400,
          "invalid-input",
          "„path“ ist der Pfad einer Freigabe aus der Kandidatenliste — ein nicht leerer Text."
        );
      }
      const opened = await deps.openContainer(ref, "writes");
      if (!opened.ok) return opened;
      const { host, target, container, options } = opened.access;

      // ⚠️ THE CHOSEN PATH IS HELD AGAINST THE AGENT'S CANDIDATE LIST before it
      // reaches the store. Without it the store would be the way to push a
      // share on the agent that the operator never saw: the registry sync
      // (`domain/containers/registry-sync.ts`) carries every row of the table
      // into the arm's allowlist. A barrier one fills oneself is none.
      const candidates = await asked(() => agent.listShareCandidates(target, container.id, options));
      if (!candidates.ok) return candidates;

      // Character by character and not "starts with": the agent compares its
      // copy of the registry the same way, and a prefix match here would let
      // through a path the arm refuses afterwards.
      if (!candidates.value.some((candidate) => candidate.relative === wanted.value)) {
        return problem(
          409,
          "share-unknown",
          `„${wanted.value}" ist kein Bind-Mount dieses Containers. Gewählt werden kann nur, was die ` +
            "Kandidatenliste führt."
        );
      }
      return { ok: true, share: await deps.shares.set(host.id, container.name, wanted.value) };
    },

    // ⚠️ THE WRITE LOCK (`"writes"`) HOLDS ALTHOUGH THE AGENT IS NOT ASKED. What
    // disappears here disappears from the arm's allowlist at the next registry
    // sync, so the call does change what is reachable there. The price: a share
    // cannot be taken back exactly when the arm does not answer. The reason is
    // the key of the store (container name), not this line.
    removeShare: async (ref) => {
      const opened = await deps.openContainer(ref, "writes");
      if (!opened.ok) return opened;
      await deps.shares.remove(opened.access.host.id, opened.access.container.name);
      return { ok: true };
    },

    list: async (ref, query) => {
      const place = await locate(ref, query.path, "reads", query.sourceId);
      if (!place.ok) return place;
      const { target, container, options } = place.access;
      const listing = await asked(() => agent.listFiles(target, container.id, place.at, options));
      if (!listing.ok) return listing;
      // ⚠️ `maxUploadBytes` STANDS IN THE ENVELOPE AND NOT IN `listing`. The
      // listing is the agent's shape; the cap is the hub's word about the other
      // side and belongs next to it. It goes out so the surface can REFUSE a
      // too large file before it is uploaded — without it the browser uploads
      // 500 MB and only then gets the `413` (#136).
      return { ok: true, listing: listing.value, maxUploadBytes: MAX_UPLOAD_BYTES };
    },

    planDownload: async (ref, query) => {
      const place = await locate(ref, query.path, "reads", query.sourceId);
      if (!place.ok) return place;
      if (place.at.path === "") {
        // The agent answered this with `path-traversal` — it downloads no
        // directory. That is the caller's error and needs no line.
        return problem(400, "invalid-input", "„path“ zeigt beim Download auf eine DATEI, nicht auf ein Verzeichnis.");
      }
      const { target, container, options } = place.access;
      return {
        ok: true,
        path: place.at.path,
        start: (signal) => agent.downloadFile(target, container.id, place.at, { ...options, signal })
      };
    },

    readText: async (ref, query) => {
      const place = await locate(ref, query.path, "reads", query.sourceId);
      if (!place.ok) return place;
      const { target, container, options } = place.access;
      const text = await asked(() => agent.readFileText(target, container.id, place.at, options));
      return text.ok ? { ok: true, text: text.value } : text;
    },

    // `path` is the TARGET DIRECTORY, `name` the file name, and they go out
    // SEPARATELY: the agent sends them through two different checks
    // (`checkEntryPath` splits at slashes, `checkName` checks byte by byte). A
    // composed path would run past the second.
    planUpload: async (ref, query) => {
      const name = queryText(query.name);
      if (name === null || name === "") {
        return problem(400, "invalid-input", "„name“ ist der Name der hochgeladenen Datei.");
      }
      // ⚠️ The body has to arrive as BYTES. `express.json({ limit: "64kb" })`
      // hangs in front of the whole router (`server/src/index.ts`) and would
      // have read a JSON body long ago — this stream would then be empty and
      // the upload a file with zero bytes. A named failure beats a silent
      // empty file.
      if (query.jsonBody) {
        return problem(
          415,
          "invalid-content-type",
          "Der Rumpf eines Uploads sind Bytes („application/octet-stream“) und kein JSON."
        );
      }
      const place = await locate(ref, query.path, "writes", query.sourceId);
      if (!place.ok) return place;
      const { target, container, options } = place.access;
      return {
        ok: true,
        maxBytes: MAX_UPLOAD_BYTES,
        // Checked before, although the agent caps itself: sending 64 MiB through
        // the tunnel to have them refused there costs the line.
        tooLarge: {
          kind: "problem",
          status: 413,
          error: "too-large",
          message: `Ein Upload trägt höchstens ${MAX_UPLOAD_BYTES} Bytes.`
        },
        // An empty body is an empty file and goes through.
        send: async (content) => {
          const uploaded = await asked(() =>
            agent.uploadFile(target, container.id, { ...place.at, name }, content, options)
          );
          return uploaded.ok ? { ok: true, uploaded: uploaded.value } : uploaded;
        }
      };
    },

    // ⚠️ THE TEXT COMES AS A RAW BODY AND NOT AS JSON — the same build as the
    // upload, for the same measured reason. `express.json({ limit: "64kb" })`
    // rejects anything above 64 kB before a route sees it, with the HTML text
    // of the Express error handler instead of a code, while the agent takes
    // text up to `MAX_TEXT_BYTES` (1 MiB). As JSON the editor would be broken
    // for every file between 64 kB and 1 MiB, and the failure would look like
    // a network error. Whoever "unifies" this back to JSON rebuilds exactly
    // that case; the three alternatives (raise the global cap, exempt the path
    // from the global parser, fix this route's cap at 64 kB) were weighed and
    // rejected.
    //
    // The expected hash stands in the QUERY PART, like `share` and `path`. It
    // is no secret: it stands in the answer of the read anyway.
    planTextSave: async (ref, query) => {
      const expectedHash = queryText(query.expectedHash);
      if (expectedHash === null || expectedHash === "") {
        // ⚠️ No "don't care" value. The agent demands the hash as well
        // (`expected-hash-missing`), and it is the only lock against silently
        // overwriting someone else's change — a caller that leaves it out does
        // not want to save, it overlooked something.
        return problem(
          400,
          "invalid-input",
          "„expectedHash“ ist der Hash aus dem Laden dieser Datei und steht im Abfrageteil. Ohne ihn " +
            "gibt es keine Sperre gegen das Überschreiben fremder Änderungen."
        );
      }
      // The same check and the same code as at the upload: had the body come as
      // JSON, `express.json` would have consumed it, the stream would be empty,
      // and this route would write an EMPTY FILE over the operator's.
      if (query.jsonBody) {
        return problem(
          415,
          "invalid-content-type",
          "Der Rumpf ist der Text selbst („text/plain; charset=utf-8“) und kein JSON."
        );
      }
      const place = await locate(ref, query.path, "writes", query.sourceId);
      if (!place.ok) return place;
      const { target, container, options } = place.access;
      return {
        ok: true,
        // ⚠️ `MAX_TEXT_BYTES` and NOT `MAX_UPLOAD_BYTES`: two different limits of
        // the other side, not two versions of one. The text goes through
        // `readTextFile` of the agent (1 MiB), the upload through the daemon
        // (64 MiB); the larger one here would send 64 MiB through the tunnel to
        // have them refused at the other end.
        maxBytes: MAX_TEXT_BYTES,
        tooLarge: {
          kind: "problem",
          status: 413,
          error: "too-large",
          message: `Eine Textdatei trägt höchstens ${MAX_TEXT_BYTES} Bytes.`
        },
        send: async (content) => {
          // ⚠️ THE WAY BACK IS CHECKED, and it is the only protection against a
          // loss of data nobody notices. `toString("utf8")` replaces an invalid
          // byte sequence SILENTLY with U+FFFD; what would be saved is not the
          // operator's file but one in which every broken place became a
          // replacement character — and the receipt would say "saved". The
          // agent makes the same round trip on its side (`readTextFile` in
          // `src/webftp.ts`); the hub must not break the bytes before.
          //
          // An EMPTY text is valid: it saves an empty file.
          const text = content.toString("utf8");
          if (!Buffer.from(text, "utf8").equals(content)) {
            return problem(
              400,
              "invalid-encoding",
              "Der Rumpf ist kein gültiges UTF-8. Der Texteditor speichert Text; eine Datei mit ungültigen " +
                "Bytefolgen geht über den Upload und nicht über diesen Weg."
            );
          }
          const written = await asked(() =>
            agent.writeFileText(target, container.id, place.at, { content: text, expectedHash }, options)
          );
          if (!written.ok) return written;
          // ⚠️ A CONFLICT IS AN ANSWER AND NO FAILURE: `writeFileText` returns it
          // as a branch, with the hash the file carries now.
          if (!written.value.ok) return { ok: false, conflict: { reason: written.value.reason, hash: written.value.hash } };
          return { ok: true, hash: written.value.hash };
        }
      };
    },

    // The one route of this surface that carries an INSTRUCTION instead of a
    // content, hence `POST` and not `PUT`.
    applyAction: async (ref, body) => {
      const { action, path, name, sourceId } = (body ?? {}) as { action?: unknown; path?: unknown; name?: unknown; sourceId?: unknown };
      const agentAction = typeof action === "string" ? AGENT_ACTIONS.get(action) : undefined;
      if (!agentAction) {
        return problem(400, "invalid-input", `„action“ ist einer von: ${[...AGENT_ACTIONS.keys()].join(", ")}.`);
      }
      if (typeof path !== "string") {
        return problem(
          400,
          "invalid-input",
          "„path“ ist bei „create-directory“ das Zielverzeichnis, sonst der Eintrag selbst — leer heißt die " +
            "Wurzel der Freigabe."
        );
      }
      if (name !== undefined && (typeof name !== "string" || name === "")) {
        return problem(400, "invalid-input", "„name“ ist ein nicht leerer Text oder fehlt.");
      }

      const opened = await deps.openContainer(ref, "writes");
      if (!opened.ok) return opened;
      if (sourceId !== undefined && (typeof sourceId !== "string" || !sourceId)) return problem(400, "invalid-input", "Ungültige Quelle.");
      const share = sourceId ? { ok: true as const, share: "" } : await requireShare(opened.access);
      if (!share.ok) return share;
      const { target, container, options } = opened.access;

      // ⚠️ The path stands in the BODY and not in the query part, because it
      // means something else per action. The query part to the agent carries
      // only the share — `applyFileAction` takes it separately.
      const done = await asked(() =>
        agent.applyFileAction(
          target,
          container.id,
          share.share,
          { action: agentAction, path, ...(name === undefined ? {} : { name }) },
          options,
          typeof sourceId === "string" ? sourceId : undefined
        )
      );
      return done.ok ? { ok: true, done: done.value } : done;
    }
  };
}
