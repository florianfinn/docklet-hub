import assert from "node:assert/strict";
import test from "node:test";
import { projectLockKey } from "./project-lock.js";
import { handlerSource } from "./handler-source-test-support.js";
test("registry anchor wins for files, Compose, container and definition label drift", () => {
  assert.equal(projectLockKey({ registryProject: "registered", labelProject: "moved", projectName: "moved", containerId: "id" }), "registered");
  assert.equal(projectLockKey({ labelProject: "labels", containerId: "id" }), "labels");
  assert.equal(projectLockKey({ registryProject: "", labelProject: "labels", containerId: "id" }), "labels");
  assert.equal(projectLockKey({ containerId: "id" }), "container:id");
  assert.equal(projectLockKey({ projectName: "new", projectDir: "/srv/apps/new" }), "new");
  assert.equal(projectLockKey({ projectDir: "/srv/apps/new" }), "project-dir:/srv/apps/new");
});
test("file, env, raw and structured apply share the project key helper", () => {
  const source = handlerSource();
  for (const name of ["withFileLock", "handleEnv", "rawLockKey"]) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf("\n}\n", start);
    assert.ok(start >= 0 && end > start, name);
    assert.match(source.slice(start, end), /projectLockKey\(/, name);
  }
  assert.equal(source.match(/stackLocks\.runExclusive\(projectLockKey\(\{ registryProject: registry\.get\(containerId\)/g)?.length, 2);
});

test("container actions also use the registered anchor through the shared helper", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(new URL("container-action.ts", import.meta.url), "utf8");
  assert.match(source, /projectLockKey\(\{ registryProject: registry\.get\(containerId\)\?\.compose\?\.projectName/);
  assert.match(source, /stackLocks\.runExclusive\(lockKey,/);
});
