import type { AgentUpdateOffer, AgentUpdateState } from "contract";

import { agentGet, agentPost, AgentError, type AgentTarget, type RequestOptions } from "../../platform/agent-transport/protocol.js";
import { compareAgentVersions, parseAgentVersion } from "./version.js";

// POST /self-update queues work for the watcher; acceptance does not mean
// completion. The hub supplies its release image as the explicit target.
// The watcher validates the image and persists the result across the swap.

/**
 * The first agent version that can follow a target in `POST /self-update`.
 *
 * It reads `{ imageRef }` since 0.30.0, but it only accepts a target in its OWN
 * repository. Since #279 the image is named `docklet-hub-agent`, so
 * the agents of 0.30.0 and 0.31.0 (named `dashboard-docker-agent`) would
 * refuse the new target with `target-foreign-repository`: the first version that
 * runs from the new name is the first one the button works for.
 */
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

// What the button offers on an arm. Both types live in the contract
// (`contract/src/api/hosts.ts`, #247): the offer travels to the web inside
// every host view. What each state means for THIS side, where
// `agentUpdateOffer` below decides it:
//
//   `current`    the arm runs the target or newer.
//   `available`  the arm is older and reads the target — the button works.
//   `manual`     the arm is older but does not read the target. The button
//                would have no effect there (`unchanged`); the step is done
//                once by hand.
//
// `targetImageRef` travels along because the manual step needs exactly that
// line: `DOCKER_AGENT_IMAGE` in the arm's `.env`. An image ref is no secret —
// it sits in every arm's archive anyway.
export type { AgentUpdateOffer, AgentUpdateState };

/** Die Fassung aus dem Tag eines Refs (`…:v0.30.0@sha256:…` → `0.30.0`). */
export function versionOfImageRef(imageRef: string): string | null {
  const withoutDigest = imageRef.split("@")[0];
  const lastSlash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.indexOf(":", lastSlash + 1);
  if (colon < 0) return null;
  const parsed = parseAgentVersion(withoutDigest.slice(colon + 1));
  return parsed ? parsed.join(".") : null;
}

/**
 * Das Angebot für einen erreichbaren Arm — `null`, wo es keines gibt.
 *
 * ⚠️ Eine unlesbare Fassung des Arms ist `manual` und nicht `available`: ob
 * er das Ziel liest, ist dann nicht festzustellen, und ein Knopf, der
 * vielleicht nichts tut, verspricht mehr, als hier bekannt ist.
 */
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
  const readsTarget = running !== null && compareAgentVersions(running, minimum) >= 0;
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
