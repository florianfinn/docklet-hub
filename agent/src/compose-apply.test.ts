import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyCompose, checkDrift, type ApplyOps } from "./compose-apply.js";
import { ensureBindSources, hashOf, readComposeFile, writeComposeFile } from "./compose-store.js";
import { locationFor } from "./compose.js";
import type { ContainerSpec } from "./spec.js";

// Real file system in a temp directory, faked Docker calls. The file side IS
// the subject under test here — mocking it would mean not testing exactly what
// this is about.
function sandbox(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "compose-apply-"));
}

function spec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: "minecraft",
    imageRef: "itzg/minecraft-server:2024.1",
    env: [{ key: "EULA", value: "TRUE" }],
    ports: [],
    volumes: [],
    networks: [],
    restartPolicy: "unless-stopped",
    resources: { memoryMb: 1024, cpus: 1, pidsLimit: 256 },
    ...overrides
  };
}

type Calls = { up: number; down: number };

function ops(overrides: Partial<ApplyOps> = {}, log: Calls = { up: 0, down: 0 }): ApplyOps {
  return {
    up: async () => {
      log.up += 1;
      return "";
    },
    down: async () => {
      log.down += 1;
      return "";
    },
    resolveContainerId: async () => "neue-id",
    blockingViolations: async () => [],
    runState: async () => ({ running: true, restarting: false, exitCode: 0 }),
    ...overrides
  };
}

test("create writes the file and returns id and hash", async () => {
  const base = sandbox();
  const location = locationFor("minecraft", base)!;
  const outcome = await applyCompose(ops(), {
    location,
    spec: spec(),
    imageRef: "itzg/minecraft-server:2024.1",
    basePath: base,
    expectedHash: null
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.containerId, "neue-id");
  const file = readComposeFile(location.projectDir);
  assert.equal(file.exists, true);
  assert.equal(outcome.composeHash, file.hash);
});

test("a container restarting in a loop is not reported as running", async () => {
  // Seen live 2026-07-21: redis with cap_drop ALL fails at the chown and
  // restarts endlessly. `compose up --wait` saw it running in the first moment.
  // The definition stays in place anyway — it is exactly what the operator
  // needs to fix it.
  const base = sandbox();
  const location = locationFor("minecraft", base)!;
  const outcome = await applyCompose(
    ops({ runState: async () => ({ running: true, restarting: true, exitCode: 1 }) }),
    { location, spec: spec(), imageRef: "x:1", basePath: base, expectedHash: null }
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.running, false);
  assert.equal(outcome.restartLooping, true);
  assert.equal(readComposeFile(location.projectDir).exists, true, "the file stays");
});

test("bind sources are created before the up", async () => {
  // Gap 6.3.2: if the Docker daemon creates them, they belong to root — and a
  // container running as non-root cannot write into its own data
  // directory.
  const base = sandbox();
  const location = locationFor("minecraft", base)!;
  const source = `${base}/minecraft/data`;
  let existedAtUp = false;

  await applyCompose(
    ops({
      up: async () => {
        existedAtUp = fs.existsSync(source);
        return "";
      }
    }),
    {
      location,
      spec: spec({ volumes: [{ type: "bind", source: source, target: "/data", readOnly: false }] }),
      imageRef: "x:1",
      basePath: base,
      expectedHash: null
    }
  );

  assert.equal(existedAtUp, true);
});

test("bind sources outside the base path are not created", () => {
  const base = sandbox();
  ensureBindSources(["/etc/boese", `${base}/gut`], base);
  assert.equal(fs.existsSync("/etc/boese"), false);
  assert.equal(fs.existsSync(`${base}/gut`), true);
});

test("an existing directory is not touched", () => {
  // In particular no chown on something that already belongs to someone.
  const base = sandbox();
  const existing = `${base}/vorhanden`;
  fs.mkdirSync(existing);
  fs.writeFileSync(`${existing}/file`, "inhalt", "utf8");
  ensureBindSources([existing], base);
  assert.equal(fs.readFileSync(`${existing}/file`, "utf8"), "inhalt");
});

test("if the up fails on create, no half stack is left behind", async () => {
  const base = sandbox();
  const location = locationFor("minecraft", base)!;
  const log = { up: 0, down: 0 };
  const outcome = await applyCompose(
    ops(
      {
        up: async () => {
          log.up += 1;
          throw new Error("kein Image");
        }
      },
      log
    ),
    { location, spec: spec(), imageRef: "x:1", basePath: base, expectedHash: null }
  );

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "compose-up-failed");
  assert.equal(outcome.rolledBack, true);
  // A container that occupies the name and is not running is worse than
  // none: the stack is shut down...
  assert.equal(log.down, 1);
  // ...and the file that did not exist before is gone again.
  assert.equal(readComposeFile(location.projectDir).exists, false);
});

