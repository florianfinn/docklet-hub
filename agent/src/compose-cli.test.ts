import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDependencySafeRestartArgs,
  buildDownArgs,
  buildRmArgs,
  buildSafeStackActionArgs,
  buildUpArgs,
  composeDependencySafeRestart,
  ownProject
} from "./compose-cli.js";
import { UPDATE_ROLLBACK_OVERRIDE_FILE_NAME } from "./compose-store.js";

// Follow-up to security review 5d.
//
// Authorization in this system is per CONTAINER — `gate()` only ever checks
// the one container the caller named. `docker compose up` without a service
// argument, on the other hand, acts on EVERY service in the file. For the
// self-created single-service stacks from 5c the two coincided; with adopted
// multi-service stacks they no longer do.
//
// These tests pin down the argument building, because it is the place where
// the reach of the action is decided.
const PROJECT = ownProject("/home/docker/homepage");

test("without a service, the up applies to the whole project", () => {
  const args = buildUpArgs(PROJECT, { removeOrphans: false });
  assert.equal(args.at(-1), "--wait");
  assert.equal(args.includes("--remove-orphans"), false);
});

test("with a service, the service stands at the end", () => {
  // At the end, because Compose reads everything after the flags as service
  // names — an argument behind it would be a second service.
  const args = buildUpArgs(PROJECT, { removeOrphans: false, serviceName: "homepage" });
  assert.equal(args.at(-1), "homepage");
  assert.equal(args.at(-2), "--");
});

test("removeOrphans and service scoping do not exclude each other", () => {
  const args = buildUpArgs(PROJECT, { removeOrphans: true, serviceName: "homepage" });
  assert.equal(args.at(-1), "homepage");
  assert.equal(args.includes("--remove-orphans"), true);
});

// The bolt against the outage of 2026-08-25: without --force-recreate,
// `up -d` leaves alone every container whose image and configuration stayed
// the same — including one that hangs via `network_mode: container:<X>` on an
// X that was just replaced and afterwards sits in a dead netns.
test("forceRecreate stands as a flag before the options separator", () => {
  const args = buildUpArgs(PROJECT, { removeOrphans: false, forceRecreate: true });
  assert.equal(args.includes("--force-recreate"), true);
  assert.equal(args.includes("--"), false);
});

test("without forceRecreate the flag stays out", () => {
  assert.equal(buildUpArgs(PROJECT, { removeOrphans: false }).includes("--force-recreate"), false);
});

test("the file is passed as an absolute path under the project directory", () => {
  // This way the file name can never be read as a flag: the value always
  // starts with the base path.
  const args = buildUpArgs(
    { projectDir: "/home/docker/tautulli", composeFileName: "docker-compose.yml" },
    { removeOrphans: false }
  );
  const fileIndex = args.indexOf("--file");
  assert.notEqual(fileIndex, -1);
  assert.equal(args[fileIndex + 1], "/home/docker/tautulli/docker-compose.yml");
});

test("the raw path forbids Compose from pulling on its own", () => {
  // Stage 7: a pasted file carries no `pull_policy: never` (only our emitter
  // writes that). Without the bolt Compose would pull missing images in
  // passing — foreign code on the host as a side effect of a text edit.
  const args = buildUpArgs(PROJECT, { removeOrphans: false, pullNever: true });
  const index = args.indexOf("--pull");
  assert.notEqual(index, -1);
  assert.equal(args[index + 1], "never");
});

test("--pull never stands before the options separator and service name", () => {
  // Compose reads everything after the flags as service names. A flag behind
  // the service would be a second service.
  const args = buildUpArgs(PROJECT, { removeOrphans: false, pullNever: true, serviceName: "web" });
  assert.equal(args.at(-1), "web");
  assert.deepEqual(args.slice(-2), ["--", "web"]);
  assert.ok(args.indexOf("--pull") < args.length - 2);
});

test("a service-scoped up can block dependencies as a side effect", () => {
  const args = buildUpArgs(PROJECT, {
    removeOrphans: false,
    pullNever: true,
    noDeps: true,
    serviceName: "web"
  });
  assert.equal(args.at(-1), "web");
  assert.deepEqual(args.slice(-2), ["--", "web"]);
  assert.ok(args.indexOf("--no-deps") < args.length - 2);
});

test("S12 rollback includes exactly the fixed override file before the up", () => {
  const args = buildUpArgs(PROJECT, {
    removeOrphans: false,
    pullNever: true,
    noDeps: true,
    forceRecreate: true,
    rollbackOverride: true,
    serviceName: "web"
  });
  const fileArgs = args
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry === "--file")
    .map(({ index }) => args[index + 1]);
  assert.deepEqual(fileArgs, [
    "/home/docker/homepage/compose.yaml",
    `/home/docker/homepage/${UPDATE_ROLLBACK_OVERRIDE_FILE_NAME}`
  ]);
  assert.ok(args.indexOf("--force-recreate") < args.indexOf("--"));
  assert.deepEqual(args.slice(-2), ["--", "web"]);
});

test("without pullNever the behaviour stays unchanged", () => {
  assert.equal(buildUpArgs(PROJECT, { removeOrphans: true }).includes("--pull"), false);
});

