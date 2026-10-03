// The channel between agent and watcher (#36).
//
// Deliberately FILES in the shared `/state` volume and not HTTP: that way the
// watcher needs no port, no secret and no network reachability — on remote-host the
// agent sits in the netns of the WireGuard sidecar, and a second listening
// service there would be a question of its own. The trust boundary is instead
// the volume that only these two containers see.
//
// Five files, each with exactly one writer (names: the *_FILE constants below):
//
//   JOB_FILE        agent   -> watcher   "please update"
//   RUNNING_FILE    watcher              the accepted job
//   STATUS_FILE     watcher -> agent     the outcome, survives the swap
//   STARTED_FILE    agent   -> watcher   "I am up" (the health gate)
//   AVAILABLE_FILE  watcher -> agent     "what is currently in the registry"
//
// STARTED_FILE is the reason the watcher can decide without network access
// whether the new agent is alive: an agent that aborts immediately because of
// an unwritable audit log or an invalid secret is still running as far as
// Docker is concerned — but it never gets far enough to write this file.

import fs from "node:fs";
import path from "node:path";
import {
  SELF_UPDATE_OUTCOMES,
  type SelfUpdateJob,
  type SelfUpdateOutcome,
  type SelfUpdateStatus
} from "./self-update.js";

export type StartMessage = {
  version: string;
  containerId: string;
  time: string;
};

// What the watcher saw at the registry during its last advance check.
//
// ⚠️ `imageRef` travels along and is not decoration: the information applies
// to EXACTLY this ref. The agent only uses it if it matches its own —
// otherwise it would show the state of a foreign image as its own.
//
// `checkedAt` likewise (formerly `geprueftAm`): by construction the value is
// older than the moment it is read (the watcher asks periodically, not on
// demand). A UI that hides the age promises a freshness that does not exist.
//
// The field names became English with v0.18.0 (`entfernterDigest` ->
// `remoteDigest`, `geprueftAm` -> `checkedAt`, `grund` -> `reason`). A
// watcher of the version before still writes the file with the old names;
// `readAvailable` therefore reads both (see textWithLegacyName).
export type AvailableFinding = {
  imageRef: string;
  remoteDigest: string | null;
  checkedAt: string;
  // Set when no digest could be determined — "no-entry", "unauthorized",
  // "credential-helper". Without it a missing login would look like a registry
  // that holds nothing.
  reason: string | null;
};

export const JOB_FILE = "auftrag.json";
export const RUNNING_FILE = "laeuft.json";
export const STATUS_FILE = "status.json";
export const STARTED_FILE = "gestartet.json";
export const AVAILABLE_FILE = "verfuegbar.json";

// ⚠️ 0644 and not 0600 — deliberately, and for a reason that is stated right
// here:
//
// The point of each of these files is that the OTHER container reads it. If
// both run under the same uid, 0600 is no problem; if they run under different
// ones, it is. Exactly that happened live: on unraid the Docker login belongs
// to root, so the watcher has to run as root there to be able to read it —
// and then wrote STATUS_FILE and AVAILABLE_FILE in a way that the agent
// (uid 1000) could no longer read them. The display stayed empty although the
// swap ran.
//
// The mode was the wrong barrier. The trust boundary of this channel is the
// volume that only these two containers see (see file header), not the bit on
// the file. And the content reveals nothing: job ids, versions, digests,
// timestamps — no secret. A mode that locks out the one legitimate reader and
// achieves nothing else is not hardening.
const FILE_MODE = 0o644;

function writeAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // temp + rename as with the allowlist: a crash in the middle of writing must
  // not leave a half file behind that the other process then reads.
  const temporary = `${file}.tmp`;
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
    FILE_MODE
  );
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2), "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
  // The mode from openSync goes through the umask; a `umask 077` in the
  // container would turn it back into 0600. Hence set it explicitly.
  fs.chmodSync(temporary, FILE_MODE);
  fs.renameSync(temporary, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    // Missing and broken are treated the same: both mean "no usable value",
    // and a watcher that dies on a file is worse than one that discards a
    // job.
    return null;
  }
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// TRANSITION (#418): read the same field under the new AND the old name.
//
// When the wire format was switched to English, `SelfUpdateJob` and
// `SelbstupdateStatus` moved along (`auftragId`->`jobId`, `ausgang`->`outcome`
// and seven more). These two shapes are not only wire shapes, though, but at
// the same time the file channel above — and the flow it carries is EXACTLY
// the swap of one of the two containers:
//
//   1. The OLD agent writes JOB_FILE with `auftragId`.
//   2. The OLD watcher accepts it and replaces the agent.
//   3. The NEW agent reads STATUS_FILE — written by the OLD watcher, i.e.
//      with `ausgang` instead of `outcome`.
//   4. `isText(status.jobId)` fails, the result is `null`.
//
// The agent thereby loses the outcome of its OWN update — of all things the
// property the file header above calls "survives the swap". This hits the
// FIRST update on EVERY host and is not an edge case: the UI showed a job that
// never comes back. The same question arises in the opposite direction when
// the watcher is swapped before the agent and finds the job of an old agent.
//
// Both names are READ, the new one takes precedence. The new one is WRITTEN —
// and for the files a possibly OLD reader needs, the old one as well (see
// withLegacyJobKeys). The readers always return the new shape. No new German
// field is created; the old ones appear as data in quotes.
//
// This accommodation may disappear again as soon as an agent from this
// version on runs on all hosts — from then on no watcher and no agent has
// written the old names any more, and the fallback is dead code.
function textWithLegacyName(
  source: Record<string, unknown>,
  key: string,
  legacyKey: string
): string | null {
  const value = source[key];
  if (isText(value)) return value;
  const legacyValue = source[legacyKey];
  return isText(legacyValue) ? legacyValue : null;
}

// ⚠️ Returns the NEW shape, even if the file carried the old one. A mere
// boolean would not do here: a check that lets `auftragId` through and then
// passes on the RAW object hands `jobId === undefined` to watcher.ts and
// self-update.ts — the failure would be the same, just one level later and
// without an error message.
//
// With v0.17.0 `auftragId` moved, with v0.18.0 the remaining four German
// fields (`angefordertVon`, `angefordertAm`, `laufendeVersion`,
// `laufendeImageId`). Both versions are in circulation on the hosts.
function readJob(value: unknown): SelfUpdateJob | null {
  if (!value || typeof value !== "object") return null;
  const job = value as Record<string, unknown>;
  const jobId = textWithLegacyName(job, "jobId", "auftragId");
  const requestedBy = textWithLegacyName(job, "requestedBy", "angefordertVon");
  const requestedAt = textWithLegacyName(job, "requestedAt", "angefordertAm");
  const agentContainerId = isText(job.agentContainerId) ? job.agentContainerId : null;
  const imageRef = isText(job.imageRef) ? job.imageRef : null;
  const runningVersion = textWithLegacyName(job, "runningVersion", "laufendeVersion");
  const runningImageId = textWithLegacyName(job, "runningImageId", "laufendeImageId");
  if (
    !jobId ||
    !requestedBy ||
    !requestedAt ||
    !agentContainerId ||
    !imageRef ||
    !runningVersion ||
    !runningImageId
  ) {
    return null;
  }
  return {
    jobId,
    requestedBy,
    requestedAt,
    agentContainerId,
    imageRef,
    runningVersion,
    runningImageId
  };
}

export function isJob(value: unknown): value is SelfUpdateJob {
  return readJob(value) !== null;
}

// TRANSITION (v0.18.0), opposite direction to textWithLegacyName: the files
// the AGENT writes for the WATCHER carry both names.
//
// The watcher only swaps the agent, not itself (README, "What this path does
// not do"): until the next `docker compose up -d` a watcher of the version
// BEFORE reads what the new agent writes. A v0.17.0 watcher requires the four
// German fields in JOB_FILE and would otherwise clear the job away as
// unusable; in STARTED_FILE it requires `zeit` and would roll the freshly
// swapped agent back after the start deadline — on EVERY host, on the FIRST
// update to this version. Exactly the bug v0.17.0 already found once in the
// other direction.
//
// The old keys are in quotes here: they are data for an old reader, not
// identifiers. They go away as soon as a watcher from v0.18.0 on runs on all
// hosts.
function withLegacyJobKeys(job: SelfUpdateJob): Record<string, unknown> {
  return {
    ...job,
    "angefordertVon": job.requestedBy,
    "angefordertAm": job.requestedAt,
    "laufendeVersion": job.runningVersion,
    "laufendeImageId": job.runningImageId
  };
}

