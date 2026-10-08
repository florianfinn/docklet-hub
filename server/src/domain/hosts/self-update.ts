import type { AgentUpdateOffer, AgentUpdateState } from "contract";

import { agentGet, agentPost, AgentError, type AgentTarget, type RequestOptions } from "../../platform/agent-transport/protocol.js";
import { compareAgentReleaseVersions, compareAgentVersions, parseAgentVersion } from "./version.js";

// POST /self-update queues work for the watcher; acceptance does not mean
// completion. The hub supplies its release image as the explicit target.
// The watcher validates the image and persists the result across the swap.

// Minimum release whose image repository accepts the hub's explicit update target.
export const SELF_UPDATE_TARGET_MIN_VERSION = "0.32.0";

/**
 * Die Ausgänge des Watchers. Eine ZEICHENKETTE und keine Aufzählung, aus
 * demselben Grund wie `LogStreamFailure.reason` (AGENTS.md, Sprache): ein
 * sechster Wert der Gegenseite soll in der Oberfläche ankommen und nicht an
 * diesem Parser scheitern. Heute sind es `ok`, `unchanged`, `aborted`,
 * `rolled-back` und `failed`.
 */
export type SelfUpdateLastRun = {
  jobId: string;
  outcome: string;
  reason: string | null;
  fromVersion: string | null;
  toVersion: string | null;
  finishedAt: string | null;
};

export type SelfUpdateStatus = {
  running: boolean;
  version: string | null;
  last: SelfUpdateLastRun | null;
};

export type SelfUpdateAccepted = { jobId: string; imageRef: string };

// Unreadable or unsupported agents need the explicit image reference for a manual update.
export type { AgentUpdateOffer, AgentUpdateState };

// Preserve the release candidate in the tag; registry ports and digests are not version tags.
export function versionOfImageRef(imageRef: string): string | null {
  const withoutDigest = imageRef.split("@")[0];
  const lastSlash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.indexOf(":", lastSlash + 1);
  if (colon < 0) return null;
  const parsed = parseAgentVersion(withoutDigest.slice(colon + 1));
  if (!parsed) return null;
  const core = parsed.slice(0, 3).join(".");
  return parsed[3] === undefined ? core : `${core}-rc.${parsed[3]}`;
}

// An unreadable running version requires a manual update because target support is unknown.
export function agentUpdateOffer(agentVersion: string | null, targetImageRef: string): AgentUpdateOffer | null {
  const targetVersion = versionOfImageRef(targetImageRef);
  const target = parseAgentVersion(targetVersion);
  if (!targetVersion || !target) return null;
  const running = parseAgentVersion(agentVersion);
  if (running && compareAgentVersions(running, target) >= 0) {
    return { targetVersion, targetImageRef, state: "current" };
  }
  const minimum = parseAgentVersion(SELF_UPDATE_TARGET_MIN_VERSION);
  if (!minimum) throw new Error(`SELF_UPDATE_TARGET_MIN_VERSION ist keine Version: „${SELF_UPDATE_TARGET_MIN_VERSION}".`);
  // Target support is a release boundary; candidates of that release can already read the target.
  const readsTarget = running !== null && compareAgentReleaseVersions(running, minimum) >= 0;
  return { targetVersion, targetImageRef, state: readsTarget ? "available" : "manual" };
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentError(`${what} ist kein Objekt.`);
  }
  return value as Record<string, unknown>;
}

function optionalText(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

export function parseSelfUpdateAccepted(value: unknown): SelfUpdateAccepted {
  const record = asRecord(value, "Die Antwort auf POST /self-update");
  const jobId = optionalText(record, "jobId");
  const imageRef = optionalText(record, "imageRef");
  if (!jobId || !imageRef) {
    throw new AgentError("Die Antwort auf POST /self-update nennt keinen Auftrag.");
  }
  return { jobId, imageRef };
}

export function parseSelfUpdateStatus(value: unknown): SelfUpdateStatus {
  const record = asRecord(value, "Die Antwort auf GET /self-update");
  if (typeof record.running !== "boolean") {
    throw new AgentError("Die Antwort auf GET /self-update sagt nicht, ob ein Auftrag läuft.");
  }
  // `last` fehlt bei einem Arm, der noch nie getauscht hat. Eine Form, die
  // nicht passt, ist dasselbe wie keine: sie sagt nichts über einen Lauf.
  let last: SelfUpdateLastRun | null = null;
  if (typeof record.last === "object" && record.last !== null && !Array.isArray(record.last)) {
    const run = record.last as Record<string, unknown>;
    const jobId = optionalText(run, "jobId");
    const outcome = optionalText(run, "outcome");
    if (jobId && outcome) {
      last = {
        jobId,
        outcome,
        reason: optionalText(run, "reason"),
        fromVersion: optionalText(run, "fromVersion"),
        toVersion: optionalText(run, "toVersion"),
        finishedAt: optionalText(run, "finishedAt")
      };
    }
  }
  return { running: record.running, version: optionalText(record, "version"), last };
}

/** Den Auftrag stellen. Antwortet der Agent mit `202`, läuft der Watcher an. */
export async function requestSelfUpdate(
  target: AgentTarget,
  imageRef: string,
  options: RequestOptions
): Promise<SelfUpdateAccepted> {
  return parseSelfUpdateAccepted(await agentPost(target, "/self-update", { imageRef }, options));
}

/** Den Stand lesen: läuft ein Auftrag, und wie ging der letzte aus? */
export async function fetchSelfUpdateStatus(target: AgentTarget, options: RequestOptions): Promise<SelfUpdateStatus> {
  return parseSelfUpdateStatus(await agentGet(target, "/self-update", options));
}
