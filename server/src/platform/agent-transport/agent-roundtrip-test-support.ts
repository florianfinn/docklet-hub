import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { listenOnFetchablePort } from "../testing/port-test-support.js";
import type { AgentTarget } from "./protocol.js";

// The contract test of #272: the hub's agent client against the REAL handlers
// of the agent, in one process. Only Docker is a stand-in: the engine object
// of the agent gets fake methods, and the compose CLI is replaced through the
// agent's own seam (`rawOps`). No `docker.sock`, no `docker` binary.
//
// ⚠️ THE AGENT IS LOADED BY URL AND NOT BY AN IMPORT STATEMENT. Two reasons:
// `server/tsconfig.json` has `rootDir: "src"`, so tsc refuses a static import
// of `agent/src`, and the import boundaries forbid server → agent for every
// other file (`not-into-agent`, `.dependency-cruiser.mjs`). This file is the
// one place that needs both sides at once, because that is what it tests.
// The types below are the few members it touches, written out by hand.
//
// ⚠️ ONE AGENT PER PROCESS. The agent reads its configuration once, at import
// (`agent/src/runtime/state.ts`). `node --test` runs every test file in a
// process of its own, so each file that calls `startAgent` gets a fresh one.
//
// The round-trip tests use it (`features/<name>/agent-roundtrip.test.ts` and
// `domain/hosts/self-update-roundtrip.test.ts`): it lives in `platform/`
// because a feature cannot import another feature, and each feature's client
// cannot be reached through the door of its feature.

const AGENT_SRC = new URL("../../../../agent/src/", import.meta.url);

export async function loadAgentModule<T>(file: string): Promise<T> {
  return (await import(new URL(file, AGENT_SRC).href)) as T;
}

/** A container id the agent accepts: 64 hex characters. */
export const CONTAINER_ID = "c0ffee".padEnd(64, "0");
export const CONTAINER_NAME = "demo-web";
export const PROJECT_NAME = "demo";
export const SERVICE_NAME = "web";
export const COMPOSE_FILE_NAME = "compose.yaml";
export const COMPOSE_CONTENT = "services:\n  web:\n    image: nginx:1.27\n";
export const SHARE = "data";

/** The log lines the fake engine sends, in this order, before the container goes. */
export const FAKE_LOG_LINES = [
  { stream: "stdout", ts: "2026-10-01T10:00:00.000000000Z", text: "listening on :80" },
  { stream: "stderr", ts: "2026-10-01T10:00:01.000000000Z", text: "warn: no index" }
] as const;

/** What the fake shell answers to the input `ping\n`. */
export const FAKE_SHELL_ECHO = "pong\n";

type FakeEngine = Record<string, unknown>;

