// The calls of the feature `compose` (#265): the compose file of a stack, the
// dry run of a draft, the streamed apply and the `.env` of the project. Until
// #265 this was `web/src/api/compose.ts` and `web/src/api/env.ts`; a feature
// imports nothing from `web/src/api/`, so the calls moved along and share one
// file now. The guards read them here (`web/tests/client-files.mjs`,
// `featureApiFiles`). The reasons below are unchanged.
//
// Der Zugang der Oberfläche zur Compose-Fläche eines Stacks — Paket B5,
// Etappe E4 (#35).
//
// Warum eine eigene Datei neben `client.ts`: dieselbe Begründung wie bei
// `features/files/api.ts`. Die Sammeldatei liegt bei über 800 Zeilen und trägt die
// Marke aus `web/tests/source-file-size.test.mjs` (LIMIT 1000) sichtbar; die
// Compose-Fläche bringt vier Routen, acht Formen und einen Strom mit.
//
// The TRANSPORT is shared, not copied: `request` and `postJson` come from
// `../../platform/http/transport`, the line reader from `contract` (#252).
//
// ⚠️ DIE FORMEN SIND VON HAND GESPIEGELT, Vorlage ist
// `server/src/features/compose/types.ts`. Ein `import type` über die
// Bereichsgrenze wäre hier ausdrücklich falsch: jene Datei importiert den
// YAML-Parser und die Agentenanbindung als WERTE, und das Web zöge sich damit
// den halben Serverbereich in den Bundle-Graphen. Dass die Spiegelung nicht
// ausfranst, hält `web/tests/api-mirror.test.mjs` fest.
//
// ⚠️ HIER STEHT KEINE GRENZE DES AGENTEN. `MAX_COMPOSE_BYTES` ist ein Wert der
// Gegenseite und steht ausschließlich in `contract/src/agent/`;
// `web/tests/agent-protocol-values.test.mjs` wird rot, sobald einer davon ein zweites Mal
// deklariert wird — auch im Web. Diese Fläche prüft keine Größe selbst, sie
// zeigt den Fehler des Servers (`413 too-large`).
//
// ⚠️ THE VALUES OF THE STREAM ARE MIRRORED, NOT TRANSLATED. `reason`, `step`
// and the kinds `start`/`step`/`result`/`error`/`question` are English on
// both sides since #278. Whoever renames one here builds a surface that
// silently shows nothing: an unknown `kind` falls through.

import { isAbort, readNdjson, type MountSource } from "contract";
import { ApiError, postJson, putJson, readErrorDetail, request } from "../../platform/http/transport";

// ---------------------------------------------------------------------------
// Die Formen
// ---------------------------------------------------------------------------

/**
 * Die gelesene Compose-Datei eines Stacks.
 *
 * Gespiegelt aus `ComposeFile` in `server/src/features/compose/types.ts`.
 */
export type ComposeFile = {
  projectDir: string;
  composeFileName: string;
  /** Der Verzeichnisname. Der Server setzt ihn beim Schreiben als Bestätigung ein. */
  stackName: string;
  content: string;
  /**
   * ⚠️ ER GEHT BEIM ANWENDEN ZURÜCK und ist die einzige Sicherung dagegen, den
   * Stand eines anderen zu überschreiben. Wer ihn wegwirft und ohne ihn
   * absendet, bekommt `400 compose-hash-missing` — und das ist die gute
   * Fassung des Fehlers.
   */
  composeHash: string;
  /** Der IST-Zustand: Services MIT Container. */
  services: string[];
  /** Was die Datei nennt. Eine Abweichung ist Zustand, kein Fehler. */
  servicesInFile: string[];
  fileReadable: boolean;
  containerIds: Record<string, string>;
  /** Bestehende Härtungsbefunde, Form `"service:regel"`. */
  inventoryViolations: string[];
  /**
   * Eine Auskunft DES HUBS und nicht des Agenten (#183): dieser Stack ist der,
   * in dem der Hub selbst läuft. Die Anwende-Route lehnt ihn mit
   * `403 hub-own-stack` ab (`server/src/features/compose/hub-own-stack.ts`).
   */
  hubOwnStack: boolean;
  /**
   * Also the hub's word (#56): a service of this stack is externally managed.
   * Preview and apply answer `403 externally-managed`.
   */
  externallyManaged: boolean;
  /**
   * Also the hub's word (#185): the selection by hand is offered for this
   * container. Without it the surface does not offer it.
   */
  selectionSupported: boolean;
};