export function writeJob(directory: string, job: SelfUpdateJob): void {
  writeAtomic(path.join(directory, JOB_FILE), withLegacyJobKeys(job));
}

// Is a job already under way? The agent needs this to reject a second button
// press instead of letting two swap operations run side by side.
export function jobOpen(directory: string): boolean {
  return (
    fs.existsSync(path.join(directory, JOB_FILE)) ||
    fs.existsSync(path.join(directory, RUNNING_FILE))
  );
}

// ACCEPT the job: rename and then read.
//
// The order is the point. `rename` is atomic — the job has thereby vanished
// from the inbox before anything happens. Without this step a watcher that
// dies during the swap and restarts would execute the same job once more; the
// swap, however, is exactly the kind of operation you do not want twice.
export function takeJob(directory: string): SelfUpdateJob | null {
  const inbox = path.join(directory, JOB_FILE);
  const accepted = path.join(directory, RUNNING_FILE);
  try {
    fs.renameSync(inbox, accepted);
  } catch {
    return null;
  }
  // ⚠️ RUNNING_FILE is the renamed inbox and therefore carries the shape of
  // the agent that wrote it — including the old one (see readJob).
  const job = readJob(readJson(accepted));
  if (!job) {
    // Unusable: clear it away, otherwise the file blocks every further job
    // via jobOpen().
    try {
      fs.unlinkSync(accepted);
    } catch {
      // Not worth mentioning — the next attempt stumbles again, and that then
      // shows up in the log.
    }
    return null;
  }
  return job;
}

export function finishJob(directory: string, status: SelfUpdateStatus): void {
  writeAtomic(path.join(directory, STATUS_FILE), status);
  try {
    fs.unlinkSync(path.join(directory, RUNNING_FILE));
  } catch {
    // If it is already gone, the goal is reached.
  }
}

// TRANSITION (v0.24.0): the five outcomes of the self-update had German names
// until then (#80). They appear here as data in quotes, not as identifiers;
// the fallback goes away as soon as a version from v0.24.0 on has run on all
// hosts and the last status file comes from it.
//
// "ok" is missing from this table because it has the same name in both
// versions.
const LEGACY_SELF_UPDATE_OUTCOMES: Record<string, SelfUpdateOutcome> = {
  "unveraendert": "unchanged",
  "abgebrochen": "aborted",
  "zurueckgerollt": "rolled-back",
  "fehlgeschlagen": "failed"
};

// ⚠️ Until #80 there was a bare `outcome as SelfUpdateOutcome` here — a cast
// without a check, at exactly the place where a version reads the file of its
// PREDECESSOR VERSION. A one-sided rename would have fallen through it and only
// surfaced where someone compares the value.
//
// An unknown value makes the whole status invalid (`null`) instead of claiming
// an invented outcome. That is the same result this function has always
// returned for a missing `jobId`, and the display copes with it:
// `/self-update` carries `last: null` as long as no update has run yet. A
// wrongly named outcome, by contrast, would appear as a fact in the UI.
function selfUpdateOutcomeFrom(value: string | null): SelfUpdateOutcome | null {
  if (!value) return null;
  const outcome = LEGACY_SELF_UPDATE_OUTCOMES[value] ?? value;
  return (SELF_UPDATE_OUTCOMES as readonly string[]).includes(outcome)
    ? (outcome as SelfUpdateOutcome)
    : null;
}

