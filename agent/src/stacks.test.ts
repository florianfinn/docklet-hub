import assert from "node:assert/strict";
import test from "node:test";
import { discoverStacks, forcedManagement } from "./stacks.js";

const Base = "/home/docker";

// Modelled on the survey on the live server (2026-07-21). The cases are not
// made up: every single one exists like this on the host.
function container(
  name: string,
  labels: Record<string, string>,
  status = "running"
): {
  id: string;
  name: string;
  image: string;
  status: string;
  labels: Record<string, string>;
} {
  return { id: `id-${name}`, name, image: "x:1", status, labels };
}

function composeLabels(project: string, service: string, dir: string, file = "compose.yaml") {
  return {
    "com.docker.compose.project": project,
    "com.docker.compose.service": service,
    "com.docker.compose.project.working_dir": dir,
    "com.docker.compose.project.config_files": `${dir}/${file}`
  };
}

test("services of the same directory end up in ONE stack", () => {
  // homepage: two services, and for neither is the container name the
  // service name. That is exactly where the 5c assumption breaks.
  const result = discoverStacks({
    containers: [
      container("homepage", composeLabels("homepage", "homepage", "/home/docker/homepage")),
      container(
        "homepage_code-server",
        composeLabels("homepage", "code-server", "/home/docker/homepage")
      )
    ],
    basePath: Base,
    isHubOwned: () => false,
    directoryHasFile: () => true,
    directoriesWithFile: []
  });

  assert.equal(result.stacks.length, 1);
  assert.deepEqual(result.stacks[0].services.map((s) => s.serviceName), ["homepage", "code-server"]);
  assert.deepEqual(result.stacks[0].services.map((s) => s.containerName), [
    "homepage",
    "homepage_code-server"
  ]);
  assert.equal(result.findings.length, 0);
});

test("the dashboard's own stack is forced to read-only", () => {
  // Otherwise the API could stop itself, its database or the ingress — and
  // would thereby at the same time have lost the ability to undo that.
  assert.equal(forcedManagement("/home/docker/dashboard-repo"), "read-only");
  assert.equal(forcedManagement("/home/docker/dashboard-repo/edge"), "read-only");
  assert.equal(forcedManagement("/home/docker/dashboard-state"), "read-only");
  assert.equal(forcedManagement("/home/docker/homepage"), "full");
  // No prefix match on a name that merely starts like that.
  assert.equal(forcedManagement("/home/docker/dashboard-repository"), "full");

  const result = discoverStacks({
    containers: [
      container("edge-traefik-1", composeLabels("edge", "traefik", "/home/docker/dashboard-repo/edge", "docker-compose.yml"))
    ],
    basePath: Base,
    isHubOwned: () => false,
    directoryHasFile: () => true,
    directoriesWithFile: []
  });
  assert.equal(result.stacks[0].management, "read-only");
});

// The finding from the self-review after 5d: "read-only" was at first only a
// column in the database and was checked nowhere on the ACTION PATH. Enabling
// it in the allowlist would have been enough to open stop/recreate/remove on
// exactly the containers that carry the dashboard itself.
//
// The lock now hangs on the container's working_dir label and therefore on a
// self-derived value — not on the management level that would come in via
// the sync.
test("the self-management lock applies on every path below the own directory", () => {
  for (const dir of [
    "/home/docker/dashboard-repo",
    "/home/docker/dashboard-repo/edge",
    "/home/docker/dashboard-repo/edge/tiefer",
    "/home/docker/dashboard-state"
  ]) {
    assert.equal(forcedManagement(dir), "read-only", dir);
  }
  // And no more than that: a neighbouring directory that merely starts like
  // that stays fully manageable.
  for (const dir of ["/home/docker/dashboard-repository", "/home/docker/homepage", "/home/docker/edge"]) {
    assert.equal(forcedManagement(dir), "full", dir);
  }
  // Path normalisation: the detour via ".." must not bypass the lock.
  assert.equal(forcedManagement("/home/docker/homepage/../dashboard-repo"), "read-only");
});

