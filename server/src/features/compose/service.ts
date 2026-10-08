import type {
  ContainerAccess,
  ContainerAccessRequest,
  ContainerAccessResult,
  HostCycleOutcome,
  HostRecord,
  RouteWriting
} from "../../domain/hosts/index.js";
import { AgentError, type Actor } from "../../platform/agent-transport/protocol.js";
import type { RouteFailure } from "../../platform/http/route-failure.js";
import { envWriteRequestSchema, HUB_STREAM_BROKEN } from "contract";
import * as agentClient from "./agent-client.js";
import { MAX_COMPOSE_BYTES } from "./agent-client.js";
import { isExternallyManagedStack } from "./externally-managed-stack.js";
import { isHubOwnStack } from "./hub-own-stack.js";
import { dryRunFromLocalPreview } from "./local-preview.js";
import { isRouteUnknown } from "./reasons.js";
import { resyncAfterWrite, type ResyncReport } from "./resync.js";
import * as selectionClient from "./selection-client.js";
import type { ComposeCandidates } from "./selection-client.js";
import type {
  ComposeApplyInput,
  ComposeApplyResult,
  ComposeDryRun,
  ComposeFile,
  ProjectEnv
} from "./types.js";

// The service of the feature `compose` (#264): everything between the HTTP
// route and the agent client — the chain to the container, the lock against
// the hub's own stack, the checks the hub makes before it asks the agent, the
// two fallbacks for old arms and the way applying runs. The route reads
// parameters, sets the status and writes the answer; what a request comes to is
// decided here, and `service.test.ts` decides it without Express, without
// Postgres and without an agent.
//
// ⚠️ ALL FOUR ROUTES ARE ADMIN-ONLY, and the route says so, not this file
// (`requireAdmin` in `routes.ts`): the role is a layer of its own in front of
// the service. What the service never does is take the caller from the
// request: it comes from the session (`ContainerAccessRequest.userId`).
//
// ⚠️ THE ORDER OF THE CHECKS IS THE ANSWER. The chain to the arm comes first
// (reachability, container), then the lock against the hub's own stack, then
// what the body says (hash, size), and only then the agent. A refusal that
// costs nothing never triggers a call.
//
// The agent's refusals leave as `{ kind: "agent-error" }`: which status and
// code they become is one table for this surface (`reasons.ts`), written by
// the route.
//
// ⚠️ THE SELECTION BY HAND (#185) HAS TWO LOCKS OF THE HUB IN FRONT OF THE
// AGENT, both before a call: the hub's own stack stays locked (#183) — a
// selection there leads straight to an apply the apply route refuses anyway —
// and an `outdated` arm gets no selection, because setting one writes. The
// hub stores nothing; the choice lives in the agent's state and survives a
// restart there (`selection-client.ts` says why).

export type ComposeAgent = { writeProjectEnv?: typeof agentClient.writeProjectEnv } & Pick<
  typeof agentClient,
  "readComposeFile" | "previewComposeOnAgent" | "applyCompose" | "applyComposeStreaming" | "readProjectEnv"
> &
  Pick<typeof selectionClient, "readComposeCandidates" | "selectComposeFile" | "clearComposeSelection">;

export type ComposeServiceDeps = {
  /** The chain host → reachability → version → container. */
  openContainer: (request: ContainerAccessRequest, writing: RouteWriting) => Promise<ContainerAccessResult>;
  /** The reconciliation after applying; absent means "not wired", and the answer says so. */
  resyncHost?: (record: HostRecord, actor: Actor) => Promise<HostCycleOutcome>;
  agent?: ComposeAgent;
  /**
   * The short id of this hub's own container. Injectable, because the hostname
   * of a test process is no container id; absent, `ownShortId()` reads it.
   */
  ownShortId?: () => string | null;
};

/** Which container, and who asks. `userId` comes from the session. */
export type ContainerRef = ContainerAccessRequest;

type Failed = { ok: false; failure: RouteFailure };