// ⚠️ This function is the place where the swap went wrong: by construction
// the file comes from the watcher BEFORE the update, the reader runs in the
// agent AFTERWARDS. It therefore reads both naming versions and in every case
// returns the new one — also onto the wire for /self-update
// (routes/self-update-routes.ts, `last`), where German keys would otherwise
// suddenly appear. Since #80 this applies not only to the field names but also
// to the VALUE of `outcome`.
export function readStatus(directory: string): SelfUpdateStatus | null {
  const value = readJson(path.join(directory, STATUS_FILE));
  if (!value || typeof value !== "object") return null;
  const status = value as Record<string, unknown>;
  const jobId = textWithLegacyName(status, "jobId", "auftragId");
  const outcome = selfUpdateOutcomeFrom(textWithLegacyName(status, "outcome", "ausgang"));
  // The same two required fields as before. New since #80 is that the outcome
  // is CHECKED instead of cast — see `selfUpdateOutcomeFrom`.
  if (!jobId || !outcome) return null;
  return {
    jobId,
    outcome,
    reason: textWithLegacyName(status, "reason", "grund"),
    // `?? ""` only for the required fields: if one is missing, the earlier
    // cast hid an `undefined` behind a `string` — visible only in the display.
    fromVersion: textWithLegacyName(status, "fromVersion", "vonVersion") ?? "",
    toVersion: textWithLegacyName(status, "toVersion", "nachVersion"),
    fromImageId: textWithLegacyName(status, "fromImageId", "vonImageId") ?? "",
    toImageId: textWithLegacyName(status, "toImageId", "nachImageId"),
    // `digest` has the same name in both versions.
    digest: isText(status.digest) ? status.digest : null,
    startedAt: textWithLegacyName(status, "startedAt", "begonnenAm") ?? "",
    finishedAt: textWithLegacyName(status, "finishedAt", "beendetAm") ?? ""
  };
}

// Written by the agent on EVERY start, not only after an update. That is
// intentional: the watcher compares the timestamp against the start of its
// swap, and a file that is only written sometimes would be useless for that.
export function reportStart(directory: string, message: StartMessage): void {
  // `zeit` for the old watcher, see withLegacyJobKeys.
  writeAtomic(path.join(directory, STARTED_FILE), { ...message, "zeit": message.time });
}

export function readStart(directory: string): StartMessage | null {
  const value = readJson(path.join(directory, STARTED_FILE));
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  // `zeit` -> `time` with v0.18.0; the file comes from the agent BEFORE the swap.
  const time = textWithLegacyName(message, "time", "zeit");
  if (!isText(message.version) || !isText(message.containerId) || !time) return null;
  return { version: message.version, containerId: message.containerId, time };
}

export function writeAvailable(directory: string, finding: AvailableFinding): void {
  // The watcher writes this file for the agent. The agent is usually the newer
  // of the two; after a rollback it can still be older than a watcher renewed
  // via `compose up`. Both names cost nothing.
  writeAtomic(path.join(directory, AVAILABLE_FILE), {
    ...finding,
    "entfernterDigest": finding.remoteDigest,
    "geprueftAm": finding.checkedAt,
    "grund": finding.reason
  });
}

// ⚠️ `expectedRef` is required and not an optional filter: the only sensible
// way to handle a finding for a DIFFERENT ref is not to use it. Passing it on
// and letting the caller compare would mean leaving the mix-up possible.
export function readAvailable(directory: string, expectedRef: string): AvailableFinding | null {
  const value = readJson(path.join(directory, AVAILABLE_FILE));
  if (!value || typeof value !== "object") return null;
  const finding = value as Record<string, unknown>;
  const checkedAt = textWithLegacyName(finding, "checkedAt", "geprueftAm");
  if (!isText(finding.imageRef) || !checkedAt) return null;
  if (finding.imageRef !== expectedRef) return null;
  return {
    imageRef: finding.imageRef,
    remoteDigest: textWithLegacyName(finding, "remoteDigest", "entfernterDigest"),
    checkedAt,
    reason: textWithLegacyName(finding, "reason", "grund")
  };
}

// Has an agent of the expected version reported in SINCE the swap?
//
// Both halves count. The timestamp alone would read a restart of the OLD
// container as success (`restart: unless-stopped` delivers that for free); the
// version alone would accept the report of the agent that ran before the swap
// if the versions happen to match.
export function startConfirmed(
  message: StartMessage | null,
  expectedVersion: string,
  sinceMs: number
): boolean {
  if (!message) return false;
  const time = Date.parse(message.time);
  if (!Number.isFinite(time) || time < sinceMs) return false;
  return normalizeVersion(message.version) === normalizeVersion(expectedVersion);
}

// The version label carries a "v" (`v0.11.0`), the agent's package.json does
// not (`0.11.0`). Both denote the same release.
export function normalizeVersion(value: string): string {
  return value.startsWith("v") ? value.slice(1) : value;
}
