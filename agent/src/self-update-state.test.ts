import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SelfUpdateJob, SelfUpdateStatus } from "./self-update.js";
import {
  JOB_FILE,
  STARTED_FILE,
  RUNNING_FILE,
  STATUS_FILE,
  AVAILABLE_FILE,
  jobOpen,
  readStart,
  readStatus,
  readAvailable,
  reportStart,
  takeJob,
  finishJob,
  writeJob,
  writeAvailable,
  startConfirmed
} from "./self-update-state.js";

function directory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-selbstupdate-"));
}

const Job: SelfUpdateJob = {
  jobId: "auftrag-1",
  requestedBy: "dashboard",
  requestedAt: "2026-08-25T20:00:00.000Z",
  agentContainerId: "agent-alt",
  imageRef: "ghcr.io/florianfinn/docklet-hub-agent:latest",
  runningVersion: "0.11.0",
  runningImageId: `sha256:${"a".repeat(64)}`
};

const STATUS: SelfUpdateStatus = {
  jobId: "auftrag-1",
  outcome: "ok",
  reason: null,
  fromVersion: "0.11.0",
  toVersion: "v0.12.0",
  fromImageId: `sha256:${"a".repeat(64)}`,
  toImageId: `sha256:${"b".repeat(64)}`,
  digest: "ghcr.io/florianfinn/docklet-hub-agent@sha256:cafe",
  startedAt: "2026-08-25T20:00:01.000Z",
  finishedAt: "2026-08-25T20:00:41.000Z"
};

test("a written job counts as open and is accepted exactly once", () => {
  const dir = directory();
  assert.equal(jobOpen(dir), false);

  writeJob(dir, Job);
  assert.equal(jobOpen(dir), true);

  const accepted = takeJob(dir);
  assert.deepEqual(accepted, Job);
  // The inbox is empty, but the job still counts as open — otherwise a
  // second one could be placed next to it during the swap.
  assert.equal(fs.existsSync(path.join(dir, JOB_FILE)), false);
  assert.equal(fs.existsSync(path.join(dir, RUNNING_FILE)), true);
  assert.equal(jobOpen(dir), true);

  // The second attempt finds nothing. That is the latch against a watcher
  // that dies in the middle of the swap and restarts.
  assert.equal(takeJob(dir), null);
});

test("completion clears away the running job and leaves the outcome behind", () => {
  const dir = directory();
  writeJob(dir, Job);
  takeJob(dir);

  finishJob(dir, STATUS);
  assert.equal(jobOpen(dir), false);
  assert.deepEqual(readStatus(dir), STATUS);
});

// The forms BEFORE the switch of the wire format to English (#418, commit
// f28f841) — taken over field by field from the diff and not recreated.
// Exactly these files are in `/state` when an agent from this version on boots
// on a host for the FIRST time: they were written by the watcher, which was
// still the old version.
const OLD_JOB = {
  "auftragId": "auftrag-1",
  "angefordertVon": "dashboard",
  "angefordertAm": "2026-08-25T20:00:00.000Z",
  agentContainerId: "agent-alt",
  imageRef: "ghcr.io/florianfinn/docklet-hub-agent:latest",
  "laufendeVersion": "0.11.0",
  "laufendeImageId": `sha256:${"a".repeat(64)}`
};

const OLD_STATUS = {
  "auftragId": "auftrag-1",
  "ausgang": "ok",
  "grund": null,
  "vonVersion": "0.11.0",
  "nachVersion": "v0.12.0",
  "vonImageId": `sha256:${"a".repeat(64)}`,
  "nachImageId": `sha256:${"b".repeat(64)}`,
  digest: "ghcr.io/florianfinn/docklet-hub-agent@sha256:cafe",
  "begonnenAm": "2026-08-25T20:00:01.000Z",
  "beendetAm": "2026-08-25T20:00:41.000Z"
};

test("the outcome of an old watcher survives the swap despite new names", () => {
  const dir = directory();
  fs.writeFileSync(path.join(dir, STATUS_FILE), JSON.stringify(OLD_STATUS), "utf8");

  // Without the agreement on both names this would be `null`: the new agent
  // would lose the outcome of its own update, and the UI would show a job that
  // never comes back.
  assert.deepEqual(readStatus(dir), STATUS);
});

