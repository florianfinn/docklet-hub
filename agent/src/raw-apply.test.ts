import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CANDIDATE_FILE_NAME } from "./compose-raw.js";
import { hashOf } from "./compose-store.js";
import {
  executeRawApply,
  inspectRawApply,
  planFromInspection,
  planRawApply,
  reportedTo,
  type RawApplyOps,
  type RawLocation,
  type RawStep
} from "./raw-apply.js";

// A real directory, but no real Docker: the file side should be tested as well
// (hash guard, rollback, candidate cleanup), the Compose side is injected.
//
// Paths are joined with "/" and not with path.join: normalizePath is
// deliberately pure posix (the agent runs exclusively on Linux), and a Windows
// separator would be a single path segment for isInsideBase. Same pattern as
// in compose-apply.test.ts.
function tempBase(): { base: string; project: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "raw-apply-"));
  const project = `${base}/projekt`;
  fs.mkdirSync(project);
  return { base: base, project };
}

const File = "docker-compose.yml";

type OpsPlan = {
  configResult?: unknown;
  configThrows?: boolean;
  ids?: Record<string, string>;
  idsAfterUp?: Record<string, string>;
  upThrows?: boolean;
  violations?: Record<string, string[]>;
  missingImages?: string[];
};

function fakeOps(plan: OpsPlan) {
  const logLine: string[] = [];
  const configProjectNames: Array<string | undefined> = [];
  let upCounter = 0;
  const ops: RawApplyOps = {
    async config(_projectDir, _composeFileName, projectName) {
      logLine.push("config");
      configProjectNames.push(projectName);
      if (plan.configThrows) throw new Error("yaml kaputt");
      return plan.configResult ?? { services: { web: { image: "nginx:1.27" } } };
    },
    async containerIds() {
      logLine.push("containerIds");
      const source = upCounter > 0 ? (plan.idsAfterUp ?? plan.ids ?? {}) : (plan.ids ?? {});
      return new Map(Object.entries(source));
    },
    async up() {
      upCounter += 1;
      logLine.push("up");
      if (plan.upThrows && upCounter === 1) throw new Error("up gescheitert");
      return "";
    },
    async down() {
      logLine.push("down");
    },
    async removeContainer(id) {
      logLine.push(`remove:${id}`);
    },
    async violationsOf(id) {
      logLine.push(`violationsOf:${id}`);
      return (plan.violations?.[id] ?? []) as never;
    },
    async runState() {
      return { running: true, restarting: false };
    },
    async missingImages() {
      logLine.push("missingImages");
      return plan.missingImages ?? [];
    }
  };
  return { ops, logLine, configProjectNames };
}

type Place = { base: string; project: string };

async function planFor(place: Place, ops: RawApplyOps, current: string[], content = "services:\n  web:\n") {
  const location: RawLocation = { projectDir: place.project, composeFileName: File };
  const plan = await planRawApply(ops, {
    location,
    content: content,
    basePath: place.base,
    currentServices: current
  });
  return { location, plan };
}

// --- Phase 1 ---------------------------------------------------------------

test("the draft is checked and then removed completely", async () => {
  const place = tempBase();
  const { ops } = fakeOps({});
  const { plan } = await planFor(place, ops, []);

  assert.equal(plan.ok, true);
  // No leftover draft: it does not carry a name Compose considers a project
  // file, but it would sit in the directory with the content of a possibly
  // refused edit.
  assert.equal(fs.existsSync(path.join(place.project, CANDIDATE_FILE_NAME)), false);
});