test("if the up fails on edit, the previous version is written back", async () => {
  const base = sandbox();
  const location = locationFor("minecraft", base)!;
  // Create first, then edit.
  const created = await applyCompose(ops(), {
    location,
    spec: spec(),
    imageRef: "x:1",
    basePath: base,
    expectedHash: null
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const before = readComposeFile(location.projectDir).content;

  const log = { up: 0, down: 0 };
  const outcome = await applyCompose(
    ops(
      {
        up: async () => {
          log.up += 1;
          // The first call is the real one, the second the rollback.
          if (log.up === 1) throw new Error("Port belegt");
          return "";
        }
      },
      log
    ),
    {
      location,
      spec: spec({ resources: { memoryMb: 2048, cpus: 1, pidsLimit: 256 } }),
      imageRef: "x:1",
      basePath: base,
      expectedHash: created.composeHash
    }
  );

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.rolledBack, true);
  // This is the gain of the direction decision: the old definition was on
  // disk and did not have to be held in memory (5a).
  assert.equal(readComposeFile(location.projectDir).content, before);
  assert.equal(log.up, 2, "the rollback happens with a second up");
  assert.equal(log.down, 0, "on edit there is NO shutdown");
});

test("a result that violates the hardening is rolled back", async () => {
  // The spec check before only judges what was written into the file. Only
  // here is it certain what actually became of it — and a file can claim
  // anything.
  const base = sandbox();
  const location = locationFor("minecraft", base)!;
  const log = { up: 0, down: 0 };
  const outcome = await applyCompose(
    ops({ blockingViolations: async () => ["docker-socket-mount"] }, log),
    { location, spec: spec(), imageRef: "x:1", basePath: base, expectedHash: null }
  );

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /hardening-violated: docker-socket-mount/);
  assert.equal(outcome.rolledBack, true);
  assert.equal(log.down, 1);
});

test("if the container cannot be resolved, it is rolled back as well", async () => {
  const base = sandbox();
  const location = locationFor("minecraft", base)!;
  const outcome = await applyCompose(ops({ resolveContainerId: async () => null }), {
    location,
    spec: spec(),
    imageRef: "x:1",
    basePath: base,
    expectedHash: null
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "container-not-resolvable");
});

test("a failed rollback is reported, not swallowed", async () => {
  // The only situation in which someone has to look by hand. It must not get
  // lost in a generic "did not work".
  const base = sandbox();
  const location = locationFor("minecraft", base)!;
  const outcome = await applyCompose(
    ops({
      up: async () => {
        throw new Error("kaputt");
      },
      down: async () => {
        throw new Error("auch kaputt");
      }
    }),
    { location, spec: spec(), imageRef: "x:1", basePath: base, expectedHash: null }
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.rolledBack, false);
});

// --- The guard against blind overwriting ----------------------------------

test("a file changed by hand is not overwritten", async () => {
  const base = sandbox();
  const location = locationFor("minecraft", base)!;
  const created = await applyCompose(ops(), {
    location,
    spec: spec(),
    imageRef: "x:1",
    basePath: base,
    expectedHash: null
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  // Someone saves alongside via SSH.
  const ofHand = "# von Hand\nservices: {}\n";
  fs.writeFileSync(path.join(location.projectDir, "compose.yaml"), ofHand, "utf8");

  const drift = checkDrift(location.projectDir, created.composeHash);
  assert.equal(drift.ok, false);
  if (drift.ok) return;
  assert.equal(drift.reason, "file-changed-externally");
  assert.equal(drift.currentHash, hashOf(ofHand));

  // And even if the pre-check were skipped: applyCompose does not write.
  // There is time between check and write.
  const outcome = await applyCompose(ops(), {
    location,
    spec: spec(),
    imageRef: "x:1",
    basePath: base,
    expectedHash: created.composeHash
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "file-changed-externally");
  assert.equal(readComposeFile(location.projectDir).content, ofHand);
});

test("on create there must not be a file yet", async () => {
  const base = sandbox();
  const location = locationFor("minecraft", base)!;
  fs.mkdirSync(location.projectDir, { recursive: true });
  fs.writeFileSync(path.join(location.projectDir, "compose.yaml"), "alt\n", "utf8");

  const drift = checkDrift(location.projectDir, null);
  assert.equal(drift.ok, false);
  if (drift.ok) return;
  assert.equal(drift.reason, "file-already-exists");

  const outcome = await applyCompose(ops(), {
    location,
    spec: spec(),
    imageRef: "x:1",
    basePath: base,
    expectedHash: null
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "file-already-exists");
  assert.equal(readComposeFile(location.projectDir).content, "alt\n");
});

test("nothing is written outside the base path", () => {
  const base = sandbox();
  assert.throws(
    () => writeComposeFile("/etc", "x", { expectedHash: null, basePath: base }),
    /lies outside/
  );
});

// --- Security review 5c: the file before the `up` --------------------------

test("checkDrift detects a file written from outside before every up", () => {
  // This is the guard that was missing on the recreate path. The chain was:
  // container mounts its own project directory -> writes privileged into the
  // compose.yaml -> recreate runs it -> host root.
  //
  // The mount is forbidden by now (spec.ts/hardening.ts). This check is the
  // second, independent half: no matter HOW a file deviates, it is no longer
  // taken blindly before running it.
  const base = sandbox();
  const location = locationFor("evil", base)!;
  fs.mkdirSync(location.projectDir, { recursive: true });
  const benign = "services:\n  evil:\n    image: 'x:1'\n";
  fs.writeFileSync(`${location.projectDir}/compose.yaml`, benign, "utf8");
  const known = hashOf(benign);

  assert.equal(checkDrift(location.projectDir, known).ok, true);

  fs.writeFileSync(
    `${location.projectDir}/compose.yaml`,
    "services:\n  evil:\n    image: 'x:1'\n    privileged: true\n    volumes: ['/:/host']\n",
    "utf8"
  );
  const drift = checkDrift(location.projectDir, known);
  assert.equal(drift.ok, false);
  if (drift.ok) return;
  assert.equal(drift.reason, "file-changed-externally");
});

test("a missing file on edit is a finding of its own", () => {
  const base = sandbox();
  const location = locationFor("minecraft", base)!;
  const drift = checkDrift(location.projectDir, "irgendein-hash");
  assert.deepEqual(drift, { ok: false, reason: "file-missing", currentHash: null });
});