/** The wire form of a read file. */
export type ComposeFileWire = Pick<
  ComposeFile,
  | "projectDir"
  | "composeFileName"
  | "stackName"
  | "content"
  | "composeHash"
  | "services"
  | "servicesInFile"
  | "fileReadable"
  | "containerIds"
  | "inventoryViolations"
> & {
  // ⚠️ Eine Auskunft DES HUBS neben denen des Agenten (#183): der Stack, in
  // dem dieser Hub selbst läuft. Die Fläche bietet dann kein Anwenden an;
  // die Schranke selbst steht an der Anwende-Route.
  hubOwnStack: boolean;
  /**
   * Also the hub's word (#56): a service of this stack is externally managed.
   * Preview and apply are refused with `403 externally-managed`.
   */
  externallyManaged: boolean;
  /**
   * Also the hub's word (#185): the selection by hand is offered for this
   * container. `false` at the hub's own stack and at an `outdated` arm.
   */
  selectionSupported: boolean;
};

/** The stream to the browser, as `relayAgentStream` gives it to the route. */
export type ComposeStream = {
  /** Aborted when the browser's connection closes. */
  signal: AbortSignal;
  /** Writes one event; the promise is the back-pressure. */
  write: (event: unknown) => Promise<void>;
};

export type ApplyPlan =
  | Failed
  | {
      ok: true;
      /**
       * Applies the draft and reports every step. Call it once.
       *
       * Throws what happens BEFORE the first line is written (an `AgentError` is
       * a status for the route, anything else a bug of the hub). What happens
       * after is a line in the stream, never a throw.
       */
      run: (stream: ComposeStream) => Promise<void>;
    };

export type ComposeService = {
  /**
   * A failed read carries `selectionSupported` once the chain stood: the
   * surface offers the selection exactly where the arm found no file.
   */
  read: (
    ref: ContainerRef
  ) => Promise<(Failed & { selectionSupported?: boolean }) | { ok: true; compose: ComposeFileWire }>;
  writeEnv: (ref: ContainerRef, body: unknown) => Promise<Failed | { ok: true; hash: string }>;
  readEnv: (ref: ContainerRef, plaintext: boolean) => Promise<Failed | { ok: true; env: ProjectEnv }>;
  preview: (ref: ContainerRef, body: unknown) => Promise<Failed | { ok: true; preview: ComposeDryRun }>;
  planApply: (ref: ContainerRef, body: unknown) => Promise<ApplyPlan>;
  candidates: (ref: ContainerRef) => Promise<Failed | { ok: true; selection: ComposeCandidates }>;
  select: (ref: ContainerRef, body: unknown) => Promise<Failed | { ok: true; selectedFilePath: string | null }>;
  clearSelection: (ref: ContainerRef) => Promise<Failed | { ok: true; selectedFilePath: null }>;
};