// #80: the five outcomes have been English since v0.24.0. The transition
// lives in the same place as that of the field names and for the same reason —
// the file comes from the watcher BEFORE the update, the reader runs in the
// agent AFTER it.
test("the old outcome wordings are read and returned as English ones (#80)", () => {
  const dir = directory();
  const alt = {
    "unveraendert": "unchanged",
    "abgebrochen": "aborted",
    "zurueckgerollt": "rolled-back",
    "fehlgeschlagen": "failed"
  };
  for (const [legacy, expected] of Object.entries(alt)) {
    fs.writeFileSync(
      path.join(dir, STATUS_FILE),
      JSON.stringify({ ...OLD_STATUS, "ausgang": legacy }),
      "utf8"
    );
    assert.equal(readStatus(dir)?.outcome, expected, `"${legacy}" must arrive as "${expected}"`);
  }

  // "ok" is the same in both versions and needs no mapping.
  fs.writeFileSync(path.join(dir, STATUS_FILE), JSON.stringify({ ...STATUS, outcome: "ok" }), "utf8");
  assert.equal(readStatus(dir)?.outcome, "ok");
});

// Until #80 a bare `outcome as SelfUpdateOutcome` stood here. A value
// nobody knows thereby got through as a typed outcome and only hit where
// someone compared it.
test("an unknown outcome makes the status invalid instead of being cast (#80)", () => {
  const dir = directory();
  fs.writeFileSync(
    path.join(dir, STATUS_FILE),
    JSON.stringify({ ...STATUS, outcome: "durchgelaufen" }),
    "utf8"
  );
  assert.equal(readStatus(dir), null);
});

test("a job from an old agent is accepted by the new watcher", () => {
  const dir = directory();
  fs.writeFileSync(path.join(dir, JOB_FILE), JSON.stringify(OLD_JOB), "utf8");

  // The opposite direction: the watcher was swapped before the agent. Without
  // the fallback takeJob() would clear the file away as unusable and the swap
  // would never take place.
  assert.deepEqual(takeJob(dir), Job);
});

test("if a field is present under both names, the new one wins", () => {
  const dir = directory();
  fs.writeFileSync(
    path.join(dir, STATUS_FILE),
    JSON.stringify({ ...OLD_STATUS, ...STATUS }),
    "utf8"
  );
  assert.deepEqual(readStatus(dir), STATUS);

  fs.writeFileSync(
    path.join(dir, STATUS_FILE),
    JSON.stringify({ ...STATUS, "ausgang": "fehlgeschlagen", "auftragId": "auftrag-alt" }),
    "utf8"
  );
  const loaded = readStatus(dir);
  assert.equal(loaded?.outcome, "ok");
  assert.equal(loaded?.jobId, "auftrag-1");
});

test("the new form is written — and the old one in addition for the old watcher", () => {
  const dir = directory();
  writeJob(dir, Job);
  finishJob(dir, STATUS);

  // status.json is written by the watcher for the agent, which is always the
  // newer one: only the new form is in it.
  const status = JSON.parse(fs.readFileSync(path.join(dir, STATUS_FILE), "utf8")) as Record<string, unknown>;
  for (const legacy of ["auftragId", "ausgang", "grund", "vonVersion", "nachVersion", "vonImageId", "nachImageId", "begonnenAm", "beendetAm"]) {
    assert.equal(Object.hasOwn(status, legacy), false, `${STATUS_FILE} carries ${legacy}`);
  }

  // auftrag.json is read by the watcher — until the next `compose up` the OLD
  // one. A v0.17.0 watcher requires the four German fields; without them it
  // would clear the job away as unusable and the swap would never take place.
  const job = JSON.parse(fs.readFileSync(path.join(dir, JOB_FILE), "utf8")) as Record<string, unknown>;
  assert.equal(job.jobId, Job.jobId);
  assert.equal(Object.hasOwn(job, "auftragId"), false);
  assert.equal(job.requestedBy, Job.requestedBy);
  assert.equal(job["angefordertVon"], Job.requestedBy);
  assert.equal(job["angefordertAm"], Job.requestedAt);
  assert.equal(job["laufendeVersion"], Job.runningVersion);
  assert.equal(job["laufendeImageId"], Job.runningImageId);
});