/** Der Service-Vergleich, wie der Agent ihn rechnet. */
export type ComposeServiceDiff = {
  remaining: string[];
  /**
   * ⚠️ HEISST AUF DER LEITUNG `new` UND WIRD NICHT UMBENANNT — das Feld gehört
   * der Gegenseite. Ein `added` hier wäre eine zweite Wahrheit, und der
   * Spiegel-Wächter fiele darüber.
   */
  new: string[];
  removed: string[];
};

/**
 * Was ein Entwurf bewirken würde.
 *
 * ⚠️ `source` IST DIE WICHTIGSTE ANGABE DIESER FORM und keine Zierde. Sie sagt,
 * WER gerechnet hat, und davon hängt ab, wie belastbar der Rest ist:
 * `agent` heißt, der Arm hat `docker compose config` wirklich ausgeführt —
 * `extends`, `include`, Profile und `${VAR}` sind aufgelöst. `hub` heißt, der
 * Arm ist älter als v0.21.0 und der Server hat mit seinem eigenen YAML-Parser
 * gerechnet; dann steht in `uncertainties`, wo er raten musste, und
 * `missingImages` ist `null`.
 */
export type ComposeDryRun = {
  source: "agent" | "hub";
  valid: boolean;
  /** Der Fehlerschlüssel des Agenten, wenn der Entwurf nicht bestünde. */
  reason: string | null;
  errors: string[];
  configError: string | null;
  services: string[] | null;
  diff: ComposeServiceDiff | null;
  imagesByService: Record<string, string>;
  /**
   * ⚠️ `null` HEISST „NICHT ERHOBEN" UND NICHT „KEINE FEHLEN". Wer die beiden
   * gleich behandelt, zeigt „nichts zu ziehen" für einen Entwurf, über den das
   * niemand weiß — und der Betreiber erfährt erst beim Anwenden, dass drei
   * Images gezogen werden müssen.
   */
  missingImages: string[] | null;
  servicesWithoutImage: string[];
  /** Was JETZT schon verletzt ist — nicht, was der Entwurf einführt. */
  inventoryViolations: string[];
  composeHash: string;
  stackName: string;
  currentServices: string[];
  steps: string[];
  uncertainties: string[];
};

/** Die Rückfragen, die der Agent stellt, statt zu schreiben. */
export type ComposeQuestion =
  | { kind: "services"; added: string[]; removed: string[] }
  | { kind: "images"; missing: string[] }
  // Only when creating a project (#3): bind sources outside its directory.
  | { kind: "external-sources"; sources: string[] }
  | { kind: "hardening"; newViolations: string[]; rolledBack: boolean }
  | { kind: "changed-elsewhere"; actualHash: string }
  | { kind: "start-failed"; detail: string; rolledBack: boolean }
  | { kind: "container-missing"; detail: string; rolledBack: boolean }
  | { kind: "invalid-draft"; detail: string }
  | { kind: "anchor-stale" }
  | { kind: "image-ref-unreadable"; ref: string };

/** Was beim Anwenden mitgeschickt wird. */
export type ComposeApplyInput = {
  content: string;
  expectedComposeHash: string;
  confirmNew: string[];
  confirmRemoved: string[];
  /**
   * ⚠️ DIE BILDLISTE BILDET DIESE FLÄCHE NICHT SELBST. Welche Images fehlen,
   * weiß nur der Arm; sie kommt aus `ComposeDryRun.missingImages` oder aus der
   * Rückfrage und geht unverändert wieder hinaus. Der Agent prüft auf GENAUE
   * Mengengleichheit — eine selbst zusammengestellte Liste wird abgelehnt.
   */
  acknowledgeImagePull: string[];
  acknowledgeHardening: string[];
};

/**
 * Der Anfang des Anwendens.
 *
 * ⚠️ `live: false` HEISST, DASS KEINE SCHRITTE FOLGEN — der Arm ist älter als
 * v0.22.0 und der Server nimmt den synchronen Weg. Eine Anzeige, die das
 * ignoriert, zeigt eine Schrittliste, in der für immer der erste Schritt
 * läuft, und das sieht aus wie ein Hänger.
 */
export type ComposeApplyStart = {
  projectDir: string;
  composeFileName: string;
  stackName: string;
  live: boolean;
};

/** Eine Schrittmeldung. `step` ist ein Wort des Agenten. */
export type ComposeApplyStep = { step: string; detail: string | null };

