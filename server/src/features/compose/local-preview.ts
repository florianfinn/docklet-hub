import { parse } from "yaml";

import { MAX_COMPOSE_BYTES } from "contract";
import {
  COMPOSE_APPLY_STEPS,
  type ComposeBlocker,
  type ComposeDryRun,
  type ComposeFile,
  type ComposePreview,
  type ComposeUncertainty
} from "./types.js";

// The hub's OWN calculation of a draft — no network, no agent (moved here from
// `agent/compose.ts`, #264). It is the fallback of the dry run for arms that do
// not know `compose-raw-preview` (`service.ts`, `dryRun`); the way it is
// reached is described there, the shape of its answer at `ComposeDryRun.source`
// in `types.ts`.

// ---------------------------------------------------------------------------
// Vorschau — reine Rechnung, kein Netz
// ---------------------------------------------------------------------------

/**
 * Was ein Entwurf bewirken würde.
 *
 * ⚠️ SIE WIRFT NIE. Ein kaputter Entwurf ist ein ERGEBNIS dieser Funktion und
 * kein Fehler: sie läuft, während jemand tippt, und ein geworfener Fehler
 * mitten im Tippen wäre eine Fläche, die beim Bearbeiten zusammenbricht.
 */
export function previewCompose(current: ComposeFile, draft: string): ComposePreview {
  const blockers = findBlockers(draft);
  const parsed = parseServices(draft);
  if (parsed.error !== null) {
    blockers.push({ reason: "invalid-yaml", detail: parsed.error });
  } else if (parsed.names.length === 0 && draft.trim().length > 0) {
    blockers.push({ reason: "no-services" });
  }

  // Gegen `current.services` und NICHT gegen `current.servicesInFile`.
  // Festlegung 1 im Kopf von `agent-client.ts` nennt den Grund.
  const before = new Set(current.services);
  const after = new Set(parsed.names);

  return {
    services: {
      remaining: [...after].filter((name) => before.has(name)).sort(),
      added: [...after].filter((name) => !before.has(name)).sort(),
      removed: [...before].filter((name) => !after.has(name)).sort()
    },
    existingViolations: [...current.inventoryViolations].sort(),
    steps: COMPOSE_APPLY_STEPS,
    uncertainties: findUncertainties(draft, parsed.names),
    blockers
  };
}

function findBlockers(draft: string): ComposeBlocker[] {
  const blockers: ComposeBlocker[] = [];
  if (draft.trim().length === 0) blockers.push({ reason: "empty" });

  // ⚠️ BYTES, NICHT ZEICHEN. Der Agent zählt `MAX_RAW_CONTENT_BYTES` in Bytes;
  // ein Kommentar mit Umlauten kostet zwei je Zeichen. Eine Prüfung über
  // `length` ließe eine Datei durch, die er ablehnt — und die Ablehnung käme
  // erst, nachdem der Betreiber seine Arbeit abgeschickt hat.
  const bytes = Buffer.byteLength(draft, "utf8");
  if (bytes > MAX_COMPOSE_BYTES) blockers.push({ reason: "too-large", bytes, limit: MAX_COMPOSE_BYTES });

  // Der Agent lehnt ein NUL-Byte ab (`src/compose-raw.ts`, `validateRawContent`).
  // Es entsteht nicht durch Tippen, sondern durch ein Werkzeug, das etwas
  // anderes geschrieben hat als Text.
  if (draft.includes("\u0000")) blockers.push({ reason: "control-character" });

  return blockers;
}

function parseServices(draft: string): { names: string[]; error: string | null } {
  if (draft.trim().length === 0) return { names: [], error: null };
  try {
    const document: unknown = parse(draft);
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      return { names: [], error: null };
    }
    const services = (document as Record<string, unknown>).services;
    if (typeof services !== "object" || services === null || Array.isArray(services)) {
      return { names: [], error: null };
    }
    return { names: Object.keys(services as Record<string, unknown>), error: null };
  } catch (error) {
    return { names: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function findUncertainties(draft: string, names: readonly string[]): ComposeUncertainty[] {
  const found: ComposeUncertainty[] = [];
  // Absichtlich am Text und nicht am Baum: ein Entwurf, der sich nicht parsen
  // ließ, soll trotzdem sagen können, warum die Schätzung unsicher wäre.
  if (/^\s*extends:/m.test(draft) || /\n\s+extends:/.test(draft)) found.push("extends");
  if (/^include:/m.test(draft)) found.push("include");
  if (/^\s+profiles:/m.test(draft)) found.push("profiles");
  if (names.some((name) => name.includes("${"))) found.push("interpolated-service-name");
  return found;
}

/**
 * Derselbe Umschlag aus der eigenen Rechnung — der Rückfall für alte Arme.
 *
 * ⚠️ ER FÜLLT KEIN FELD, DAS ER NICHT KENNT. `missingImages` bleibt `null`,
 * `imagesByService` leer, `configError` `null`. Die Versuchung, hier `[]` zu
 * schreiben, damit die Fläche „vollständig" aussieht, ist genau der Fehler:
 * eine Oberfläche, die aus „weiß ich nicht" ein „nichts" macht, beruhigt über
 * etwas, das niemand geprüft hat.
 */
export function dryRunFromLocalPreview(current: ComposeFile, draft: string): ComposeDryRun {
  const preview = previewCompose(current, draft);
  const blocker = preview.blockers[0];
  return {
    source: "hub",
    valid: preview.blockers.length === 0,
    // Die eigenen Gründe tragen die Namen der Gegenseite, wo es einen gibt —
    // damit die Fläche nicht zwei Vokabulare zeigen muss.
    reason: blocker === undefined ? null : localReason(blocker),
    errors: [],
    configError: null,
    services: preview.services.remaining.concat(preview.services.added).sort(),
    diff: {
      remaining: preview.services.remaining,
      new: preview.services.added,
      removed: preview.services.removed
    },
    imagesByService: {},
    missingImages: null,
    servicesWithoutImage: [],
    inventoryViolations: preview.existingViolations,
    composeHash: current.composeHash,
    stackName: current.stackName,
    currentServices: current.services,
    steps: preview.steps,
    uncertainties: preview.uncertainties
  };
}

/** Der Name der Gegenseite für einen selbst gefundenen Hinderungsgrund. */
function localReason(blocker: ComposeBlocker): string {
  switch (blocker.reason) {
    case "invalid-yaml":
      return "invalid-compose-file";
    case "no-services":
      return "no-services";
    // `empty`, `too-large` und `control-character` fängt der Agent unter
    // `invalid-content` (`validateRawContent`) — ein eigener Name hier wäre
    // ein Vokabular, das die Gegenseite nicht kennt.
    default:
      return "invalid-content";
  }
}