test("the fixed Compose project name also travels to the candidate check", async () => {
  const place = tempBase();
  const { ops, configProjectNames } = fakeOps({});
  const location: RawLocation = {
    projectDir: place.project,
    composeFileName: File,
    projectName: "bestand-prod"
  };
  const plan = await planRawApply(ops, {
    location,
    content: "services:\n  web:\n",
    basePath: place.base,
    currentServices: []
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(configProjectNames, ["bestand-prod"]);
});

test("even a broken file leaves no draft behind", async () => {
  const place = tempBase();
  const { ops } = fakeOps({ configThrows: true });
  const { plan } = await planFor(place, ops, []);

  assert.equal(plan.ok, false);
  assert.equal(plan.ok === false && plan.reason, "invalid-compose-file");
  assert.equal(fs.existsSync(path.join(place.project, CANDIDATE_FILE_NAME)), false);
  // Nothing real written.
  assert.equal(fs.existsSync(path.join(place.project, File)), false);
});

test("a service without an image is refused before writing", async () => {
  const place = tempBase();
  const { ops } = fakeOps({ configResult: { services: { web: { image: "nginx" }, worker: {} } } });
  const { plan } = await planFor(place, ops, []);
  assert.equal(plan.ok === false && plan.reason, "service-without-image");
});

test("the before state of the hardening is collected while the old containers are alive", async () => {
  const place = tempBase();
  const { ops } = fakeOps({
    ids: { web: "alt1" },
    violations: { alt1: ["socket-mount"] }
  });
  const { plan } = await planFor(place, ops, ["web"]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ok === true && plan.violationsBefore, [
    { serviceName: "web", rules: ["socket-mount"] }
  ]);
});

// --- The finding the verdict is based on (#85) -----------------------------

async function inspectFor(
  place: Place,
  ops: RawApplyOps,
  current: string[],
  content = "services:\n  web:\n"
) {
  return inspectRawApply(ops, {
    location: { projectDir: place.project, composeFileName: File },
    content: content,
    basePath: place.base,
    currentServices: current
  });
}

test("the finding names the reason for an unreadable file and leaves nothing behind", async () => {
  const place = tempBase();
  const { ops } = fakeOps({ configThrows: true });
  const inspection = await inspectFor(place, ops, []);

  assert.equal(inspection.configFailed, true);
  assert.equal(inspection.configError, "yaml kaputt");
  assert.equal(inspection.services, null);
  assert.equal(inspection.diff, null);
  assert.equal(fs.existsSync(path.join(place.project, CANDIDATE_FILE_NAME)), false);
  assert.equal(fs.existsSync(path.join(place.project, File)), false);
});

test("a service without an image stops the verdict, not the pure calculation", async () => {
  // Exactly the difference the preview depends on: the apply aborts here, the
  // preview should still say which services would come and go.
  const place = tempBase();
  const { ops, logLine } = fakeOps({
    configResult: { services: { web: { image: "nginx:1.27" }, worker: {} } },
    missingImages: ["nginx:1.27"]
  });
  const inspection = await inspectFor(place, ops, ["web"]);

  assert.deepEqual(inspection.servicesWithoutImage, ["worker"]);
  assert.deepEqual(inspection.diff, { remaining: ["web"], new: ["worker"], removed: [] });

  // ⚠️ And here the finding stops. The preview gets the diff for free (pure
  // calculation), but NO further call: if `missingImages` ran before this
  // refusal, an engine error would swap the named 400 for an exception — a
  // change of behaviour in the apply path, which should not change.
  assert.equal(inspection.missingImages, null);
  assert.deepEqual(logLine, ["config"]);

  const plan = planFromInspection(inspection);
  assert.equal(plan.ok === false && plan.reason, "service-without-image");
  assert.equal(plan.ok === false && plan.detail, "worker");
});

test("the finding names the missing images and the existing hardening state", async () => {
  const place = tempBase();
  const { ops } = fakeOps({
    configResult: { services: { web: { image: "nginx:1.27" } } },
    ids: { web: "alt1" },
    violations: { alt1: ["socket-mount — /var/run/docker.sock"] },
    missingImages: ["nginx:1.27"]
  });
  const inspection = await inspectFor(place, ops, ["web"]);

  assert.deepEqual(inspection.missingImages, ["nginx:1.27"]);
  assert.deepEqual(inspection.imagesByService, { web: "nginx:1.27" });
  assert.deepEqual(inspection.violationsBefore, [
    { serviceName: "web", rules: ["socket-mount — /var/run/docker.sock"] }
  ]);
  assert.equal(planFromInspection(inspection).ok, true);
});

test("preview and apply reach the same verdict on the same draft", async () => {
  // The point of the whole split: `planRawApply` is nothing other than
  // `planFromInspection` on the same finding. If one deviates from the other,
  // the preview promises something the apply does not keep — and silently,
  // because both paths are green on their own.
  const drafts: OpsPlan[] = [
    {},
    { configThrows: true },
    { configResult: { services: {} } },
    { configResult: { services: { web: { image: "nginx" }, worker: {} } } },
    { configResult: { services: { web: { image: "nginx" } } }, missingImages: ["nginx"] },
    { configResult: { services: { web: { image: "nginx" } } }, ids: { web: "alt1" }, violations: { alt1: ["socket-mount — /x"] } }
  ];
  for (const draft of drafts) {
    const fromInspection = planFromInspection(await inspectFor(tempBase(), fakeOps(draft).ops, ["web"]));
    const { plan: direct } = await planFor(tempBase(), fakeOps(draft).ops, ["web"]);
    assert.deepEqual(fromInspection, direct);
  }
});

// --- Phase 2 ---------------------------------------------------------------

async function finishedPlan(place: Place, ops: RawApplyOps, current: string[], content?: string) {
  const { location, plan } = await planFor(place, ops, current, content);
  assert.equal(plan.ok, true);
  return { location, plan: plan as Extract<typeof plan, { ok: true }> };
}

test("a new stack is written and resolved", async () => {
  const place = tempBase();
  const { ops } = fakeOps({ ids: {}, idsAfterUp: { web: "neu1" } });
  const { location, plan } = await finishedPlan(place, ops, []);

  const result = await executeRawApply(ops, {
    location,
    content: "services:\n  web:\n",
    basePath: place.base,
    expectedHash: null,
    plan,
    acceptedViolations: []
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.containerIds.web, "neu1");
  assert.equal(fs.readFileSync(path.join(place.project, File), "utf8"), "services:\n  web:\n");
});

test("the hash guard holds: a file changed by someone else is not overwritten", async () => {
  const place = tempBase();
  fs.writeFileSync(path.join(place.project, File), "von hand geaendert\n");
  const { ops, logLine } = fakeOps({ ids: { web: "alt1" }, idsAfterUp: { web: "neu1" } });
  const { location, plan } = await finishedPlan(place, ops, ["web"]);

  const result = await executeRawApply(ops, {
    location,
    content: "services:\n  web:\n",
    basePath: place.base,
    expectedHash: hashOf("ein ganz anderer stand\n"),
    plan,
    acceptedViolations: []
  });

  assert.equal(result.ok === false && result.reason, "file-changed-externally");
  // actualHash must carry the current state (S5/K2d) — the conflict dialog in
  // the editor needs it to offer "my version"/"file".
  assert.equal(result.ok === false && result.actualHash, hashOf("von hand geaendert\n"));
  // Nothing touched also means: no up.
  assert.equal(logLine.includes("up"), false);
  assert.equal(fs.readFileSync(path.join(place.project, File), "utf8"), "von hand geaendert\n");
});

test("a failed up rolls back to the previous version", async () => {
  const place = tempBase();
  const alt = "services:\n  web:\n    image: alt\n";
  fs.writeFileSync(path.join(place.project, File), alt);
  const { ops, logLine } = fakeOps({ ids: { web: "alt1" }, upThrows: true });
  const { location, plan } = await finishedPlan(place, ops, ["web"]);

  const result = await executeRawApply(ops, {
    location,
    content: "services:\n  web:\n    image: neu\n",
    basePath: place.base,
    expectedHash: hashOf(alt),
    plan,
    acceptedViolations: []
  });

  assert.equal(result.ok === false && result.reason, "compose-up-failed");
  assert.equal(result.ok === false && result.rolledBack, true);
  assert.equal(fs.readFileSync(path.join(place.project, File), "utf8"), alt);
  // Rolled back means: the old version is started again too.
  assert.equal(logLine.filter((entry) => entry === "up").length, 2);
});

test("a newly introduced hardening violation rolls back", async () => {
  const place = tempBase();
  const alt = "services:\n  web:\n";
  fs.writeFileSync(path.join(place.project, File), alt);
  const { ops } = fakeOps({
    ids: { web: "alt1" },
    idsAfterUp: { web: "neu1" },
    violations: { alt1: [], neu1: ["privileged"] }
  });
  const { location, plan } = await finishedPlan(place, ops, ["web"]);

  const result = await executeRawApply(ops, {
    location,
    content: "services:\n  web:\n    privileged: true\n",
    basePath: place.base,
    expectedHash: hashOf(alt),
    plan,
    acceptedViolations: []
  });

  assert.equal(result.ok === false && result.reason, "hardening-newly-violated");
  assert.deepEqual(result.ok === false && result.newViolations, ["web:privileged"]);
  assert.equal(fs.readFileSync(path.join(place.project, File), "utf8"), alt);
});

test("an existing violation does not block", async () => {
  const place = tempBase();
  const alt = "services:\n  dozzle:\n";
  fs.writeFileSync(path.join(place.project, File), alt);
  const { ops } = fakeOps({
    configResult: { services: { dozzle: { image: "amir20/dozzle" } } },
    ids: { dozzle: "alt1" },
    idsAfterUp: { dozzle: "neu1" },
    // socket-mount was there before and is there afterwards.
    violations: { alt1: ["socket-mount"], neu1: ["socket-mount"] }
  });
  const { location, plan } = await finishedPlan(place, ops, ["dozzle"]);

  const result = await executeRawApply(ops, {
    location,
    content: "services:\n  dozzle:\n    image: neu\n",
    basePath: place.base,
    expectedHash: hashOf(alt),
    plan,
    acceptedViolations: []
  });

  assert.equal(result.ok, true);
});

test("a confirmed new violation goes through", async () => {
  const place = tempBase();
  const alt = "services:\n  web:\n";
  fs.writeFileSync(path.join(place.project, File), alt);
  const { ops } = fakeOps({
    ids: { web: "alt1" },
    idsAfterUp: { web: "neu1" },
    violations: { alt1: [], neu1: ["privileged"] }
  });
  const { location, plan } = await finishedPlan(place, ops, ["web"]);

  const result = await executeRawApply(ops, {
    location,
    content: "services:\n  web:\n    privileged: true\n",
    basePath: place.base,
    expectedHash: hashOf(alt),
    plan,
    acceptedViolations: ["web:privileged"]
  });

  assert.equal(result.ok, true);
});

test("dropped containers are only removed AFTER a successful up", async () => {
  const place = tempBase();
  const alt = "services:\n  web:\n  worker:\n";
  fs.writeFileSync(path.join(place.project, File), alt);
  const { ops, logLine } = fakeOps({
    ids: { web: "alt1", worker: "alt2" },
    idsAfterUp: { web: "neu1" }
  });
  const { location, plan } = await finishedPlan(place, ops, ["web", "worker"]);
  assert.deepEqual(plan.diff.removed, ["worker"]);

  const result = await executeRawApply(ops, {
    location,
    content: "services:\n  web:\n",
    basePath: place.base,
    expectedHash: hashOf(alt),
    plan,
    acceptedViolations: []
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok === true && result.removedContainerIds, ["alt2"]);
  // The order is the point: until the successful up nothing destructive has
  // happened, so a failure costs no container.
  assert.ok(logLine.indexOf("up") < logLine.indexOf("remove:alt2"));
});

test("if the up fails, no dropped container is touched", async () => {
  const place = tempBase();
  const alt = "services:\n  web:\n  worker:\n";
  fs.writeFileSync(path.join(place.project, File), alt);
  const { ops, logLine } = fakeOps({
    ids: { web: "alt1", worker: "alt2" },
    upThrows: true
  });
  const { location, plan } = await finishedPlan(place, ops, ["web", "worker"]);

  const result = await executeRawApply(ops, {
    location,
    content: "services:\n  web:\n",
    basePath: place.base,
    expectedHash: hashOf(alt),
    plan,
    acceptedViolations: []
  });

  assert.equal(result.ok, false);
  assert.equal(logLine.some((entry) => entry.startsWith("remove:")), false);
  assert.equal(fs.readFileSync(path.join(place.project, File), "utf8"), alt);
});

test("on create the rollback removes the file again", async () => {
  const place = tempBase();
  const { ops, logLine } = fakeOps({ ids: {}, idsAfterUp: { web: "neu1" }, upThrows: true });
  const { location, plan } = await finishedPlan(place, ops, []);

  const result = await executeRawApply(ops, {
    location,
    content: "services:\n  web:\n",
    basePath: place.base,
    expectedHash: null,
    plan,
    acceptedViolations: []
  });

  assert.equal(result.ok === false && result.rolledBack, true);
  // A half-created stack is worse than none.
  assert.equal(logLine.includes("down"), true);
  assert.equal(fs.existsSync(path.join(place.project, File)), false);
});

// --- Der mitlaufende Bericht (#86) -----------------------------------------

test("the report names the steps in the order of the flow", async () => {
  const place = tempBase();
  const { ops } = fakeOps({ ids: {}, idsAfterUp: { web: "neu1" } });
  const { location, plan } = await finishedPlan(place, ops, []);

  const steps: RawStep[] = [];
  const result = await executeRawApply(ops, {
    location,
    content: "services:\n  web:\n",
    basePath: place.base,
    expectedHash: null,
    plan,
    acceptedViolations: [],
    onStep: (step) => steps.push(step)
  });

  assert.equal(result.ok, true);
  // The order IS the information — it tells the caller where the operation
  // stands. A report after the step it announces would be worthless: it would
  // come exactly when the waiting is over.
  assert.deepEqual(steps, [
    "resolve-containers",
    "write-file",
    "start",
    "resolve-containers",
    "check-hardening"
  ]);
  // No "clean-up": no service is dropped, and a line about zero containers
  // would claim an operation that does not take place.
  assert.equal(steps.includes("clean-up"), false);
});

test("a rollback reports itself as such", async () => {
  // The case #86 is written against: from outside a rollback looked exactly
  // like an `up` that is still running — both up to 300 s, both silent.
  // Together the worst case is beyond ten minutes.
  const place = tempBase();
  const { ops } = fakeOps({ ids: {}, idsAfterUp: { web: "neu1" }, upThrows: true });
  const { location, plan } = await finishedPlan(place, ops, []);

  const steps: RawStep[] = [];
  const result = await executeRawApply(ops, {
    location,
    content: "services:\n  web:\n",
    basePath: place.base,
    expectedHash: null,
    plan,
    acceptedViolations: [],
    onStep: (step) => steps.push(step)
  });

  assert.equal(result.ok === false && result.rolledBack, true);
  assert.deepEqual(steps, ["resolve-containers", "write-file", "start", "roll-back"]);
});

test("the cleanup reports itself as soon as a service is dropped", async () => {
  const place = tempBase();
  const alt = "services:\n  web:\n  worker:\n";
  fs.writeFileSync(path.join(place.project, File), alt);
  const { ops } = fakeOps({
    ids: { web: "alt1", worker: "alt2" },
    idsAfterUp: { web: "neu1" }
  });
  const { location, plan } = await finishedPlan(place, ops, ["web", "worker"]);

  const steps: RawStep[] = [];
  const result = await executeRawApply(ops, {
    location,
    content: "services:\n  web:\n",
    basePath: place.base,
    expectedHash: hashOf(alt),
    plan,
    acceptedViolations: [],
    onStep: (step) => steps.push(step)
  });

  assert.equal(result.ok, true);
  // And only after the hardening check: up to there every failure is without
  // consequences, afterwards containers disappear.
  assert.deepEqual(steps.slice(-2), ["check-hardening", "clean-up"]);
});

test("pulling an image names the ref", async () => {
  // The only step without a timeout. With several missing images it would
  // otherwise not be visible which one it hangs on.
  const detail: Array<string | undefined> = [];
  const report = reportedTo((_step, note) => detail.push(note));
  report("pull-images", "nginx:1.27");
  report("start");
  assert.deepEqual(detail, ["nginx:1.27", undefined]);
});

test("a throwing reporter does not stop the apply", async () => {
  // ⚠️ The most dangerous failure of this extension, and it is silent.
  //
  // The reporter writes into an HTTP response. If it threw — on a dropped
  // connection, after a change to `sendLine` — the exception would fly right
  // out of `executeRawApply`: the new Compose file is in place, the stack is
  // not running, and the rollback does not happen. An observer that destroys
  // the operation it is watching.
  const place = tempBase();
  const { ops } = fakeOps({ ids: {}, idsAfterUp: { web: "neu1" } });
  const { location, plan } = await finishedPlan(place, ops, []);

  let calls = 0;
  const result = await executeRawApply(ops, {
    location,
    content: "services:\n  web:\n",
    basePath: place.base,
    expectedHash: null,
    plan,
    acceptedViolations: [],
    onStep: () => {
      calls += 1;
      throw new Error("Verbindung weg");
    }
  });

  assert.ok(calls > 0, "the reporter was not called at all");
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.containerIds.web, "neu1");
  assert.equal(fs.readFileSync(path.join(place.project, File), "utf8"), "services:\n  web:\n");
});

test("without a reporter the operation runs silently", async () => {
  // The synchronous path sets none — it must run character for character as
  // before #86.
  const place = tempBase();
  const { ops } = fakeOps({ ids: {}, idsAfterUp: { web: "neu1" } });
  const { location, plan } = await finishedPlan(place, ops, []);

  const result = await executeRawApply(ops, {
    location,
    content: "services:\n  web:\n",
    basePath: place.base,
    expectedHash: null,
    plan,
    acceptedViolations: []
  });
  assert.equal(result.ok, true);
});