/**
 * Der Abgleich der Allowlist nach dem Anwenden. `status` ist ein Wort des Hubs
 * (`HostCycleStatus` oder `skipped`); `null`, wenn die Zeile keines trug
 * (#176).
 */
export type ComposeResync = { status: string | null; error: string | null };

/**
 * Wie das Anwenden ausging.
 *
 * ⚠️ DREI AUSGÄNGE UND NICHT ZWEI. `failed` heißt NICHT „nicht angewandt",
 * sondern dass der Stand des Stacks UNBEKANNT ist: der Strom endete ohne
 * Abschlusszeile oder mit einer Ausnahme. Wer daraus „ging nicht" macht,
 * schickt den Betreiber in einen zweiten Versuch gegen einen Hash, der
 * vielleicht nicht mehr stimmt.
 *
 * ⚠️ `detached` IST KEIN VIERTER AUSGANG DES ANWENDENS, sondern der des
 * Zuhörens: der Aufrufer hat sein eigenes Signal gezogen, bevor ein Ausgang
 * kam. Über den Stack sagt das nichts — das Anwenden läuft beim Agenten weiter
 * (siehe `applyCompose`). Bis #173 stand dafür `failed` mit dem Grund
 * `abgebrochen`, also ein Wort des Browsers in dem Feld, in dem sonst die
 * Schlüssel des Agenten ankommen (`COMPOSE_RAW_FAILURE_REASONS`).
 *
 * ⚠️ `reason: null` HEISST: KEIN GRUND STAND DA (#176) — die `error`-Zeile
 * trug keinen, oder der Strom endete ganz ohne Abschlusszeile. Bis #176 stand
 * in beiden Fällen `unbekannt`, ein Wort des Browsers im Feld des Agenten.
 */
export type ComposeApplyOutcome =
  | { kind: "applied"; applied: Record<string, unknown>; resync: ComposeResync }
  | { kind: "question"; question: ComposeQuestion }
  | { kind: "failed"; reason: string | null }
  | { kind: "detached" };

export type ComposeApplyOptions = {
  signal: AbortSignal;
  onOpen?: () => void;
  onStart?: (start: ComposeApplyStart) => void;
  onStep?: (step: ComposeApplyStep) => void;
};

// ---------------------------------------------------------------------------
// Die Aufrufe
// ---------------------------------------------------------------------------

// ⚠️ KEINE HILFSFUNKTION FÜR DEN GEMEINSAMEN PFADANFANG, und das ist keine
// Nachlässigkeit — es ist gemessen. `web/tests/api-mirror.test.mjs` liest die
// Adresse als ZEICHENKETTE UNMITTELBAR HINTER DEM AUFRUF; ein Pfad, den eine
// Funktion zusammensetzt, ist für ihn unsichtbar, und er meldet die Funktion
// als ungeprüft. Beim ersten Wurf dieser Datei stand hier ein `base(hostId,
// containerId)`, und genau das ist passiert.
//
// Die Wiederholung von drei Pfadanfängen ist der Preis dafür, dass jeder
// einzelne gegen den Router gehalten wird. Er ist niedriger als der einer
// Umbenennung, die niemand bemerkt.

/** Liest die Compose-Datei, aus der dieser Stack läuft. */
export async function fetchCompose(hostId: string, containerId: string): Promise<ComposeFile> {
  const answer = await request<{ compose: ComposeFile }>(
    `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/compose`
  );
  return answer.compose;
}

/** Fragt, was ein Entwurf bewirken würde — ohne etwas zu schreiben. */
export async function previewCompose(
  hostId: string,
  containerId: string,
  content: string
): Promise<ComposeDryRun> {
  const answer = await postJson<{ preview: ComposeDryRun }>(
    `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/compose/preview`,
    { content }
  );
  return answer.preview;
}

/**
 * Wendet einen Entwurf an und meldet jeden Schritt, während er läuft.
 *
 * ⚠️ EIN ROHER `fetch` UND KEIN `postJson`, und der Grund ist die Natur der
 * Antwort: sie ist ein NDJSON-Strom. `postJson` läse sie am Stück und gäbe sie
 * erst am Ende heraus — nach bis zu zehn Minuten, in denen die Fläche nichts
 * zu zeigen hätte. Genau dafür gibt es diesen Strom.
 *
 * ⚠️ DAS PFADLITERAL STEHT UNMITTELBAR ALS ERSTES ARGUMENT. Der zweite Leser
 * von `web/tests/api-mirror.test.mjs` findet einen rohen `fetch`-Aufruf nur
 * dann, wenn er seinen Pfad zusammenbekommt; eine Adresse aus einer Variablen,
 * die weiter oben entsteht, fiele stillschweigend aus der Prüfung.
 *
 * ⚠️ EIN ABBRUCH BEENDET DAS ANWENDEN NICHT. Der Agent lässt jede Meldung
 * durch eine Hülle laufen, damit ein Zuhörer, der geht, den Vorgang nicht
 * kippt. Wer diesen Strom schließt, hört auf zuzusehen — er hält nichts an,
 * und der Stack startet weiter neu.
 */
