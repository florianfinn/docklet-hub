// Invocation of `docker compose` (stage 5c).
//
// ⚠️ Refinement of the rule "never shell exec" (stage plan 3.2, open point 2
// from 6.2). The rule explicitly means STRING CONCATENATION INTO A SHELL —
// that is where command injection arises, because quotes, semicolons and
// backticks are interpreted by the interpreter.
//
// `execFile` with an argument ARRAY on a fixed binary is something else:
// there is no interpreter that could interpret anything. An argument stays an
// argument, no matter what it contains. Hence here exclusively:
//
//   - execFile, NEVER exec/spawn with shell: true
//   - fixed binary "docker", never assembled from an input
//   - arguments individually in the array, never joined into a string
//   - no `cwd` from an input: the project directory goes along as
//     --project-directory, and it is checked against the base path beforehand
//
// Compose is not part of the engine API and could not be rebuilt over the
// socket — at least not without duplicating its naming, label and
// dependency logic. A second, slightly divergent interpretation of the same
// file would be worse than this process start.

import { execFile } from "node:child_process";
import { COMPOSE_FILE_NAME, UPDATE_ROLLBACK_OVERRIDE_FILE_NAME } from "./compose.js";

const DOCKER_BINARY = "docker";

// The agent runs with a read-only rootfs. Otherwise the Docker CLI creates
// its configuration under $HOME/.docker and fails on that.
const CLI_ENV = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/tmp",
  DOCKER_CONFIG: "/tmp/.docker"
};

export class ComposeError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code: number | null
  ) {
    super(message);
    this.name = "ComposeError";
  }
}

type RunOptions = { timeoutMs: number; maxBuffer?: number };

function run(args: string[], options: RunOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      DOCKER_BINARY,
      args,
      {
        env: CLI_ENV,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
        // Explicitly: no shell. The default of execFile is already
        // shell:false — it is stated here so that a later switch is a visible
        // change and not a silent omission.
        shell: false
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : null;
          // Compose's stderr names paths and image refs. It goes into the error
          // (and thus into the agent's container log), but the routes decide
          // themselves what of it may go to the outside.
          reject(new ComposeError(`docker ${args.join(" ")} failed`, String(stderr ?? ""), code));
          return;
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      }
    );
  });
}

// A compose project is directory PLUS file name.
//
// ⚠️ Up to 5c the file name was the constant COMPOSE_FILE_NAME. That only
// worked as long as exclusively files created by the dashboard were touched.
// In the existing inventory all three usual names occur — compose.yaml,
// docker-compose.yml and docker-compose.yaml —, and a `--file` on the wrong
// name is not a failure with a clear message, but looks like "project does
// not exist".
export type ComposeProject = {
  projectDir: string;
  composeFileName: string;
  // The explicit compose project name (S11). Existing, service-related
  // callers may omit it for compatibility reasons. Stack actions, however, MUST
  // set it from their own registry copy: only that way does the project
  // identity stay stable even when the directory name and
  // `com.docker.compose.project` differ.
  projectName?: string;
};

// For everything the dashboard created itself: there the name is always
// COMPOSE_FILE_NAME, because the emitter writes it.
export function ownProject(projectDir: string): ComposeProject {
  return { projectDir, composeFileName: COMPOSE_FILE_NAME };
}

// All calls bind to ONE project directory and ONE file. The project name
// comes from the directory name (compose default) — that is exactly the
// anchor that replaces the container id (6.3.1).
function projectArgs(project: ComposeProject, includeRollbackOverride = false): string[] {
  const args = [
    "compose",
    "--project-directory",
    project.projectDir,
    "--file",
    `${project.projectDir}/${project.composeFileName}`
  ];
  if (includeRollbackOverride) {
    args.push("--file", `${project.projectDir}/${UPDATE_ROLLBACK_OVERRIDE_FILE_NAME}`);
  }
  if (project.projectName) args.push("--project-name", project.projectName);
  return args;
}

// Reads the file with Compose's own parser and returns it normalized as
// JSON. Read-only: `config` starts nothing and changes nothing.
export async function composeConfig(project: ComposeProject): Promise<unknown> {
  const { stdout } = await run([...projectArgs(project), "config", "--format", "json"], {
    timeoutMs: 30_000
  });
  return JSON.parse(stdout) as unknown;
}

