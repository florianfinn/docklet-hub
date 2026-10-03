import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DockerEngine } from "./engine.js";
import { foreignManagementOf, UNRAID_MANAGED_LABEL } from "./external-management.js";
import { toContainerSummary } from "./redact.js";

const COMPOSE = { "com.docker.compose.project": "media", "com.docker.compose.service": "web" };

test("native Unraid needs dockerman without Compose labels", () => {
  assert.deepEqual(foreignManagementOf({ [UNRAID_MANAGED_LABEL]: "dockerman" }, null), { manager: "unraid" });
});

test("the Compose Manager plugin needs composeman with a Compose project", () => {
  assert.deepEqual(foreignManagementOf({ [UNRAID_MANAGED_LABEL]: "composeman", ...COMPOSE }, null), {
    manager: "unraid-compose"
  });
});

test("contradicting or unknown claims stay managed as unknown", () => {
  const cases: Array<Record<string, string>> = [
    { [UNRAID_MANAGED_LABEL]: "dockerman", ...COMPOSE },
    { [UNRAID_MANAGED_LABEL]: "composeman" },
    { [UNRAID_MANAGED_LABEL]: "true" },
    { [UNRAID_MANAGED_LABEL]: "Dockerman" }
  ];
  for (const labels of cases) {
    assert.deepEqual(foreignManagementOf(labels, null), { manager: "unknown" }, JSON.stringify(labels));
  }
});

test("a claim the image carries itself is no proof of a manager", () => {
  assert.deepEqual(foreignManagementOf({ [UNRAID_MANAGED_LABEL]: "dockerman" }, "dockerman"), { manager: "unknown" });
  // The container overrode a different image value, so the value is its own.
  assert.deepEqual(foreignManagementOf({ [UNRAID_MANAGED_LABEL]: "dockerman" }, "composeman"), { manager: "unraid" });
});

test("an unreadable image leaves a claimed manager unknown", () => {
  assert.deepEqual(foreignManagementOf({ [UNRAID_MANAGED_LABEL]: "dockerman" }, undefined), { manager: "unknown" });
});

test("without a claim the container is not externally managed", () => {
  assert.equal(foreignManagementOf(COMPOSE, null), null);
  assert.equal(foreignManagementOf({}, undefined), null);
  assert.equal(foreignManagementOf(null, null), null);
  assert.equal(foreignManagementOf({ [UNRAID_MANAGED_LABEL]: "  " }, null), null);
});

test("the container summary classifies with the image label it is given", () => {
  const raw = {
    Id: "abc",
    Name: "/plex",
    Image: "sha256:feed",
    Config: { Image: "plex:1.2.3", Env: [], Labels: { [UNRAID_MANAGED_LABEL]: "dockerman" } },
    State: { Status: "running", Running: true }
  } as never;
  assert.deepEqual(toContainerSummary(raw, { imageManagerLabel: null }).externalManagement, { manager: "unraid" });
  assert.deepEqual(toContainerSummary(raw).externalManagement, { manager: "unknown" });
});

function socketPath(name: string): string {
  return process.platform === "win32"
    ? path.join(String.raw`\\.\pipe`, `agent-external-${process.pid}-${name}`)
    : path.join(os.tmpdir(), `agent-external-${process.pid}-${name}.sock`);
}

test("host discovery receives the manager label and the image id from the daemon", async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        {
          Id: "c1",
          Names: ["/plex"],
          Image: "plex:1.2.3",
          ImageID: "sha256:feed",
          State: "running",
          Labels: { [UNRAID_MANAGED_LABEL]: "dockerman", "org.example.secret": "hidden" }
        }
      ])
    );
  });
  const pathname = socketPath("list");
  await new Promise<void>((done) => server.listen(pathname, done));
  t.after(() => new Promise<void>((done) => void server.close(() => done())));

  const [container] = await new DockerEngine({ socketPath: pathname }).listWithComposeLabels();
  assert.ok(container);
  assert.equal(container.imageId, "sha256:feed");
  assert.deepEqual(container.labels, { [UNRAID_MANAGED_LABEL]: "dockerman" });
});

// The handlers need the runtime engine, so their use of the image check is
// verified as source text.
test("host discovery and both summaries verify the claim against the image", () => {
  const agentRoutes = fs.readFileSync(new URL("./routes/agent-routes.ts", import.meta.url), "utf8");
  const containerRoutes = fs.readFileSync(new URL("./routes/container-routes.ts", import.meta.url), "utf8");
  assert.match(agentRoutes, /foreignManagementOf\(\s*container\.labels,\s*await imageManagerLabelOf\(container\.labels, container\.imageId\)/);
  assert.match(agentRoutes, /imageManagerLabel: await imageManagerLabelOf\(inspect\.Config\?\.Labels, inspect\.Image\)/);
  assert.match(containerRoutes, /imageManagerLabel: await imageManagerLabelOf\(result\.inspect\.Config\?\.Labels, result\.inspect\.Image\)/);
});
