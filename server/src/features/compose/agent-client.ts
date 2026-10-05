// Der Client für die zwei Routen der Compose-Fläche — lesen und anwenden.
//
// ── WAS HIER STEHT ──────────────────────────────────────────────────────────
//
// One function per route. The preview as a PURE calculation without network
// is `local-preview.ts`, the shapes are `types.ts`. The shapes were MEASURED
// against the agent (v0.24.0), not copied from
// `docs/design/phase-5-write-access.md`; the draft was off in three places,
// named at the types.
//
// ── FÜNF FESTLEGUNGEN, DIE HIER UND NICHT ANDERSWO STEHEN ───────────────────
//
// 1. DER IST-ZUSTAND SIND DIE CONTAINER, NICHT DIE DATEI.
//    `ComposeFile.services` nennt die Services, zu denen es einen Container
//    gibt; `servicesInFile` nennt, was die Datei sagt. Die Bestätigungsrechnung
//    läuft gegen die ERSTE Liste. Der Agent begründet das ausdrücklich
//    (`src/index.ts:6112`): `docker compose up` erzeugt jeden Service der
//    Datei, auch einen, zu dem es bisher keinen Container gibt. Rechnete man
//    gegen `servicesInFile`, wäre so ein Service weder neu noch
//    bestätigungspflichtig — und es entstünde ein Container, über dessen
//    Rechte nie jemand entschieden hat.
//
// 2. THREE CONFIRMATIONS ARE STRICT, ONE IS LENIENT.
//    `confirmNew`, `confirmRemoved` and `acknowledgeImagePull` go through the
//    agent's `checkConfirmation` (agent/src/compose-raw.ts, called from
//    agent/src/runtime/raw-ops.ts) and need exact set equality: an unknown
//    name invalidates the confirmation like a missing one.
//    `acknowledgeHardening` only needs to contain every new finding; extra
//    entries do not matter (`executeRawApply` in agent/src/raw-apply.ts).
//    The difference is intended and mirrored here, not smoothed over.
//
//    ⚠️ `acknowledgeImagePull` ist deshalb KEINE Quittung, sondern eine LISTE
//    von Bildnamen — und der Hub kann sie nicht selbst bilden. Welche Images
//    auf dem Host fehlen, weiß nur der Agent. Sie kommt aus seinem `409`
//    zurück und geht unverändert wieder hinaus.
//
// 3. DAS ANWENDEN BRINGT SEINE EIGENE FRIST MIT.
//    Die Vorgabe des Hubs sind 10 s (`protocol.ts`, `DEFAULT_TIMEOUT_MS`), der
//    Agent darf für `docker compose up` 300 s brauchen (`src/compose-cli.ts:216`)
//    und für einen Rollback noch einmal so lange. Ohne eigene Frist bräche der
//    Hub JEDEN Anwendungsversuch ab — und zwar, während der Agent weiterläuft
//    und die Datei schreibt. Der Leseaufruf behält die Vorgabe.
//
// 4. DIE GRENZEN DES AGENTEN WERDEN NICHT NACHGEBAUT.
//    `MAX_COMPOSE_BYTES` steht in der Vertragsdatei und wird von hier
//    EXPORTIERT, damit ein Aufrufer dem Betreiber früh etwas sagen kann.
//    Entschieden wird beim Agenten. Eine eigene Schranke wäre die zweite
//    Wahrheit über eine fremde Grenze — die eine, die still falsch wird,
//    sobald der Agent seine ändert.
//
// 5. DIE VORSCHAU IST EINE NÄHERUNG UND SAGT DAS.
//    Der Agent rechnet seinen Diff aus `docker compose config` und löst dabei
//    `extends`, `include` und Profile auf. `previewCompose` hat nur einen
//    YAML-Parser. Wo der Unterschied die SERVICE-MENGE betreffen kann, trägt
//    die Vorschau eine Unsicherheitsmarke — und die Fläche kann sagen, dass
//    sie schätzt, statt eine Genauigkeit zu behaupten, die sie nicht hat. Der
//    Vorgang für einen echten Trockenlauf beim Agenten ist
//    `dashboard-docker-agent#85`.
//
// ── WAS DIE VORSCHAU NICHT KANN ─────────────────────────────────────────────
//
// Neue Härtungsverstöße. Der Agent misst sie an den LAUFENDEN Containern nach
// dem `up` und rollt bei fehlender Bestätigung zurück (`src/raw-apply.ts:244`).
// Sie entstehen also erst, nachdem geschrieben wurde. Ein Feld dafür gibt es
// hier bewusst nicht: eine Vorschau, die sie verspräche, müsste den Stack
// starten. Was sie zeigen kann, sind die BESTEHENDEN Befunde aus
// `inventoryViolations`.