export type UpOptions = {
  // ⚠️ Only for stacks whose file the dashboard writes itself.
  //
  // --remove-orphans removes every container of the project that the file no
  // longer (or never) names. For a self-generated single-service file that is
  // cleanup after a rename. For an ADOPTED file it would be data loss: the
  // dashboard may not know all services there, and `homepage` would thus have
  // lost its second container (code-server) on the first `up`.
  removeOrphans: boolean;

  // Which service the `up` is restricted to. If the value is missing, it
  // applies to the WHOLE project.
  //
  // ⚠️ This is a question of permissions, not of convenience (security review
  // 5d). The authorization of this system is per CONTAINER: grants hang on the
  // container_id, and the agent's allowlist check only ever sees the one
  // container the caller named. `docker compose up` without a service argument,
  // however, acts on EVERY service of the file.
  //
  // With the self-generated single-service stacks from 5c the two coincided.
  // With adopted multi-service stacks no longer: a recreate on `homepage` would
  // have started `homepage_code-server` as well — a container the caller never
  // named, which need not be allowlisted and which never goes through the
  // hardening check after the `up`.
  //
  // The same consideration as for removal, where `composeRm` sits next to
  // `composeDown` for exactly this reason.
  serviceName?: string;

  // Forbids Compose to pull missing images itself (stage 7).
  //
  // ⚠️ Not the same as `pull_policy: never` in the file — only our own emitter
  // (compose.ts) writes that. An ADOPTED file or one inserted by the operator
  // typically does not carry it, and then Compose pulls missing images
  // incidentally on `up`.
  //
  // The moment foreign code arrives on the host is supposed to stay an explicit
  // and logged step (stage plan 3.6) and not a side effect of a text edit. If
  // an image is missing, the `up` then fails cleanly instead of pulling
  // silently.
  pullNever?: boolean;

  // With a service-related `up`, dependencies must not be started or
  // recreated as a side effect. Without --no-deps a service argument would
  // not yet be a real authorization boundary.
  noDeps?: boolean;

  // S12: a second compose file generated by the agent itself pins exactly ONE
  // service to the previous image id on rollback. No free path: the file name
  // is a constant under the checked project directory.
  rollbackOverride?: boolean;

  // On rollback Compose should restore the previous digest even if it
  // mistakenly considers the current state identical.
  forceRecreate?: boolean;
  noRecreate?: boolean;
  wait?: boolean;
  timeoutMs?: number;
};

// Extracted so that the reach of the action can be tested without a running
// Docker: whether a service argument is set decides the question "one
// container or the whole stack" — and thus a question of permissions.
export function buildUpArgs(project: ComposeProject, options: UpOptions): string[] {
  // --no-build: nothing is ever built here, only an image is started. A
  // `build:` in a hand-edited file would otherwise execute arbitrary code from
  // a Dockerfile on the host.
  const args = [
    ...projectArgs(project, options.rollbackOverride === true),
    "up",
    "--detach",
    "--no-build"
  ];
  if (options.wait !== false) args.push("--wait");
  if (options.noRecreate) args.push("--no-recreate");
  if (options.removeOrphans) args.push("--remove-orphans");
  if (options.pullNever) args.push("--pull", "never");
  if (options.noDeps) args.push("--no-deps");
  if (options.forceRecreate) args.push("--force-recreate");
  // `--` ends option parsing. Compose allows service names that start with
  // `-`; without the separator e.g. `--remove-orphans` would be executed as an
  // option and not as an authorized single service.
  if (options.serviceName) args.push("--", options.serviceName);
  return args;
}

export async function composeUp(project: ComposeProject, options: UpOptions): Promise<string> {
  const { stderr } = await run(buildUpArgs(project, options), { timeoutMs: options.timeoutMs ?? 5 * 60_000 });
  return stderr;
}

export async function composeDown(project: ComposeProject): Promise<string> {
  // Without --volumes: data survives a down. A delete command that
  // incidentally takes the data along too is exactly the kind of surprise this
  // plan is meant to avoid.
  //
  // Without --remove-orphans for the same reason as above.
  const { stderr } = await run(buildDownArgs(project), {
    timeoutMs: 2 * 60_000
  });
  return stderr;
}

export function buildDownArgs(project: ComposeProject): string[] {
  return [...projectArgs(project), "down"];
}

// S11: actions on the WHOLE stack. Argument construction stays central here,
// so that no route accidentally appends a service or smuggles in a
// `--volumes`, `--build` or `--pull`. `project.projectName` is mandatory for
// these functions; on the caller's side it comes from the agent registry and
// never from the request.
export type NamedComposeProject = ComposeProject & { projectName: string };
export type SafeStackAction = "start" | "stop";

export function buildSafeStackActionArgs(
  project: NamedComposeProject,
  action: SafeStackAction
): string[] {
  return [...projectArgs(project), action];
}