test("a container without a project directory is reported as a finding, not left out", () => {
  // Four projects on the live server are like this: the containers exist, the
  // directory in the working_dir label no longer does (chibisafe, netbird,
  // test_nginx, ts3musicbot).
  const result = discoverStacks({
    containers: [
      container("test_nginx", composeLabels("test_nginx", "nginx", "/home/docker/test_nginx"), "exited")
    ],
    basePath: Base,
    isHubOwned: () => false,
    directoryHasFile: () => false,
    directoriesWithFile: []
  });

  assert.equal(result.stacks.length, 1);
  assert.equal(result.stacks[0].filePresent, false);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].kind, "container-without-directory");
});

test("a container without any compose reference is named", () => {
  // `elegant_bartik` on the live server: project and service label present,
  // but neither working_dir nor config_files.
  const result = discoverStacks({
    containers: [
      container("elegant_bartik", {
        "com.docker.compose.project": "tsrank",
        "com.docker.compose.service": "ranksystem"
      }, "exited"),
      container("fremd", {}, "running")
    ],
    basePath: Base,
    isHubOwned: () => false,
    directoryHasFile: () => true,
    directoriesWithFile: []
  });

  assert.equal(result.stacks.length, 0);
  assert.deepEqual(result.findings.map((b) => b.kind), [
    "container-without-compose-labels",
    "container-without-compose-labels"
  ]);
});

test("a stack outside the base path is not adoptable and says so", () => {
  const result = discoverStacks({
    containers: [container("fremd", composeLabels("fremd", "fremd", "/opt/stacks/fremd"))],
    basePath: Base,
    isHubOwned: () => false,
    directoryHasFile: () => true,
    directoriesWithFile: []
  });

  assert.equal(result.stacks.length, 0);
  assert.equal(result.findings[0].kind, "stack-outside-base-path");
  assert.equal(result.findings[0].projectDir, "/opt/stacks/fremd");
});

test("a definition without a container is the opposite direction of the same finding", () => {
  // archisteamfarm and paperlessngx on the live server: compose file present,
  // no container.
  const result = discoverStacks({
    containers: [container("homepage", composeLabels("homepage", "homepage", "/home/docker/homepage"))],
    basePath: Base,
    isHubOwned: () => false,
    directoryHasFile: () => true,
    directoriesWithFile: ["/home/docker/homepage", "/home/docker/paperlessngx"]
  });

  assert.equal(result.stacks.length, 1);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].kind, "directory-without-container");
  assert.equal(result.findings[0].projectDir, "/home/docker/paperlessngx");
});

// ⚠️ The findings go out unchanged (`routes/stack-routes.ts`: `findings`),
// the dashboard renders the finding's `kind`. A German key leaves the column empty
// without anything turning red — hence the shape, not just the value.
test("the finding shape carries the English keys", () => {
  const result = discoverStacks({
    containers: [container("elegant_bartik", {})],
    basePath: Base,
    isHubOwned: () => false,
    directoryHasFile: () => true,
    directoriesWithFile: ["/home/docker/paperlessngx"]
  });

  assert.equal(result.findings.length, 2);
  for (const finding of result.findings) {
    assert.deepEqual(Object.keys(finding).sort(), [
      "containerId",
      "containerName",
      "detail",
      "kind",
      "projectDir"
    ]);
  }
});

test("a project carries the agent's ownership marker as hubOwned", () => {
  const result = discoverStacks({
    containers: [
      container("notes", composeLabels("notes", "app", "/home/docker/notes")),
      container("foreign", composeLabels("foreign", "app", "/home/docker/foreign"))
    ],
    basePath: Base,
    isHubOwned: (projectDir) => projectDir === "/home/docker/notes",
    directoryHasFile: () => true,
    directoriesWithFile: []
  });

  assert.deepEqual(
    result.stacks.map((stack) => [stack.projectName, stack.hubOwned]),
    [["foreign", false], ["notes", true]]
  );
});