import { composeApplyStreamLineSchema, MAX_COMPOSE_BYTES, readNdjson } from "contract";
import {
  AgentError,
  agentGet,
  agentPost,
  agentStreamPost,
  streamBodyOf,
  type AgentTarget
} from "../../platform/agent-transport/protocol.js";
import { parseStreamLine } from "../../platform/agent-transport/stream-lines.js";
import { watchStreamRejection } from "../../platform/agent-transport/stream-rejection.js";
import { composeQuestionOf } from "./reasons.js";
import {
  COMPOSE_APPLY_STEPS,
  type ComposeApplyInput,
  type ComposeApplyResult,
  type ComposeDryRun,
  type ComposeFile,
  type ComposeRequestOptions,
  type ComposeStreamOptions,
  type ProjectEnv
} from "./types.js";
import { asFlag, asRecord, asText, asTextList, asTextMap } from "./wire-readers.js";

export { MAX_COMPOSE_BYTES };

// ---------------------------------------------------------------------------
// Die eigene Frist
// ---------------------------------------------------------------------------

/**
 * Wie lange der Hub auf ein Anwenden wartet.
 *
 * Gerechnet und nicht gegriffen: 300 s für `docker compose up`
 * (`src/compose-cli.ts:216`) plus 300 s für den Rollback, der `up` und `down`
 * mit denselben Fristen noch einmal fährt (`src/raw-apply.ts:216-225`), plus
 * 60 s Rand für das Ziehen der Images davor, das keine eigene Frist hat.
 *
 * ⚠️ ZU KNAPP IST SCHLIMMER ALS ZU GROSSZÜGIG. Läuft diese Frist ab, bricht
 * der Hub die Verbindung ab — der Agent arbeitet weiter, schreibt die Datei
 * und startet den Stack. Der Betreiber sähe einen Fehler und einen Host, der
 * sich trotzdem geändert hat.
 */
export const COMPOSE_APPLY_TIMEOUT_MS = 660_000;

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

/**
 * The three path constants of this file carry distinct names, one per route,
 * so a reader sees at the call which route it is.
 */
export async function readComposeFile(
  target: AgentTarget,
  containerId: string,
  options: ComposeRequestOptions
): Promise<ComposeFile> {
  const readRoute = `/containers/${encodeURIComponent(containerId)}/compose-raw`;
  const answer = asRecord(await agentGet(target, readRoute, options), readRoute);
  return {
    projectDir: asText(answer.projectDir),
    composeFileName: asText(answer.composeFileName),
    stackName: asText(answer.stackName),
    content: asText(answer.content),
    composeHash: asText(answer.composeHash),
    services: asTextList(answer.services),
    servicesInFile: asTextList(answer.servicesInFile),
    fileReadable: asFlag(answer.fileReadable),
    containerIds: asTextMap(answer.containerIds),
    inventoryViolations: asTextList(answer.inventoryViolations)
  };
}

// ---------------------------------------------------------------------------
// Anwenden
// ---------------------------------------------------------------------------

