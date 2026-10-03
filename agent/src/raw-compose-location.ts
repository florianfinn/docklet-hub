import {
  COMPOSE_FILE_NAME,
  composeContextFindingOf,
  locationFor,
  type ComposeContext,
  type ComposeContextReason
} from "./compose.js";
import { COMPOSE_CANDIDATE_NAMES } from "./compose-selection.js";
import type { RegistryCompose } from "./registry.js";
import type { RawLocation } from "./raw-apply.js";

export type RawComposeLocationResult =
  | { ok: true; location: RawLocation }
  | { ok: false; reason: ComposeContextReason; projectDir: string | null }
  | { ok: false; reason: "name-not-usable-as-directory"; projectDir: null };

export function rawComposeLocation(
  containerName: string,
  registryCompose: RegistryCompose | undefined,
  labels: Record<string, string> | undefined,
  selected: ComposeContext | null,
  basePath: string,
  fileExists: (projectDir: string, fileName: string) => boolean
): RawComposeLocationResult {
  if (selected) {
    return { ok: true, location: {
      projectDir: selected.projectDir,
      composeFileName: selected.composeFileName,
      projectName: selected.project
    } };
  }
  const finding = composeContextFindingOf(labels, basePath);
  const hasComposeLabels = Object.keys(labels ?? {}).some((key) => key.startsWith("com.docker.compose."));
  // Ein vorhandener Compose-Anker darf nicht durch einen aus dem Namen
  // geratenen Pfad ersetzt werden: genau das verdeckte den Grund in #102.
  if (!finding.ok && hasComposeLabels) {
    return { ok: false, reason: finding.reason, projectDir: finding.projectDir };
  }
  if (registryCompose) {
    return { ok: true, location: {
      projectDir: registryCompose.projectDir,
      composeFileName: registryCompose.composeFileName,
      projectName: registryCompose.projectName
    } };
  }
  if (finding.ok) {
    return { ok: true, location: {
      projectDir: finding.context.projectDir,
      composeFileName: finding.context.composeFileName,
      projectName: finding.context.project
    } };
  }
  const own = locationFor(containerName, basePath);
  if (!own) return { ok: false, reason: "name-not-usable-as-directory", projectDir: null };
  const existing = COMPOSE_CANDIDATE_NAMES.find((name) => fileExists(own.projectDir, name));
  return { ok: true, location: {
    projectDir: own.projectDir,
    composeFileName: existing ?? COMPOSE_FILE_NAME,
    projectName: containerName
  } };
}