function problem(status: number, error: string, message: string): Failed {
  return { ok: false, failure: { kind: "problem", status, error, message } };
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function listField(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function createComposeService(deps: ComposeServiceDeps): ComposeService {
  const agent: ComposeAgent = deps.agent ?? { ...agentClient, ...selectionClient };

  /** The agent call as a value: its refusal is data, anything else a bug. */
  async function asked<T>(call: () => Promise<T>): Promise<{ ok: true; value: T } | Failed> {
    try {
      return { ok: true, value: await call() };
    } catch (error) {
      if (!(error instanceof AgentError)) throw error;
      return { ok: false, failure: { kind: "agent-error", error } };
    }
  }

  function ownStack(access: ContainerAccess): boolean {
    return isHubOwnStack(access.container, access.containers, deps.ownShortId?.());
  }

  function externallyManaged(access: ContainerAccess): Failed | null {
    return isExternallyManagedStack(access.container, access.containers)
      ? problem(
          403,
          "externally-managed",
          "Ein Dienst dieses Stacks wird fremdverwaltet. Seine Definition bleibt beim Verwalter."
        )
      : null;
  }

  /** Is the selection by hand offered for this container (#185)? */
  function selectionSupported(access: ContainerAccess): boolean {
    return access.writable && !ownStack(access);
  }

  /**
   * The chain for the three selection routes, with the locks of the hub.
   *
   * ⚠️ ALL THREE OPEN AS `writes`, the reading one too: it only exists to
   * prepare a write, and an `outdated` arm answers `409 agent-outdated`
   * before it is asked — the same answer the setting route gives.
   */
  async function openForSelection(ref: ContainerRef): Promise<Failed | { ok: true; access: ContainerAccess }> {
    const opened = await deps.openContainer(ref, "writes");
    if (!opened.ok) return opened;
    if (ownStack(opened.access)) {
      return problem(403, "hub-own-stack", "Die Zuordnung im Stack dieses Hubs bleibt gesperrt.");
    }
    return opened;
  }

  /**
   * Der Abgleich nach dem Anwenden — und was davon in die Antwort geht.
   *
   * ⚠️ ER DARF DAS ANWENDEN NICHT SCHEITERN LASSEN. Zu diesem Zeitpunkt ist die
   * Datei geschrieben und der Stack läuft; ein Fehler hier ist ein zweites,
   * kleineres Problem und kein Grund, dem Betreiber ein misslungenes Anwenden zu
   * melden. Er erfährt es trotzdem — als eigenes Feld und nicht als Schweigen,
   * denn ein Arm mit veralteter Allowlist lehnt danach jede weitere Aktion an
   * diesem Stack ab, und die Ursache wäre sonst nicht zu erraten.
   */
  function resync(host: HostRecord, actor: Actor): Promise<ResyncReport> {
    return resyncAfterWrite(deps.resyncHost, host, actor);
  }

  /**
   * Die Vorschau: erst der Agent, bei einem alten Arm die eigene Rechnung.
   *
   * ⚠️ NUR EINE UNBEANTWORTETE `404` LÖST DEN RÜCKFALL AUS, und das ist die
   * ganze Sorgfalt an dieser Stelle. Der Agent antwortet auf einen untauglichen
   * Entwurf mit `200` und `valid: false`; jeder andere Status heißt, dass die
   * Auskunft selbst nicht zu haben war — ein `503` des Kill-Switches, ein `403`
   * der Allowlist, ein `409` einer belegten Projektsperre. Wer auf diese still
   * in die eigene Rechnung fiele, zeigte dem Betreiber eine Vorschau für einen
   * Arm, der gerade gar nichts beantwortet, und beantwortete damit eine Frage,
   * die niemand gestellt hat.
   *
   * ⚠️ SEIT #129 ZÄHLT DER GRUND UND NICHT NUR DER STATUS. Eine `404`, die
   * `not-allowlisted` oder `container-gone` nennt, ist eine Antwort des Arms —
   * `isRouteUnknown` hält sie zurück, und der Betreiber liest sie als das, was sie
   * ist. Die Begründung steht bei `NOT_FOUND_ANSWERS` in `reasons.ts`.
   *
   * ⚠️ DER RÜCKFALL KOSTET EINEN LESEAUFRUF, DER SONST ENTFÄLLT. Der Trockenlauf
   * bringt Hash und Stacknamen selbst mit; die eigene Rechnung braucht die
   * gelesene Datei als Vergleichsstand. Deshalb steht `readComposeFile` HIER und
   * nicht davor — auf dem üblichen Weg wird sie nie gerufen.
   *
   * ⚠️ SEIT #130 STEHT `MIN_AGENT_VERSION` HOCH (seit #279 AUF `0.32.0`), und damit ist der
   * Rückfall unerreichbar. Warum er trotzdem bleibt, steht bei
   * `ComposeDryRun.source` in `types.ts`.
   */
  async function dryRun(access: ContainerAccess, draft: string): Promise<ComposeDryRun> {
    const { target, container, options } = access;
    try {
      return await agent.previewComposeOnAgent(target, container.id, draft, options);
    } catch (error) {
      if (!isRouteUnknown(error)) throw error;
      const file = await agent.readComposeFile(target, container.id, options);
      return dryRunFromLocalPreview(file, draft);
    }
  }

  /**
   * Anwenden über den Strom — und über den synchronen Weg, wenn der Arm zu alt
   * ist.
   *
   * ⚠️ DERSELBE RÜCKFALL WIE BEI DER VORSCHAU, aus demselben Grund: Arme unter
   * v0.22.0 kennen `compose-raw-stream` nicht. Nur eine `404` ohne benannten
   * Grund löst ihn aus — jeder andere Status und jeder Grund aus
   * `NOT_FOUND_ANSWERS` heißt, dass der Arm die Frage gehört und
   * beantwortet hat. Und wie dort ist er seit #130 (heute `MIN_AGENT_VERSION = "0.32.0"`)
   * unerreichbar und bleibt aus demselben Grund stehen.
   *
   * ⚠️ HIER HING DER BEFUND AUS #129. Ein `404 not-allowlisted` löste den
   * Rückfall aus, `{ kind: "start", live: false }` ging hinaus, der synchrone Weg
   * antwortete genauso — und ab der ersten Zeile ist kein Statuscode mehr zu
   * haben, also las die Fläche „Stand unbekannt" für einen Stack, den der Arm
   * nicht angefasst hat. Ohne Rückfall wirft dieser Aufruf, bevor eine Zeile
   * draußen ist, und die Route antwortet mit einem echten Status.
   *
   * ⚠️ DER RÜCKFALL MELDET KEINE SCHRITTE, UND ER ERFINDET AUCH KEINE. Der
   * synchrone Weg schweigt bis zum Ende; eine Anzeige, die dort trotzdem
   * fortschreitet, behauptete einen Verlauf, den niemand gemessen hat. Was der
   * Aufrufer bekommt, ist die `start`-Zeile mit `live: false` — damit er weiß,
   * dass es läuft UND dass keine Schritte folgen — und danach das Ergebnis.
   */
  async function applyStreaming(
    access: ContainerAccess,
    input: ComposeApplyInput,
    signal: AbortSignal,
    emit: (event: Record<string, unknown>) => Promise<void>,
    onFailure: (failure: { reason: string | null }) => void
  ): Promise<ComposeApplyResult> {
    const { target, container, options } = access;
    try {
      return await agent.applyComposeStreaming(target, container.id, input, {
        ...options,
        signal,
        onFailure,
        onStart: (start) => void emit({ kind: "start", ...start, live: true }),
        // ⚠️ ZURÜCKGEGEBEN: der Gegendruck des Browsers bremst damit das Lesen am
        // Arm (#131). Bei `onStart` ist es eine einzige Zeile und deshalb ohne
        // Wirkung — dort bleibt es beim `void`.
        onStep: (step) => emit({ kind: "step", step: step.step, detail: step.detail })
      });
    } catch (error) {
      if (!isRouteUnknown(error)) throw error;
      // ⚠️ `live: false` SAGT DER FLÄCHE, DASS KEINE SCHRITTE KOMMEN. Ohne diese
      // Angabe zeigte sie eine Schrittliste, in der für immer der erste Schritt
      // läuft — und das sähe aus wie ein Hänger und nicht wie ein alter Arm.
      void emit({ kind: "start", projectDir: "", composeFileName: "", stackName: input.stackName, live: false });
      return await agent.applyCompose(target, container.id, input, options);
    }
  }

  /**
   * Applies and reports, once the plan has passed every check that costs
   * nothing. What this writes into the stream is the envelope of the hub:
   * `start`, `step`, then `result` or `question`, or `error`.
   */
  async function applyAndReport(
    access: ContainerAccess,
    draft: { content: string; expectedComposeHash: string; fields: Record<string, unknown> },
    stream: ComposeStream
  ): Promise<void> {
    // Whether a line is out. The status is given with the first one, and from
    // there a failure can only be a line (`ndjsonWriter` begins on the first
    // write).
    let wrote = false;
    const emit = (event: Record<string, unknown>): Promise<void> => {
      wrote = true;
      return stream.write(event);
    };
    // Die `error`-Zeile des Agenten, wenn eine kam — ihr Grund geht
    // wörtlich an den Browser (#176). `null` heißt: keine Zeile. In einer
    // Hülle, weil der Rückruf sie setzt und tsc eine Zuweisung darin nicht
    // sieht — ein bloßes `let` bliebe für ihn im `catch` für immer `null`.
    const agentFailure: { current: { reason: string | null } | null } = { current: null };

    try {
      const file = await agent.readComposeFile(access.target, access.container.id, access.options);
      const input: ComposeApplyInput = {
        content: draft.content,
        expectedComposeHash: draft.expectedComposeHash,
        // Aus dem Leseaufruf und nie aus dem Rumpf — siehe `planApply`.
        stackName: file.stackName,
        confirmNew: listField(draft.fields.confirmNew),
        confirmRemoved: listField(draft.fields.confirmRemoved),
        acknowledgeImagePull: listField(draft.fields.acknowledgeImagePull),
        acknowledgeHardening: listField(draft.fields.acknowledgeHardening)
      };

      // ⚠️ EIN ABBRUCH BEENDET DAS ANWENDEN NICHT, und das ist der wichtigste
      // Unterschied zum Log-Strom. Der Agent lässt jede Meldung durch
      // `reportedTo()` laufen, damit ein Zuhörer, der geht, den Vorgang nicht
      // kippt: zwischen dem Schreiben der Datei und dem `up` läge sonst ein
      // Zustand, aus dem nur er selbst herausfindet. Wer hier zumacht, hört
      // auf zuzusehen — er hält nichts an. (`stream.signal` hängt am `close`
      // der Antwort und nicht der Anfrage: `relayAgentStream` sagt, warum.)
      const result = await applyStreaming(
        access,
        input,
        stream.signal,
        emit,
        (failure) => (agentFailure.current = failure)
      );

      if (result.ok) {
        // ⚠️ SOFORT UND NICHT ERST BEIM NÄCHSTEN TAKT. `compose up` erzeugt
        // neue Container-Ids, und `compose-raw` verankert die Allowlist des
        // Agenten — anders als `apply-spec` — nicht neu. Bis zum nächsten
        // Durchlauf stünden dort die Ids von vorher, und der eben
        // bearbeitete Stack antwortete auf jede weitere Aktion mit einer
        // Ablehnung, die wie ein Rechteproblem aussieht.
        //
        // ⚠️ ABGEWARTET UND VOR DER ERGEBNISZEILE. Die Oberfläche lädt nach
        // dem Anwenden neu; käme die Zeile vor dem Abgleich, sähe der
        // Betreiber genau den Zustand, den dieser Aufruf verhindern soll.
        const resynced = await resync(access.host, access.options.actor);
        await emit({ kind: "result", applied: result.body, resync: resynced });
        return;
      }

      // ⚠️ EINE FRAGE UND KEIN FEHLSCHLAG. Die Zeile trägt die Liste mit, die
      // der Aufrufer braucht, um sie zu beantworten; ein blanker Fehler ohne
      // sie machte aus einer beantwortbaren Frage eine Sackgasse.
      await emit({ kind: "question", question: result.question });
    } catch (error) {
      // Before the first line the route still has a status for it.
      if (!wrote) throw error;
      // The browser left: the connection the line would travel on is closed.
      if (stream.signal.aborted) return;
      // Zu spät für einen Statuscode. Der Ausgang steht jetzt im Strom —
      // und `error` heißt hier, was es beim Agenten heißt: der Stand des
      // Stacks ist UNBEKANNT. Die Fläche darf daraus kein „nicht
      // angewandt" machen.
      //
      // ⚠️ DER GRUND IST EIN WORT UND NIE `error.message` (#176). Kam die
      // Zeile vom Agenten, steht sein Grund darin, wörtlich und auch als
      // `null`. Kam keine — ein Strom ohne Abschlusszeile, ein abgerissener
      // Rumpf, ein Ausfall des synchronen Rückfalls nach der `start`-Zeile —,
      // schreibt der Hub sein eigenes Wort. Bis #176 stand hier der
      // Meldungstext der Ausnahme: ein deutscher Satz in dem Feld, in dem
      // sonst einer der Schlüssel des Agenten steht, und der Schlüssel,
      // den der Agent geschickt hatte, war darin verschwunden.
      await stream.write({
        kind: "error",
        reason: agentFailure.current === null ? HUB_STREAM_BROKEN : agentFailure.current.reason
      });
    }
  }

  return {
    read: async (ref) => {
      const opened = await deps.openContainer(ref, "reads");
      if (!opened.ok) return opened;
      const { access } = opened;
      const file = await asked(() => agent.readComposeFile(access.target, access.container.id, access.options));
      if (!file.ok) return { ...file, selectionSupported: selectionSupported(access) };
      return {
        ok: true,
        compose: {
          hubOwnStack: ownStack(access),
          externallyManaged: isExternallyManagedStack(access.container, access.containers),
          selectionSupported: selectionSupported(access),
          projectDir: file.value.projectDir,
          composeFileName: file.value.composeFileName,
          stackName: file.value.stackName,
          content: file.value.content,
          composeHash: file.value.composeHash,
          services: file.value.services,
          servicesInFile: file.value.servicesInFile,
          fileReadable: file.value.fileReadable,
          containerIds: file.value.containerIds,
          inventoryViolations: file.value.inventoryViolations
        }
      };
    },

    writeEnv: async (ref, body) => {
      const parsed = envWriteRequestSchema.safeParse(body);
      if (!parsed.success) return problem(400, "invalid-input", "Ungültige Umgebungsänderung.");
      const opened = await deps.openContainer(ref, "writes");
      if (!opened.ok) return opened;
      const { access } = opened;
      if (ownStack(access)) return problem(403, "hub-own-stack", "Die Umgebung des Hub-Stacks bleibt gesperrt.");
      if (isExternallyManagedStack(access.container, access.containers)) return problem(403, "externally-managed", "Die Definition wird extern verwaltet.");
      const saved = await asked(() => (agent.writeProjectEnv ?? agentClient.writeProjectEnv)(access.target, access.container.id, parsed.data, access.options));
      return saved.ok ? { ok: true, hash: saved.value.hash } : saved;
    },
    readEnv: async (ref, plaintext) => {
      const opened = await deps.openContainer(ref, "reads");
      if (!opened.ok) return opened;
      const { access } = opened;
      if (ownStack(access)) {
        return problem(403, "hub-own-stack", "Die Umgebung des Hub-Stacks bleibt gesperrt.");
      }
      const env = await asked(() => agent.readProjectEnv(access.target, access.container.id, plaintext, access.options));
      return env.ok ? { ok: true, env: env.value } : env;
    },

    // ⚠️ DIE VORSCHAU IST EIN POST UND ÄNDERT NICHTS: für die Schreibsperre gegen
    // einen zu alten Agenten zählt sie als `reads` (`routes.ts` sagt, warum).
    preview: async (ref, body) => {
      const opened = await deps.openContainer(ref, "reads");
      if (!opened.ok) return opened;
      const { access } = opened;
      const managed = externallyManaged(access);
      if (managed) return managed;
      const draft = textField((body as Record<string, unknown> | undefined)?.content);
      const preview = await asked(() => dryRun(access, draft));
      return preview.ok ? { ok: true, preview: preview.value } : preview;
    },

    // ⚠️ DER HUB SETZT `confirmName` SELBST (`applyAndReport`), und dafür liest er
    // vor dem Schreiben den Stacknamen beim Agenten. Das kostet einen zweiten
    // Aufruf und ist der Punkt der Sache: der Mensch bestätigt, was er im Diff
    // gesehen hat, statt einen Namen abzutippen. Aus dem Rumpf genommen wäre der
    // Name eine Angabe des Browsers — und die Prüfung des Agenten prüfte dann,
    // ob der Browser sich selbst zustimmt.
    planApply: async (ref, body) => {
      const opened = await deps.openContainer(ref, "writes");
      if (!opened.ok) return opened;
      const { access } = opened;

      // ⚠️ DIE SCHRANKE GEGEN DEN EIGENEN STACK (#183), vor allem anderen und
      // vor dem Strom: danach wäre der Status vergeben. Die Fläche bietet den
      // Weg gar nicht erst an; diese Zeile hält auch den Aufruf ohne Fläche.
      if (ownStack(access)) {
        return problem(
          403,
          "hub-own-stack",
          "Das ist der Stack, in dem dieser Hub selbst läuft. Ihn von hier anzuwenden ersetzte den Hub mitten im Vorgang."
        );
      }
      // Before the stream as well; the agent refuses the same on its own (#56).
      const managed = externallyManaged(access);
      if (managed) return managed;
      const fields = (body ?? {}) as Record<string, unknown>;
      const content = textField(fields.content);
      const expectedComposeHash = textField(fields.expectedComposeHash);

      if (expectedComposeHash.length === 0) {
        // Der Hash ist die einzige Sicherung dagegen, den Stand eines anderen
        // zu überschreiben. Ohne ihn wird gar nicht erst gefragt.
        return problem(400, "compose-hash-missing", "Zum Anwenden gehört der Hash des Standes, auf dem bearbeitet wurde.");
      }

      // ⚠️ Die Grenze des Agenten, VOR dem Aufruf gemeldet — damit der
      // Betreiber eine Meldung bekommt statt eines Netzfehlers. Entschieden
      // wird sie trotzdem dort; das hier ist eine Warnung und keine zweite
      // Wahrheit. Sie zählt Bytes, weil er Bytes zählt.
      if (Buffer.byteLength(content, "utf8") > MAX_COMPOSE_BYTES) {
        return problem(413, "too-large", `Eine Compose-Datei darf höchstens ${MAX_COMPOSE_BYTES} Bytes tragen.`);
      }

      // ⚠️ AB HIER IST DIE ANTWORT EIN STROM. Die Kopfzeilen gehen erst
      // hinaus, wenn die erste Zeile geschrieben wird — alles, was DAVOR
      // entschieden wird (fehlender Hash, zu große Datei, Allowlist,
      // Kill-Switch), bleibt ein echter Statuscode. Das ist dieselbe Trennung,
      // die der Agent selbst zieht, und sie ist keine Geschmacksfrage: ein
      // Fehler, der nach den Kopfzeilen als Status geschickt wird, kommt beim
      // Browser nie an.
      return {
        ok: true,
        run: (stream) => applyAndReport(access, { content, expectedComposeHash, fields }, stream)
      };
    },

    candidates: async (ref) => {
      const opened = await openForSelection(ref);
      if (!opened.ok) return opened;
      const { access } = opened;
      const selection = await asked(() =>
        agent.readComposeCandidates(access.target, access.container.id, access.options)
      );
      return selection.ok ? { ok: true, selection: selection.value } : selection;
    },

    select: async (ref, body) => {
      const opened = await openForSelection(ref);
      if (!opened.ok) return opened;
      const { access } = opened;
      const filePath = textField((body as Record<string, unknown> | undefined)?.filePath);
      if (filePath.length === 0) {
        return problem(400, "compose-selection-missing", "Zum Festlegen gehört eine der angebotenen Dateien.");
      }
      const selected = await asked(() =>
        agent.selectComposeFile(access.target, access.container.id, filePath, access.options)
      );
      return selected.ok ? { ok: true, selectedFilePath: selected.value } : selected;
    },

    clearSelection: async (ref) => {
      const opened = await openForSelection(ref);
      if (!opened.ok) return opened;
      const { access } = opened;
      const cleared = await asked(() =>
        agent.clearComposeSelection(access.target, access.container.id, access.options)
      );
      return cleared.ok ? { ok: true, selectedFilePath: null } : cleared;
    }
  };
}