type AgentModules = {
  handleRequest: (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>;
  engine: FakeEngine;
  rawOps: Record<string, unknown>;
  EngineError: new (message: string, status: number) => Error;
  ComposeError: new (message: string) => Error;
};

export type AgentUnderTest = {
  target: AgentTarget;
  base: string;
  projectDir: string;
  composeHash: string;
  /** The agent's audit log, one JSON object per line. */
  auditFile: string;
  /** Every answer of the agent with a status of 400 or more, with its body. */
  refusals: { method: string; path: string; status: number; body: unknown }[];
  /** A `fetch` that records refusals into `refusals`. */
  fetchImpl: typeof fetch;
  stop: () => Promise<void>;
};

function inspectOf(projectDir: string): Record<string, unknown> {
  return {
    Id: CONTAINER_ID,
    Name: `/${CONTAINER_NAME}`,
    Image: "sha256:" + "1".repeat(64),
    State: { Running: true, Restarting: false, Status: "running" },
    Config: {
      Tty: false,
      Env: [],
      Image: "nginx:1.27",
      Labels: {
        "com.docker.compose.project": PROJECT_NAME,
        "com.docker.compose.service": SERVICE_NAME,
        "com.docker.compose.project.working_dir": projectDir,
        "com.docker.compose.project.config_files": `${projectDir}/${COMPOSE_FILE_NAME}`
      }
    },
    HostConfig: { Binds: [`${projectDir}/${SHARE}:/usr/share/nginx/html`], Privileged: false },
    // The source as the agent's `realpath` sees it: it compares the resolved
    // share against it. On Linux that is the same string; on Windows the
    // resolution comes back with backslashes (#286).
    Mounts: [
      {
        Type: "bind",
        Source: fs.realpathSync(`${projectDir}/${SHARE}`),
        Destination: "/usr/share/nginx/html",
        RW: true
      }
    ]
  };
}

async function installFakeDocker(modules: AgentModules, projectDir: string): Promise<void> {
  const { archiveOf } = await loadAgentModule<{ archiveOf: (entries: object[]) => Buffer }>("archive-test-support.ts");
  const { archiveEntries } = await loadAgentModule<{ archiveEntries: (archive: Buffer) => { name: string; kind: string; mode: number; content: Buffer }[] }>("archive-reader.ts");
  const targetRoot = "/usr/share/nginx/html";
  const localPath = (target: string) => path.join(projectDir, SHARE, target.slice(targetRoot.length));
  const { engine, rawOps, EngineError, ComposeError } = modules;
  const known = (id: string) => id === CONTAINER_ID || id === CONTAINER_NAME;
  const gone = () => new EngineError("engine responded 404: no such container", 404);

  Object.assign(engine, {
    async inspect(id: string) {
      if (!known(id)) throw gone();
      return inspectOf(projectDir);
    },
    async listWithComposeLabels() {
      const inspect = inspectOf(projectDir) as { Config: { Labels: Record<string, string> } };
      return [{ id: CONTAINER_ID, name: CONTAINER_NAME, image: "nginx:1.27",
        imageId: "sha256:" + "1".repeat(64), status: "running", labels: inspect.Config.Labels }];
    },
    async listContainerIds() {
      return [CONTAINER_ID];
    },
    async imageId() {
      return "sha256:" + "1".repeat(64);
    },
    async volume() {
      throw gone();
    },
    // The log stream: the two lines, then the container goes. That is the
    // one way the stream ends on its own, and it brings the `error` line.
    async logsStream(
      id: string,
      _options: unknown,
      onLine: (line: { stream: string; ts: string | null; text: string }) => void
    ) {
      if (!known(id)) throw gone();
      for (const line of FAKE_LOG_LINES) onLine({ ...line });
      throw gone();
    },
    async info() { return { DockerRootDir: "/var/lib/docker" }; },
    async statArchive(id: string, target: string) {
      if (!known(id)) throw gone();
      if (!target.startsWith(targetRoot)) return { name: path.basename(target), size: 0, mode: 0x80000000, mtime: "2026-01-01T00:00:00Z", linkTarget: "" };
      let stat;
      try { stat = fs.lstatSync(localPath(target)); } catch { return null; }
      return { name: path.basename(target), size: stat.size, mode: stat.isDirectory() ? 0x80000000 : stat.isSymbolicLink() ? 0x08000000 : stat.mode & 0o7777, mtime: stat.mtime.toISOString(), linkTarget: stat.isSymbolicLink() ? fs.readlinkSync(localPath(target)) : "" };
    },
    async getArchive(id: string, target: string, limit: number) {
      if (!known(id)) throw gone();
      const entries: object[] = [];
      const visit = (local: string, name: string) => {
        const stat = fs.lstatSync(local);
        entries.push({ name, path: name, kind: stat.isDirectory() ? "directory" : "file", mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid,
          mtime: Math.floor(stat.mtimeMs / 1000), content: stat.isFile() ? fs.readFileSync(local) : undefined, linkTarget: stat.isSymbolicLink() ? fs.readlinkSync(local) : undefined });
        if (stat.isDirectory()) for (const child of fs.readdirSync(local)) visit(path.join(local, child), name + "/" + child);
      };
      visit(localPath(target), path.posix.basename(target));
      const archive = archiveOf(entries);
      if (archive.length > limit) throw new Error("archive-limit");
      return archive;
    },
    async putArchive(id: string, target: string, archive: Buffer) {
      if (!known(id)) throw gone();
      for (const entry of archiveEntries(archive)) {
        const local = path.join(localPath(target), entry.name);
        if (entry.kind === "directory") fs.mkdirSync(local, { mode: entry.mode });
        else fs.writeFileSync(local, entry.content, { mode: entry.mode });
      }
    },
    async execAvailable() {
      return true;
    },
    async execCreate() {
      return "exec-1";
    },
    // The shell: answers `ping` with `pong`, like an echo with one rule.
    async execStart() {
      const socket = new PassThrough();
      return Object.assign(socket, {
        write(chunk: Buffer | string) {
          if (String(chunk).includes("ping")) socket.push(Buffer.from(FAKE_SHELL_ECHO));
          return true;
        },
        setTimeout() {},
        setNoDelay() {}
      });
    },
    async execResize() {},
    async execExitCode() {
      return 0;
    }
  });

  // The compose CLI. `config` fails the way a broken file does: then the
  // apply stops at its first step and answers with a named result, which is
  // all this test needs from it. The rest is never reached.
  Object.assign(rawOps, {
    async config(_dir: string, fileName: string) {
      if (fileName.startsWith(".")) throw new ComposeError("compose config failed (fake)");
      return { services: { [SERVICE_NAME]: { image: "nginx:1.27", volumes: [
        { type: "bind", source: `${projectDir}/${SHARE}`, target: "/usr/share/nginx/html" }
      ] } } };
    },
    async containerIds() {
      return new Map([[SERVICE_NAME, CONTAINER_ID]]);
    },
    async violationsOf() {
      return [];
    },
    async missingImages() {
      return [];
    }
  });
}

/**
 * Starts the agent's real request handler on a free port, against a fake
 * Docker, with its state in a temporary directory.
 */
let started = false;

export async function startAgent(): Promise<AgentUnderTest> {
  // A second call would get the same modules with the first configuration:
  // its temporary directory would not be the one the agent reads.
  if (started) throw new Error("startAgent: one agent per process; share it between the tests of a file");
  started = true;
  // ⚠️ FORWARD SLASHES, ALSO ON WINDOWS (#286). The agent runs on Linux and
  // reads every path from Docker labels as POSIX (`normalizePath` splits on
  // "/" only); a daemon never writes `C:\…`. With backslashes from
  // `os.tmpdir()` the agent found the project outside its base path, and three
  // round-trip files failed on Windows with 409. Node's `fs` takes forward
  // slashes on Windows as well; on Linux this changes nothing.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-roundtrip-")).replaceAll(path.sep, "/");
  const base = path.posix.join(root, "base");
  const projectDir = path.posix.join(base, PROJECT_NAME);
  const state = path.posix.join(root, "state");
  fs.mkdirSync(path.join(projectDir, SHARE), { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(projectDir, COMPOSE_FILE_NAME), COMPOSE_CONTENT);
  fs.writeFileSync(path.join(projectDir, ".env"), "GREETING=hello\n");
  fs.writeFileSync(path.join(projectDir, SHARE, "index.html"), "<h1>hi</h1>\n");

  const secret = "r".repeat(40);
  Object.assign(process.env, {
    DOCKER_AGENT_SECRET: secret,
    DOCKER_SOCKET_PATH: path.join(root, "no-docker.sock"),
    DOCKER_AGENT_BIND_BASE_PATH: base,
    DOCKER_AGENT_REGISTRY_FILE: path.join(state, "registry.json"),
    DOCKER_AGENT_MONITOR_FILE: path.join(state, "monitors.json"),
    DOCKER_AGENT_AUDIT_FILE: path.join(state, "audit.jsonl"),
    DOCKER_AGENT_SELF_UPDATE_DIR: path.join(state, "self-update")
  });

  const load = loadAgentModule;
  const { handleRequest } = await load<Pick<AgentModules, "handleRequest">>("dispatch.ts");
  const { engine } = await load<Pick<AgentModules, "engine">>("runtime/state.ts");
  const { rawOps } = await load<Pick<AgentModules, "rawOps">>("runtime/raw-ops.ts");
  const { EngineError } = await load<Pick<AgentModules, "EngineError">>("engine.ts");
  const { ComposeError } = await load<Pick<AgentModules, "ComposeError">>("compose-cli.ts");
  await installFakeDocker({ handleRequest, engine, rawOps, EngineError, ComposeError }, projectDir);

  const server = http.createServer((request, response) => void handleRequest(request, response));
  const port = await listenOnFetchablePort(server);

  const refusals: AgentUnderTest["refusals"] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetch(input, init);
    if (response.status >= 400) {
      const text = await response.clone().text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON: kept as text.
      }
      const url = new URL(String(input instanceof Request ? input.url : input));
      refusals.push({ method: init?.method ?? "GET", path: url.pathname + url.search, status: response.status, body });
    }
    return response;
  }) as typeof fetch;

  return {
    target: { baseUrl: `http://127.0.0.1:${port}`, secret },
    base,
    projectDir,
    auditFile: path.join(state, "audit.jsonl"),
    composeHash: createHash("sha256").update(COMPOSE_CONTENT, "utf8").digest("hex"),
    refusals,
    fetchImpl,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

/**
 * The refusals that came from a schema (#272): every one carries `field`
 * (`requestRejectionOf` in `contract/src/agent/reasons.ts`). A request the
 * hub builds must never land here.
 */
export function schemaRefusals(agent: AgentUnderTest): AgentUnderTest["refusals"] {
  return agent.refusals.filter(({ body }) => {
    if (typeof body !== "object" || body === null) return false;
    const record = body as Record<string, unknown>;
    return "field" in record;
  });
}