test("the start report carries `zeit` for the old watcher, otherwise it rolls back", () => {
  // The health gate of a v0.17.0 watcher checks `isText(message.zeit)`. The
  // agent writing this file is the NEW one that was just swapped in — if
  // `zeit` were missing, the old watcher would see no start and roll back after
  // the start deadline. On every host, on the first update to v0.18.0.
  const dir = directory();
  reportStart(dir, { version: "0.18.0", containerId: "agent-neu", time: "2026-09-04T12:00:00.000Z" });
  const raw = JSON.parse(fs.readFileSync(path.join(dir, STARTED_FILE), "utf8")) as Record<string, unknown>;
  assert.equal(raw.time, "2026-09-04T12:00:00.000Z");
  assert.equal(raw["zeit"], "2026-09-04T12:00:00.000Z");
  assert.deepEqual(readStart(dir), { version: "0.18.0", containerId: "agent-neu", time: "2026-09-04T12:00:00.000Z" });

  writeAvailable(dir, { imageRef: "ghcr.io/x/y:latest", remoteDigest: "sha256:abc", checkedAt: "2026-09-04T12:00:00.000Z", reason: null });
  const available = JSON.parse(fs.readFileSync(path.join(dir, AVAILABLE_FILE), "utf8")) as Record<string, unknown>;
  assert.equal(available["entfernterDigest"], "sha256:abc");
  assert.equal(available["geprueftAm"], "2026-09-04T12:00:00.000Z");
  assert.equal(available["grund"], null);
});

// v0.18.0: the start report and the registry finding also have English field
// names. The file on the host comes from the agent or watcher BEFORE the swap.
test("start report and registry finding of an old agent are read", () => {
  const dir = directory();
  fs.writeFileSync(
    path.join(dir, STARTED_FILE),
    JSON.stringify({ version: "0.17.0", containerId: "agent-alt", "zeit": "2026-09-04T10:00:00.000Z" }),
    "utf8"
  );
  assert.deepEqual(readStart(dir), { version: "0.17.0", containerId: "agent-alt", time: "2026-09-04T10:00:00.000Z" });

  fs.writeFileSync(
    path.join(dir, AVAILABLE_FILE),
    JSON.stringify({
      imageRef: "ghcr.io/x/y:latest",
      "entfernterDigest": `sha256:${"c".repeat(64)}`,
      "geprueftAm": "2026-09-04T10:00:00.000Z",
      "grund": null
    }),
    "utf8"
  );
  assert.deepEqual(readAvailable(dir, "ghcr.io/x/y:latest"), {
    imageRef: "ghcr.io/x/y:latest",
    remoteDigest: `sha256:${"c".repeat(64)}`,
    checkedAt: "2026-09-04T10:00:00.000Z",
    reason: null
  });
});

test("an unusable job does not block permanently", () => {
  const dir = directory();
  fs.writeFileSync(path.join(dir, JOB_FILE), "{ kein json", "utf8");
  assert.equal(takeJob(dir), null);
  // Had the file stayed behind, jobOpen() would report "yes" forever
  // and the button in the dashboard would only answer "already running".
  assert.equal(jobOpen(dir), false);
});

test("missing files are not an exception but null", () => {
  const dir = directory();
  assert.equal(readStatus(dir), null);
  assert.equal(readStart(dir), null);
  assert.equal(takeJob(dir), null);
});

