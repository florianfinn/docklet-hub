import { composeContextOf, type ComposeContext } from "./compose.js";
import { EnvRedactionUnavailableError } from "./env-file.js";
import type { RegistryEntry } from "./registry.js";

function hasComposeLabels(labels: Record<string, string> | undefined): boolean {
  return Object.keys(labels ?? {}).some((key) => key.startsWith("com.docker.compose."));
}

// The live labels identify what Docker started, but the Agent registry is the
// authorization anchor. A log request may use the project directory only when
// both independent views agree exactly. This prevents adopted/docker-run
// containers with spoofed Compose labels from selecting another project's
// `.env` or configured file-log root.
//
// ⚠️ The labels are NOT a trustworthy source on their own: `Config.Labels`
// also contains the labels of the IMAGE. A foreign image can claim
// `com.docker.compose.project.working_dir` in them and thereby point the agent
// at an arbitrary project directory. That is why only what the registry
// anchor confirms counts.
//
// ⚠️ Without confirmation the answer is `null` — "no project `.env`" —, NOT
// an error. Until the live finding on 2026-08-05 this was different and made
// the log view unusable for 8 of 10 managed containers (503
// `redaction-unavailable`): being allowlisted AND adopted is the exception in
// the existing inventory, not the rule.
//
// The distinction that had been lost along the way — it is the same lesson
// as in S8/S9, only the other way round:
//
//   * For REDACTION the directory is only the source of additional search
//     terms. The values from the `.env` never leave the agent, they are used
//     exclusively as needles in `redactKnownSecrets()`. Having no directory
//     therefore means: less gets replaced (the container env stays fully
//     redacted) — not: something leaks.
//   * For READING a log file (S8) the same directory is the root of a file
//     access. There an unconfirmed directory is a read primitive into a
//     foreign project, and that is why it stays fail-closed there — see
//     requiredComposeContextForFileLogs below.
//
// A failure of the redaction would thus be the more expensive path to the
// WORSE result: no log instead of a log whose redaction reaches exactly as far
// as the reliable information.
export function verifiedComposeContextForLogs(
  entry: RegistryEntry | null,
  labels: Record<string, string> | undefined,
  basePath: string
): ComposeContext | null {
  // A genuinely non-Compose registry entry needs no project `.env`.
  if (!entry?.compose && !hasComposeLabels(labels)) return null;

  const live = composeContextOf(labels, basePath);
  const anchor = entry?.compose;
  if (
    !live ||
    !anchor?.projectName ||
    live.projectDir !== anchor.projectDir ||
    live.project !== anchor.projectName ||
    live.serviceName !== anchor.serviceName ||
    live.composeFileName !== anchor.composeFileName
  ) {
    return null;
  }
  return live;
}

// ⚠️ Here it stays fail-closed, and unchanged: the directory is the root
// against which the file path named by the caller is checked (S8, §20.2). An
// unconfirmed directory would not be "less redacted" here, but a read
// primitive into a foreign project.
export function requiredComposeContextForFileLogs(
  entry: RegistryEntry | null,
  labels: Record<string, string> | undefined,
  basePath: string
): ComposeContext {
  const context = verifiedComposeContextForLogs(entry, labels, basePath);
  if (!context) throw new EnvRedactionUnavailableError();
  return context;
}