export async function applyCompose(
  target: AgentTarget,
  containerId: string,
  input: ComposeApplyInput,
  options: ComposeRequestOptions
): Promise<ComposeApplyResult> {
  const applyRoute = `/containers/${encodeURIComponent(containerId)}/compose-raw`;
  try {
    const answer = await agentPost(
      target,
      applyRoute,
      // ⚠️ DERSELBE RUMPF WIE IM STROM, aus EINER Funktion. Zwei Abschriften
      // von sieben Feldern wären zwei Wahrheiten darüber, was der Hub schickt
      // — und ein Feld, das nur einer der beiden Wege mitsendet, fiele
      // niemandem auf: beide Wege laufen, nur einer davon anders.
      applyBody(input),
      // Die eigene Frist. Ohne sie bricht jeder Versuch ab — siehe Festlegung 3.
      { ...options, timeoutMs: options.timeoutMs ?? COMPOSE_APPLY_TIMEOUT_MS }
    );
    return { ok: true, body: asRecord(answer, applyRoute) };
  } catch (error) {
    if (!(error instanceof AgentError)) throw error;
    const question = composeQuestionOf(error);
    if (question === null) throw error;
    return { ok: false, question };
  }
}

/**
 * Wendet einen Entwurf an und meldet jeden Schritt, während er läuft.
 *
 * ⚠️ DAS ERGEBNIS IST DASSELBE WIE AUF DEM SYNCHRONEN WEG, und das ist keine
 * Hoffnung, sondern die Zusage des Agenten: die Abschlusszeile trägt in
 * `status` und `body` wortgleich, was `POST /containers/:id/compose-raw`
 * geliefert hätte — derselbe `executeRaw` dahinter, es gibt keine zweite
 * Stelle, an der eine Antwort entstünde. Deshalb läuft sie hier durch
 * DIESELBE `composeQuestionOf` wie dort. Eine eigene Auswertung wäre die zweite
 * Wahrheit, die es drüben nicht gibt.
 *
 * ⚠️ EIN ABBRUCH BEENDET DAS ANWENDEN NICHT. Der Agent lässt jede Meldung
 * durch `reportedTo()` laufen, damit ein Zuhörer, der geht, den Vorgang nicht
 * kippt (`src/raw-apply.ts:119`) — zwischen dem Schreiben der Datei und dem
 * `up` läge sonst ein Zustand, aus dem nur er selbst herausfindet. Wer den
 * Strom schließt und daraus „abgebrochen" liest, meldet einen Stack als
 * unverändert, der gerade neu startet.
 *
 * ⚠️ SIE WIRFT, WENN GAR KEINE ABSCHLUSSZEILE KAM. Ein Strom, der ohne
 * `result` endet, ist kein Erfolg und kein benannter Fehlschlag, sondern ein
 * unbekannter Ausgang — dasselbe wie `kind: "error"`. Ihn still als „fertig"
 * zu behandeln wäre die gefährlichste Auslegung von allen.
 */