test("never a shell, never a joined string", () => {
  // The rule from 3.2: arguments individually in the array. An argument with
  // spaces stays ONE argument.
  const args = buildUpArgs(PROJECT, { removeOrphans: false, serviceName: "mit leerzeichen" });
  assert.equal(args.at(-1), "mit leerzeichen");
  assert.equal(args.some((entry) => entry.includes("&&") || entry.includes(";")), false);
});

test("flag-like service names cannot extend up and rm", () => {
  const up = buildUpArgs(PROJECT, {
    removeOrphans: false,
    noDeps: true,
    serviceName: "--remove-orphans"
  });
  assert.deepEqual(up.slice(-2), ["--", "--remove-orphans"]);
  assert.equal(up.filter((entry) => entry === "--remove-orphans").length, 1);

  const rm = buildRmArgs(PROJECT, "--volumes");
  assert.deepEqual(rm.slice(-2), ["--", "--volumes"]);
  assert.equal(rm.filter((entry) => entry === "--volumes").length, 1);
});

const STACK_PROJECT = {
  projectDir: "/home/docker/homepage",
  composeFileName: "docker-compose.yml",
  projectName: "homepage-prod"
};

test("stack actions bind the fixed project name from the registry", () => {
  const args = buildSafeStackActionArgs(STACK_PROJECT, "restart");
  const index = args.indexOf("--project-name");
  assert.notEqual(index, -1);
  assert.equal(args[index + 1], "homepage-prod");
  assert.equal(args.at(-1), "restart");
});

test("stack start/stop/restart can neither build nor pull nor delete volumes", () => {
  for (const action of ["start", "stop", "restart"] as const) {
    const args = buildSafeStackActionArgs(STACK_PROJECT, action);
    assert.equal(args.includes("--build"), false);
    assert.equal(args.includes("build"), false);
    assert.equal(args.includes("pull"), false);
    assert.equal(args.includes("--volumes"), false);
    assert.equal(args.includes("-v"), false);
  }
});

test("coupled stack restart stops first and starts in order with a health wait condition", () => {
  const [stop, start] = buildDependencySafeRestartArgs(STACK_PROJECT);
  assert.equal(stop.at(-1), "stop");
  assert.deepEqual(start.slice(-2), ["start", "--wait"]);
  for (const args of [stop, start]) {
    assert.equal(args[args.indexOf("--project-name") + 1], "homepage-prod");
    assert.equal(args.includes("up"), false);
    assert.equal(args.includes("pull"), false);
    assert.equal(args.includes("build"), false);
    assert.equal(args.includes("down"), false);
    assert.equal(args.includes("--volumes"), false);
    assert.equal(args.includes("--remove-orphans"), false);
  }
});

test("a stop error does not prevent the subsequent healing start", async () => {
  const calls: string[][] = [];
  const stopError = new Error("stop fehlgeschlagen");
  await assert.rejects(
    composeDependencySafeRestart(STACK_PROJECT, async (args) => {
      calls.push(args);
      if (args.at(-1) === "stop") throw stopError;
      return { stdout: "", stderr: "" };
    }),
    stopError
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.at(-1), "stop");
  assert.deepEqual(calls[1]?.slice(-2), ["start", "--wait"]);
});

test("the safe restart runs both phases one after the other and collects stderr", async () => {
  const calls: string[] = [];
  const stderr = await composeDependencySafeRestart(STACK_PROJECT, async (args) => {
    const action = args.includes("stop") ? "stop" : "start";
    calls.push(action);
    return { stdout: "", stderr: `${action}-ausgabe` };
  });
  assert.deepEqual(calls, ["stop", "start"]);
  assert.equal(stderr, "stop-ausgabe\nstart-ausgabe");
});

test("errors of both restart phases remain diagnosable together", async () => {
  await assert.rejects(
    composeDependencySafeRestart(STACK_PROJECT, async (args) => {
      throw new Error(args.includes("stop") ? "stop-fehler" : "start-fehler");
    }),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.some((entry) => entry instanceof Error && entry.message === "stop-fehler") &&
      error.errors.some((entry) => entry instanceof Error && entry.message === "start-fehler")
  );
});

test("stack down never removes volumes and keeps the fixed project name", () => {
  const args = buildDownArgs(STACK_PROJECT);
  assert.equal(args.at(-1), "down");
  assert.equal(args.includes("--volumes"), false);
  assert.equal(args.includes("-v"), false);
  assert.equal(args[args.indexOf("--project-name") + 1], "homepage-prod");
});

test("stack apply/up forbids build and pull and removes no orphans", () => {
  const args = buildUpArgs(STACK_PROJECT, { removeOrphans: false, pullNever: true });
  assert.equal(args.includes("--no-build"), true);
  assert.deepEqual(args.slice(args.indexOf("--pull"), args.indexOf("--pull") + 2), ["--pull", "never"]);
  assert.equal(args.includes("--remove-orphans"), false);
  assert.equal(args.includes("--volumes"), false);
  assert.equal(args[args.indexOf("--project-name") + 1], "homepage-prod");
});