export function buildDependencySafeRestartArgs(project: NamedComposeProject): [string[], string[]] {
  return [
    buildSafeStackActionArgs(project, "stop"),
    buildSafeStackActionArgs(project, "start")
  ];
}

export async function composeStart(project: NamedComposeProject, timeoutMs: number): Promise<string> {
  const { stderr } = await run(buildSafeStackActionArgs(project, "start"), {
    timeoutMs
  });
  return stderr;
}

export async function composeStop(project: NamedComposeProject, timeoutMs: number): Promise<string> {
  const { stderr } = await run(buildSafeStackActionArgs(project, "stop"), {
    timeoutMs
  });
  return stderr;
}

export async function composeDependencySafeRestart(
  project: NamedComposeProject,
  timeoutMs: number,
  execute: typeof run = run
): Promise<string> {
  const [stopArgs, startArgs] = buildDependencySafeRestartArgs(project);
  const deadline = Date.now() + timeoutMs;
  let stopStderr = "";
  let stopFailed = false;
  let stopFailure: unknown;
  try {
    stopStderr = (await execute(stopArgs, { timeoutMs })).stderr;
  } catch (error) {
    // A stop can fail only after a partial mutation. The start must still
    // follow best-effort, so that the stack does not stay down merely because
    // of the error path. The original error remains the result.
    stopFailed = true;
    stopFailure = error;
  }

  let startStderr: string;
  try {
    startStderr = (await execute(startArgs, { timeoutMs: Math.max(1, deadline - Date.now()) })).stderr;
  } catch (startFailure) {
    if (stopFailed) {
      throw new AggregateError(
        [stopFailure, startFailure],
        "docker compose stop and the subsequent recovery start both failed",
        { cause: startFailure }
      );
    }
    throw startFailure;
  }
  if (stopFailed) throw stopFailure;
  return [stopStderr, startStderr].filter(Boolean).join("\n");
}

// Removes ONE service from a stack and leaves the others running.
//
// ⚠️ Without this path "remove container" would only have `down` — and that
// shuts down the whole project. With the self-generated single-service stacks
// from 5c that was the same; with adopted stacks it no longer is: a `remove`
// of `homepage` would have cleared away `homepage_code-server` along with it.
//
// --stop: stop first, then remove (no hard kill — for databases the
// difference between a clean shutdown and recovery). --force: no prompt on a
// terminal that does not exist here. No --volumes: data survives.
export function buildRmArgs(project: ComposeProject, serviceName: string): string[] {
  return [...projectArgs(project), "rm", "--stop", "--force", "--", serviceName];
}

export async function composeRm(project: ComposeProject, serviceName: string): Promise<string> {
  const { stderr } = await run(buildRmArgs(project, serviceName), { timeoutMs: 2 * 60_000 });
  return stderr;
}

export type ComposePsEntry = { ID?: string; Name?: string; Service?: string; State?: string };

// Resolves which container currently belongs to this directory+service.
// This is the answer to 6.3.1: the anchor is the directory, the id is looked
// up fresh when needed instead of being stored and going stale.
export async function composePs(project: ComposeProject): Promise<ComposePsEntry[]> {
  const { stdout } = await run([...projectArgs(project), "ps", "--all", "--format", "json"], {
    timeoutMs: 30_000
  });
  // `--format json` yields, depending on the Compose version, an array OR one
  // line per container. Accept both instead of relying on one version.
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) return JSON.parse(trimmed) as ComposePsEntry[];
  return trimmed
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ComposePsEntry);
}

// ⚠️ No fallback to entries[0]. It stood here until 5d and was harmless as
// long as exactly one service lived per directory — with stacks it is a
// silent mis-grab: one asks for a service, any one would be delivered, and
// the caller takes the result for an answer to its question. That is exactly
// the class of error that in this stage an action on the wrong container
// would hang on anyway (stop, remove).
//
// No match is an error, not an approximation.
export async function resolveContainerId(
  project: ComposeProject,
  serviceName: string
): Promise<string | null> {
  const entries = await composePs(project);
  const match = entries.find((entry) => entry.Service === serviceName);
  return match?.ID ?? null;
}

// Whether the Docker CLI is present at all. Checked at startup: an agent that
// offers compose endpoints and fails on a missing binary at the first call
// moves a deploy error into operation.
export async function composeAvailable(): Promise<boolean> {
  try {
    await run(["compose", "version"], { timeoutMs: 15_000 });
    return true;
  } catch {
    return false;
  }
}