export async function applyComposeStreaming(
  target: AgentTarget,
  containerId: string,
  input: ComposeApplyInput,
  options: ComposeStreamOptions
): Promise<ComposeApplyResult> {
  const streamRoute = `/containers/${encodeURIComponent(containerId)}/compose-raw-stream`;

  // ⚠️ DER FEHLERRUMPF EINER ABLEHNUNG WIRD NACHGEHOLT (#129), und daran hängt
  // eine Entscheidung und nicht nur eine Meldung: der Aufrufer fällt bei einer
  // `404` auf den synchronen Weg zurück, und ohne den Rumpf sieht ein
  // `404 not-allowlisted` des Arms genauso aus wie ein Arm unter v0.22.0, der
  // diese Route nicht kennt. Warum das nicht in `protocol.ts` steht, steht in
  // `stream-rejection.ts`.
  const watch = watchStreamRejection(options.fetchImpl);
  let response: Response;
  try {
    response = await agentStreamPost(target, streamRoute, applyBody(input), {
      ...options,
      fetchImpl: watch.fetchImpl
    });
  } catch (error) {
    throw await watch.withDetail(error);
  }

  const body = streamBodyOf(response, streamRoute);
  options.onOpen?.();

  let outcome: { status: number; body: Record<string, unknown> } | null = null;
  // ⚠️ ZWEI ANGABEN UND NICHT EINE: ob eine `error`-Zeile kam, und was in
  // ihr stand. Eine Zeile ohne Grund ist trotzdem ein Fehlschlag (#176).
  let failed = false;
  let failure: string | null = null;

  // Every line is checked against `composeApplyStreamLineSchema` (#272); one
  // that does not fit, or of an unknown kind, is dropped (`parseStreamLine`).
  await readNdjson(body, options, (record) => {
    const line = parseStreamLine(composeApplyStreamLineSchema, record);
    switch (line?.kind) {
      case "start":
        options.onStart?.({
          projectDir: line.projectDir,
          composeFileName: line.composeFileName,
          stackName: line.stackName
        });
        return;
      case "step":
        // Zurückgegeben und nicht nur gerufen — siehe `onStep`.
        return options.onStep?.({ step: line.step, detail: line.detail ?? null });
      case "result":
        outcome = { status: line.status, body: line.body };
        return;
      case "error":
        failed = true;
        failure = line.reason ?? null;
        options.onFailure?.({ reason: failure });
        return;
      default:
        return;
    }
  });

  if (failed) {
    throw new AgentError(
      `Der Anwende-Strom endete mit „${failure ?? "(ohne Grund)"}" — der Stand des Stacks ist unbekannt.`
    );
  }
  if (outcome === null) {
    throw new AgentError(`Der Anwende-Strom endete ohne Abschlusszeile — der Stand des Stacks ist unbekannt.`);
  }

  const result: { status: number; body: Record<string, unknown> } = outcome;
  if (result.status >= 200 && result.status < 300) return { ok: true, body: result.body };

  // ⚠️ THE SAME TRANSLATOR AS ON THE SYNCHRONOUS PATH. The detour through an
  // `AgentError` is not clumsiness: `composeQuestionOf` reads the error body
  // from `error.detail`, and both paths use the same function. Two readers of
  // the same keys (`COMPOSE_RAW_FAILURE_REASONS` in
  // `contract/src/agent/compose-reasons.ts`, counted there and only there,
  // #113) are two places that drift apart, and the second stays green.
  const question = composeQuestionOf(new AgentError("Der Agent hat den Entwurf abgelehnt.", result.status, { detail: result.body }));
  if (question === null) {
    throw new AgentError("Der Agent lehnte das Anwenden ab.", result.status, { detail: result.body });
  }
  return { ok: false, question };
}

/** Der Rumpf, den beide Anwende-Wege schicken — einmal geschrieben. */
function applyBody(input: ComposeApplyInput): Record<string, unknown> {
  return {
    content: input.content,
    expectedComposeHash: input.expectedComposeHash,
    // Der Hub setzt den Namen ein, den der Leseaufruf genannt hat. Die
    // Bestätigung des Menschen hängt am gezeigten Diff und nicht am Abtippen —
    // die Prüfung des Agenten bleibt unberührt, sie fragt, ob der Aufrufer
    // weiß, welchen Stack er bearbeitet.
    confirmName: input.stackName,
    confirmNew: [...input.confirmNew],
    confirmRemoved: [...input.confirmRemoved],
    acknowledgeImagePull: [...input.acknowledgeImagePull],
    acknowledgeHardening: [...input.acknowledgeHardening]
  };
}