test("the start report only confirms with matching version AND time", () => {
  const dir = directory();
  const swap = Date.parse("2026-08-25T20:00:10.000Z");

  // The report of the old agent from before the swap.
  reportStart(dir, { version: "0.11.0", containerId: "agent-alt", time: "2026-08-25T19:00:00.000Z" });
  assert.equal(startConfirmed(readStart(dir), "v0.12.0", swap), false);

  // A restart of the OLD container — fresh, but the wrong version.
  // `restart: unless-stopped` delivers exactly that for free, and without the
  // version comparison it would have passed as a success.
  reportStart(dir, { version: "0.11.0", containerId: "agent-alt", time: "2026-08-25T20:00:20.000Z" });
  assert.equal(startConfirmed(readStart(dir), "v0.12.0", swap), false);

  // The new agent.
  reportStart(dir, { version: "0.12.0", containerId: "agent-neu", time: "2026-08-25T20:00:25.000Z" });
  assert.equal(startConfirmed(readStart(dir), "v0.12.0", swap), true);
  // The "v" of the image label and the bare version of package.json mean
  // the same release.
  assert.equal(startConfirmed(readStart(dir), "0.12.0", swap), true);
});

test("startConfirmed rejects without a report and with an unreadable time", () => {
  assert.equal(startConfirmed(null, "v0.12.0", 0), false);
  assert.equal(
    startConfirmed({ version: "0.12.0", containerId: "x", time: "gestern" }, "v0.12.0", 0),
    false
  );
});

test("the registry finding applies to EXACTLY one ref", () => {
  // ⚠️ The watcher writes the state of ITS ref. If it does not match the
  // agent's (configured differently, pinned versus :latest), the information
  // would be about a foreign image — and "not determinable" is then the
  // right answer, not that of the other tag.
  const dir = directory();
  writeAvailable(dir, {
    imageRef: "ghcr.io/florianfinn/docklet-hub-agent:latest",
    remoteDigest: `sha256:${"b".repeat(64)}`,
    checkedAt: "2026-08-26T12:00:00.000Z",
    reason: null
  });

  const matching = readAvailable(dir, "ghcr.io/florianfinn/docklet-hub-agent:latest");
  assert.equal(matching?.remoteDigest, `sha256:${"b".repeat(64)}`);
  assert.equal(matching?.checkedAt, "2026-08-26T12:00:00.000Z");

  assert.equal(readAvailable(dir, "ghcr.io/florianfinn/docklet-hub-agent:v0.13.1"), null);
});

test("without a file and with a broken file the same applies: no information", () => {
  const dir = directory();
  assert.equal(readAvailable(dir, "ghcr.io/x/y:latest"), null);
  fs.writeFileSync(path.join(dir, AVAILABLE_FILE), "{kein json", "utf8");
  assert.equal(readAvailable(dir, "ghcr.io/x/y:latest"), null);
});

test("a finding without a digest carries its reason along", () => {
  // Without it a missing login would look like a registry in which there is
  // nothing.
  const dir = directory();
  writeAvailable(dir, {
    imageRef: "ghcr.io/x/y:latest",
    remoteDigest: null,
    checkedAt: "2026-08-26T12:00:00.000Z",
    reason: "no-login:no-entry"
  });
  const loaded = readAvailable(dir, "ghcr.io/x/y:latest");
  assert.equal(loaded?.remoteDigest, null);
  assert.equal(loaded?.reason, "no-login:no-entry");
});

test("the files of the channel are readable for the other side", { skip: process.platform === "win32" ? "file modes do not exist on Windows" : false }, () => {
  // ⚠️ Found live: if agent and watcher run under different uids — on
  // unraid unavoidable, because the Docker login belongs to root there —, then
  // 0600 locked out exactly the reader the file is written for.
  // The swap ran, the display stayed empty.
  const dir = directory();
  writeJob(dir, Job);
  finishJob(dir, STATUS);
  reportStart(dir, { version: "0.14.2", containerId: "abc", time: new Date().toISOString() });
  writeAvailable(dir, {
    imageRef: "ghcr.io/x/y:latest",
    remoteDigest: null,
    checkedAt: "2026-08-26T12:00:00.000Z",
    reason: null
  });

  for (const file of [STATUS_FILE, STARTED_FILE, AVAILABLE_FILE]) {
    const mode = fs.statSync(path.join(dir, file)).mode & 0o777;
    assert.equal(mode, 0o644, `${file} is at ${mode.toString(8)}`);
  }
});
