import type { ComposeSelectionRequest } from "contract";

import { agentDelete, agentGet, agentPut, type AgentTarget } from "../../platform/agent-transport/protocol.js";
import type { ComposeRequestOptions } from "./types.js";
import { asRecord, asText, asTextList } from "./wire-readers.js";

// The client for the compose selection by hand (#185): read the candidates,
// pick one, clear the pick. Ported from `agent/compose-selection.ts` of the old
// layout (branch `claude/compose-selection`, base 6c3409a).
//
// ⚠️ THE SELECTION LIVES IN THE AGENT AND NOT IN THE HUB. The agent never takes
// a project directory from a request (security review 5c, finding 4). A
// selection the hub stored and sent along with every call would be exactly
// such a request path. The hub therefore only hands on the operator's CHOICE,
// once, and the agent checks it against its own candidate list
// (`agent/src/compose-selection.ts`, `handleComposeCandidates` in
// `agent/src/routes/compose-routes.ts`).
//
// ⚠️ A PATH FROM THE LIST AND NEVER A FREE ONE. On `PUT` the agent accepts only
// a path it offered itself and answers `400 invalid-compose-candidate`
// otherwise. There is no text field on either side.
//
// ⚠️ THE ROUTE VARIABLES HAVE DIFFERENT NAMES (`candidatesRoute`,
// `selectRoute`, `clearRoute`): the error text of `asRecord` names the path,
// and one shared name would invite reusing the wrong one.

/** A file the agent offers as the selection. */
export type ComposeCandidate = {
  filePath: string;
  projectDir: string;
  composeFileName: string;
  /** `label`: from `config_files` of the container; `base`: in the project directory below the base path. */
  source: "label" | "base";
};

/** What `GET /containers/:id/compose-candidates` says about a container. */
export type ComposeCandidates = {
  /** The anchor from the labels. `reason` is the agent's key, verbatim (`compose-anchor-…`). */
  anchor: { ok: true; projectDir: string } | { ok: false; reason: string; projectDir: string | null };
  /** The selection in force, or `null`. Only a path that still stands in `candidates`. */
  selectedFilePath: string | null;
  /**
   * Every file from `com.docker.compose.project.config_files`, also those
   * outside the base path — for the warning about more than one file.
   */
  labelFilePaths: string[];
  candidates: ComposeCandidate[];
};

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseCandidate(value: unknown): ComposeCandidate | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  const filePath = asText(entry.filePath);
  if (filePath.length === 0) return null;
  return {
    filePath,
    projectDir: asText(entry.projectDir),
    composeFileName: asText(entry.composeFileName),
    source: entry.source === "label" ? "label" : "base"
  };
}

function parseAnchor(value: unknown): ComposeCandidates["anchor"] {
  const anchor = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  if (anchor.ok === true) return { ok: true, projectDir: asText(anchor.projectDir) };
  return { ok: false, reason: asText(anchor.reason), projectDir: nullableText(anchor.projectDir) };
}

/** The candidates of a container — reading, with an audit entry at the agent. */
export async function readComposeCandidates(
  target: AgentTarget,
  containerId: string,
  options: ComposeRequestOptions
): Promise<ComposeCandidates> {
  const candidatesRoute = `/containers/${encodeURIComponent(containerId)}/compose-candidates`;
  const answer = asRecord(await agentGet(target, candidatesRoute, options), candidatesRoute);
  const candidates = Array.isArray(answer.candidates)
    ? answer.candidates.map(parseCandidate).filter((entry): entry is ComposeCandidate => entry !== null)
    : [];
  return {
    anchor: parseAnchor(answer.composeAnchor),
    selectedFilePath: nullableText(answer.selectedFilePath),
    labelFilePaths: asTextList(answer.labelFilePaths),
    candidates
  };
}

/** Sets the selection and returns the path the agent confirms. */
export async function selectComposeFile(
  target: AgentTarget,
  containerId: string,
  filePath: string,
  options: ComposeRequestOptions
): Promise<string | null> {
  const selectRoute = `/containers/${encodeURIComponent(containerId)}/compose-selection`;
  const payload: ComposeSelectionRequest = { filePath };
  const answer = asRecord(await agentPut(target, selectRoute, payload, options), selectRoute);
  return nullableText(answer.selectedFilePath);
}

/** Clears the selection. Without one, that is no error at the agent. */
export async function clearComposeSelection(
  target: AgentTarget,
  containerId: string,
  options: ComposeRequestOptions
): Promise<void> {
  const clearRoute = `/containers/${encodeURIComponent(containerId)}/compose-selection`;
  asRecord(await agentDelete(target, clearRoute, options), clearRoute);
}