/**
 * Fragt den Agenten, was der Entwurf bewirken würde — ohne zu schreiben.
 *
 * ⚠️ EIN UNTAUGLICHER ENTWURF IST HIER KEIN FEHLER, SONDERN DAS ERGEBNIS. Der
 * Agent antwortet `200` mit `valid: false`; ein Status außerhalb `200` heißt
 * immer, dass die Auskunft selbst nicht zu haben war. Diese Funktion wirft
 * deshalb nur im zweiten Fall — und der Aufrufer, der jeden Fehlschlag als
 * „Entwurf kaputt" zeigte, verwechselte einen abgelaufenen Anker mit einem
 * Tippfehler.
 *
 * ⚠️ SIE FÄLLT AUF DEN KILL-SWITCH. Ein Arm mit `DOCKER_AGENT_READ_ONLY`
 * antwortet `503`, obwohl nichts Bleibendes geschrieben würde: der Trockenlauf
 * legt den Entwurf als Datei ab, weil `docker compose config` ihn anders nicht
 * liest (`src/index.ts:6332`). Das ist gemessen und keine Vermutung.
 */
export async function previewComposeOnAgent(
  target: AgentTarget,
  containerId: string,
  content: string,
  options: ComposeRequestOptions
): Promise<ComposeDryRun> {
  const previewRoute = `/containers/${encodeURIComponent(containerId)}/compose-raw-preview`;
  const answer = asRecord(await agentPost(target, previewRoute, { content }, options), previewRoute);
  const rawDiff = answer.diff;
  return {
    source: "agent",
    valid: asFlag(answer.valid),
    reason: typeof answer.reason === "string" ? answer.reason : null,
    errors: asTextList(answer.errors),
    configError: typeof answer.configError === "string" ? answer.configError : null,
    services: Array.isArray(answer.services) ? asTextList(answer.services) : null,
    diff:
      typeof rawDiff === "object" && rawDiff !== null && !Array.isArray(rawDiff)
        ? {
            remaining: asTextList((rawDiff as Record<string, unknown>).remaining),
            new: asTextList((rawDiff as Record<string, unknown>).new),
            removed: asTextList((rawDiff as Record<string, unknown>).removed)
          }
        : null,
    imagesByService: asTextMap(answer.imagesByService),
    // ⚠️ `Array.isArray` und nicht `asTextList`: der Unterschied zwischen
    // „nicht erhoben" (`null`) und „keine fehlen" (`[]`) ist die ganze
    // Aussage dieses Feldes, und `asTextList` machte aus beidem `[]`.
    missingImages: Array.isArray(answer.missingImages) ? asTextList(answer.missingImages) : null,
    servicesWithoutImage: asTextList(answer.servicesWithoutImage),
    inventoryViolations: asTextList(answer.inventoryViolations),
    composeHash: asText(answer.composeHash),
    stackName: asText(answer.stackName),
    currentServices: asTextList(answer.currentServices),
    steps: COMPOSE_APPLY_STEPS,
    uncertainties: []
  };
}

// ---------------------------------------------------------------------------
// Die Projekt-.env
// ---------------------------------------------------------------------------

// The project `.env` comes over the arm's internal route made for it (moved
// here from `agent/env.ts`, #264). The arm checks the compose anchor, every
// service and the self-management lock.
export async function readProjectEnv(
  target: AgentTarget,
  containerId: string,
  plaintext: boolean,
  options: ComposeRequestOptions
): Promise<ProjectEnv> {
  const readRoute = `/containers/${encodeURIComponent(containerId)}/env`;
  const answer = asRecord(await agentGet(target, readRoute + (plaintext ? "?plaintext=1" : ""), options), readRoute);
  const entries = Array.isArray(answer.entries) ? answer.entries : [];
  return {
    projectDir: asText(answer.projectDir),
    composeFileName: asText(answer.composeFileName),
    filePresent: answer.filePresent === true,
    plaintext: plaintext && answer.plaintext === true,
    entries: entries.flatMap((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return [];
      const item = entry as Record<string, unknown>;
      if (typeof item.key !== "string" || item.inFile !== true) return [];
      return [{
        key: item.key,
        inFile: true,
        empty: item.empty === true,
        ...(plaintext && answer.plaintext === true && typeof item.value === "string" ? { value: item.value } : {})
      }];
    })
  };
}
