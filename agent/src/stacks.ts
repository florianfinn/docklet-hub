// Stack discovery and adoption (stage 5d).
//
// Until 5c the agent only knew containers the dashboard had created itself.
// The existing setup — 37 containers on the live server — was invisible. This
// file answers the question "what is actually here?", and in such a way that
// the answer also names the awkward cases instead of leaving them out.
//
// Deliberately pure: no file system, no process start, no engine. What is
// needed from the file system (does the directory exist? which directories
// are there?) comes in as a parameter. That keeps the grouping logic testable
// without Docker — the same separation as in compose.ts.

import { composeContextOf, isInsideBase } from "./compose.js";
import { normalizePath } from "./hardening.js";

// Directories that carry the operation of the dashboard itself.
//
// A stack from here may only be adopted READ-ONLY: otherwise the API could
// stop itself, its database, the agent or the ingress — and would thereby at
// the same time have taken away its own ability to undo that. On the live
// server that is 13 of the 37 containers (projects "dashboard" and "edge").
//
// The same paths appear in hardening.ts (DASHBOARD_SELF_PATHS, formerly in
// SENSITIVE_HOST_PREFIXES), but with a different meaning there (bind
// sources). Deliberately kept separate: a list that answers two questions at
// once becomes wrong for one of them with the next change.
const SELF_MANAGEMENT_PREFIXES = ["/home/docker/dashboard-repo", "/home/docker/dashboard-state"];

export type Management = "full" | "read-only";

export function forcedManagement(projectDir: string): Management {
  const normalized = normalizePath(projectDir);
  const self = SELF_MANAGEMENT_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`)
  );
  return self ? "read-only" : "full";
}

export type StackService = {
  serviceName: string;
  containerName: string;
  containerId: string;
  status: string;
  image: string;
};

export type DiscoveredStack = {
  projectDir: string;
  projectName: string;
  composeFileName: string;
  management: Management;
  // Whether the compose file actually lies at its location. false means: the
  // containers are running, their definition is gone.
  filePresent: boolean;
  services: StackService[];
};

// What could NOT be assigned cleanly. This is not an error channel but a
// result: the survey on the live server showed that a considerable part of
// the existing setup lands exactly here (four projects whose directory no
// longer exists; a container with project labels without any file reference;
// two-year-old corpses).
//
// Leaving them out would be worse than naming them: a list that shows 30
// instead of 37 containers looks complete.
export type Finding = {
  kind:
    | "container-without-compose-labels"
    | "container-without-directory"
    | "stack-outside-base-path"
    | "directory-without-container";
  containerId: string | null;
  containerName: string | null;
  projectDir: string | null;
  detail: string;
};

export type DiscoveryInput = {
  containers: Array<{
    id: string;
    name: string;
    image: string;
    status: string;
    labels: Record<string, string>;
  }>;
  basePath: string;
  // Returns true if the project directory including the compose file exists.
  directoryHasFile: (projectDir: string, composeFileName: string) => boolean;
  // All directories directly below the base path that contain a compose file
  // — for the finding "directory without container".
  directoriesWithFile: string[];
};

export type DiscoveryResult = {
  stacks: DiscoveredStack[];
  findings: Finding[];
};

export function discoverStacks(input: DiscoveryInput): DiscoveryResult {
  const stacks = new Map<string, DiscoveredStack>();
  const findings: Finding[] = [];

  for (const container of input.containers) {
    const context = composeContextOf(container.labels, input.basePath);

    if (!context) {
      findings.push(singleFinding(container, input.basePath));
      continue;
    }

    let stack = stacks.get(context.projectDir);
    if (!stack) {
      const fileExists = input.directoryHasFile(context.projectDir, context.composeFileName);
      stack = {
        projectDir: context.projectDir,
        projectName: context.project,
        composeFileName: context.composeFileName,
        management: forcedManagement(context.projectDir),
        filePresent: fileExists,
        services: []
      };
      stacks.set(context.projectDir, stack);

      if (!fileExists) {
        findings.push({
          kind: "container-without-directory",
          containerId: container.id,
          containerName: container.name,
          projectDir: context.projectDir,
          detail: `The containers are running, but ${context.projectDir}/${context.composeFileName} does not exist.`
        });
      }
    }

    stack.services.push({
      serviceName: context.serviceName,
      containerName: container.name,
      containerId: container.id,
      status: container.status,
      image: container.image
    });
  }

  // The opposite direction: a definition for which no container is currently
  // running. On the live server these include archisteamfarm and paperlessngx.
  const acquired = new Set(stacks.keys());
  for (const dir of input.directoriesWithFile) {
    const normalized = normalizePath(dir);
    if (acquired.has(normalized)) continue;
    findings.push({
      kind: "directory-without-container",
      containerId: null,
      containerName: null,
      projectDir: normalized,
      detail: "A compose file without a running or stopped container."
    });
  }

  return {
    stacks: [...stacks.values()].sort((a, b) => a.projectDir.localeCompare(b.projectDir)),
    findings
  };
}

function singleFinding(
  container: { id: string; name: string; labels: Record<string, string> },
  basePath: string
): Finding {
  const workingDir = container.labels["com.docker.compose.project.working_dir"];

  // Compose labels present, but the directory lies outside the base path. The
  // container is therefore not adoptable — the agent writes and reads only
  // below the base path, as a matter of principle.
  if (workingDir && !isInsideBase(workingDir, basePath)) {
    return {
      kind: "stack-outside-base-path",
      containerId: container.id,
      containerName: container.name,
      projectDir: normalizePath(workingDir),
      detail: `Project directory lies outside ${basePath}.`
    };
  }

  // No compose reference (or an incomplete one). On the live server this
  // applies to `elegant_bartik`, among others: project and service label
  // present, but neither working_dir nor config_files.
  return {
    kind: "container-without-compose-labels",
    containerId: container.id,
    containerName: container.name,
    projectDir: workingDir ? normalizePath(workingDir) : null,
    detail: workingDir
      ? "Compose labels incomplete — no unambiguous file reference."
      : "Container without compose management."
  };
}