export async function applyCompose(
  hostId: string,
  containerId: string,
  input: ComposeApplyInput,
  options: ComposeApplyOptions
): Promise<ComposeApplyOutcome> {
  let response: Response;
  try {
    response = await fetch(
      `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/compose`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: options.signal
      }
    );
  } catch (error) {
    if (isAbort(options.signal, error)) return { kind: "detached" };
    throw error;
  }

  // ⚠️ VOR DEN KOPFZEILEN IST EIN FEHLER NOCH EIN STATUS. Fehlender Hash,
  // zu große Datei, fehlende Rechte, abgeschalteter Arm — die entscheidet der
  // Server, bevor der Strom steht, und sie kommen als `ApiError` heraus. Alles
  // danach steht im Strom.
  if (!response.ok) throw new ApiError(response.status, await readErrorDetail(response));
  const body = response.body;
  if (!body) throw new ApiError(response.status, "Die Antwort auf das Anwenden trug keinen Rumpf.");
  options.onOpen?.();

  let outcome: ComposeApplyOutcome | null = null;

  await readNdjson(body, { signal: options.signal }, (record) => {
    switch (record.kind) {
      case "start":
        options.onStart?.({
          projectDir: text(record.projectDir),
          composeFileName: text(record.composeFileName),
          stackName: text(record.stackName),
          // Fehlt die Angabe, ist der Strom der neue Weg — nur der Rückfall
          // schickt sie ausdrücklich als `false`.
          live: record.live !== false
        });
        return;
      case "step":
        options.onStep?.({
          step: text(record.step),
          detail: typeof record.detail === "string" ? record.detail : null
        });
        return;
      case "result":
        outcome = {
          kind: "applied",
          applied: object(record.applied),
          resync: {
            status: textOrNull(object(record.resync).status),
            error: typeof object(record.resync).error === "string" ? String(object(record.resync).error) : null
          }
        };
        return;
      case "question":
        outcome = { kind: "question", question: object(record.question) as unknown as ComposeQuestion };
        return;
      case "error":
        outcome = { kind: "failed", reason: textOrNull(record.reason) };
        return;
      default:
        return;
    }
  });

  // ⚠️ KEIN AUSGANG IST KEIN ERFOLG. Ein Strom, der ohne Abschlusszeile endet,
  // sagt NICHTS über den Stand des Stacks — und ihn still als „fertig" zu
  // behandeln ist die gefährlichste Auslegung von allen: die Datei kann
  // geschrieben und der Stack halb gestartet sein.
  //
  // ⚠️ AUSSER DER AUFRUFER HAT SELBST AUFGEHÖRT ZUZUHÖREN. `readNdjson` kehrt
  // nach einem Abbruch still zurück; dann fehlt der Ausgang, weil niemand mehr
  // gelesen hat, und nicht, weil der Strom ohne ihn endete. Derselbe Fall wie
  // der Abbruch vor den Kopfzeilen oben.
  if (outcome === null && options.signal.aborted) return { kind: "detached" };
  return outcome ?? { kind: "failed", reason: null };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Ein Wort der Gegenseite, oder `null`, wo keines stand (#176). */
function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The compose selection by hand (#185)
// ---------------------------------------------------------------------------

/** A file the arm offers as the selection. */
export type ComposeCandidate = {
  filePath: string;
  projectDir: string;
  composeFileName: string;
  /** `label`: from the compose labels of the container; `base`: in the project directory below the base path. */
  source: "label" | "base";
};

/** Mirrored from `ComposeCandidates` in `server/src/features/compose/selection-client.ts`. */
export type ComposeCandidates = {
  /** `reason` is the agent's key, verbatim (`compose-anchor-…`). */
  anchor: { ok: true; projectDir: string } | { ok: false; reason: string; projectDir: string | null };
  selectedFilePath: string | null;
  /** Every file from the labels — more than one means the configuration is an overlay. */
  labelFilePaths: string[];
  candidates: ComposeCandidate[];
};

/**
 * The files the arm offers for one container.
 *
 * ⚠️ EVERY CALL WRITES AN AUDIT ENTRY AT THE ARM (`compose-candidates`); the
 * surface asks only once the selection is open.
 */
export async function fetchComposeCandidates(hostId: string, containerId: string): Promise<ComposeCandidates> {
  const answer = await request<{ selection: ComposeCandidates }>(
    `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/compose/candidates`
  );
  return answer.selection;
}

/** Sets one of the offered files; the arm accepts no other path. */
export async function selectComposeFile(hostId: string, containerId: string, filePath: string): Promise<void> {
  await putJson<{ selectedFilePath: string | null }>(
    `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/compose/selection`,
    { filePath }
  );
}

/** Clears the selection; without one, that is no error. */
export async function clearComposeSelection(hostId: string, containerId: string): Promise<void> {
  await request<{ selectedFilePath: null }>(
    `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/compose/selection`,
    { method: "DELETE" }
  );
}

// ---------------------------------------------------------------------------
// Die `.env` des Projekts
// ---------------------------------------------------------------------------

// Die Antwort enthält nur Einträge aus der Projekt-`.env`.
// Klartext wird ausschließlich nach einer eigenen Aktion angefordert.
export type ProjectEnv = {
  projectDir: string;
  composeFileName: string;
  filePresent: boolean;
  plaintext: boolean;
  entries: Array<{ key: string; inFile: boolean; empty: boolean; value?: string }>;
};

// ⚠️ ZWEI LITERALE UND KEINE ZUSAMMENGESETZTE ADRESSE: der Wächter
// `web/tests/api-mirror.test.mjs` liest den Pfad unmittelbar hinter dem Aufruf
// (siehe oben); `?plaintext=1` schneidet er am `?` ab.
export async function fetchProjectEnv(
  hostId: string,
  containerId: string,
  plaintext = false
): Promise<ProjectEnv> {
  const answer = plaintext
    ? await request<{ env: ProjectEnv }>(
        `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/compose/env?plaintext=1`
      )
    : await request<{ env: ProjectEnv }>(
        `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/compose/env`
      );
  return answer.env;
}

// ---------------------------------------------------------------------------
// Neues Projekt (#3)
// ---------------------------------------------------------------------------

// The calls for a new hub-owned project (#3): the dry run and the create on a
// host. The shapes mirror `server/src/features/compose/project-client.ts` and
// `project-service.ts`; web and server share no code.

export type ProjectPreview = {
  projectDir: string;
  stackName: string;
  valid: boolean;
  reason: string | null;
  errors: string[];
  configError: string | null;
  services: string[] | null;
  imagesByService: Record<string, string>;
  /** `null` is "not surveyed", not "none missing". */
  missingImages: string[] | null;
  servicesWithoutImage: string[];
  mountSources: MountSource[];
  externalSources: string[];
};

export type ProjectCreateInput = {
  name: string;
  content: string;
  confirmNew: string[];
  acknowledgeImagePull: string[];
  acknowledgeHardening: string[];
  confirmExternalSources: string[];
};

export type ProjectCreateOutcome =
  | { kind: "created"; project: Record<string, unknown>; resync: ComposeResync }
  | { kind: "question"; question: ComposeQuestion; projectDirRemoved: boolean | null };

export async function previewProject(hostId: string, name: string, content: string): Promise<ProjectPreview> {
  const answer = await postJson<{ preview: ProjectPreview }>(
    `/api/hosts/${encodeURIComponent(hostId)}/projects/preview`,
    { name, content }
  );
  return answer.preview;
}

/** Answers synchronously; the agent may pull, start and roll back first. */
export async function createProject(hostId: string, input: ProjectCreateInput): Promise<ProjectCreateOutcome> {
  const answer = await postJson<{ outcome: ProjectCreateOutcome }>(
    `/api/hosts/${encodeURIComponent(hostId)}/projects`,
    input
  );
  return answer.outcome;
}

/** The agent's cleanup flag next to a refused create, or `null`. */
export function projectDirRemovedOf(error: unknown): boolean | null {
  if (!(error instanceof ApiError)) return null;
  try {
    const parsed = JSON.parse(error.message) as { projectDirRemoved?: unknown };
    return typeof parsed.projectDirRemoved === "boolean" ? parsed.projectDirRemoved : null;
  } catch {
    return null;
  }
}
