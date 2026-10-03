import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_HOST_THEME } from "contract";
import type { HostCycleOutcome, HostRecord, HostRouteAccessResult, RouteWriting } from "../../domain/hosts/index.js";
import { AgentError, type AgentTarget } from "../../platform/agent-transport/protocol.js";
import { MAX_COMPOSE_BYTES } from "./agent-client.js";
import {
  createProjectOnAgent,
  mountSourcesOf,
  previewProjectOnAgent,
  type ProjectCreateInput,
  type ProjectCreateResult,
  type ProjectPreview
} from "./project-client.js";
import { createProjectService, type ProjectAgent } from "./project-service.js";

const TARGET: AgentTarget = { baseUrl: "http://agent.test", secret: "s".repeat(32) };
const REF = { hostId: "h1", userId: "admin-1" };
const DRAFT = "services:\n  app:\n    image: example/notes:1.0\n";

const HOST: HostRecord = {
  id: "h1",
  name: "unraid",
  agentUrl: "http://127.0.0.1:0",
  kind: "external",
  state: "registered",
  tunnelAddress: null,
  wireguardPublicKey: null,
  endpointOverride: null,
  failedAttempts: 0,
  dockerGid: null,
  bindBasePath: null,
  createdAt: new Date("2026-10-03T10:00:00.000Z"),
  registeredAt: null,
  lastSeenAt: null,
  display: DEFAULT_HOST_THEME
};

const PREVIEW: ProjectPreview = {
  projectDir: "/home/docker/notes",
  stackName: "notes",
  valid: true,
  reason: null,
  errors: [],
  configError: null,
  services: ["app"],
  imagesByService: { app: "example/notes:1.0" },
  missingImages: [],
  servicesWithoutImage: [],
  mountSources: [],
  externalSources: []
};

type Recorded = { opened: RouteWriting[]; previews: string[]; creates: ProjectCreateInput[]; resyncs: number };

function setup(
  options: {
    open?: HostRouteAccessResult;
    create?: ProjectCreateResult | AgentError;
    resync?: HostCycleOutcome | Error | null;
  } = {}
) {
  const seen: Recorded = { opened: [], previews: [], creates: [], resyncs: 0 };
  const agent: ProjectAgent = {
    previewProjectOnAgent: async (_target, name) => {
      seen.previews.push(name);
      return PREVIEW;
    },
    createProjectOnAgent: async (_target, input) => {
      seen.creates.push(input);
      const result = options.create ?? { ok: true, body: { ok: true } };
      if (result instanceof AgentError) throw result;
      return result;
    }
  };
  const service = createProjectService({
    openHost: async (_request, writing) => {
      seen.opened.push(writing);
      return (
        options.open ?? {
          ok: true,
          access: { host: HOST, target: TARGET, options: { actor: { kind: "user", id: REF.userId } }, writable: true }
        }
      );
    },
    ...(options.resync === null
      ? {}
      : {
          resyncHost: async () => {
            seen.resyncs += 1;
            const outcome = options.resync ?? ({ status: "ok", error: null } as unknown as HostCycleOutcome);
            if (outcome instanceof Error) throw outcome;
            return outcome;
          }
        }),
    agent
  });
  return { service, seen };
}

test("a project without a name is refused before the host is opened", async () => {
  const { service, seen } = setup();
  const result = await service.create(REF, { name: "  ", content: DRAFT });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.kind === "problem" && result.failure.error, "project-name-missing");
  assert.deepEqual(seen.opened, []);
});

test("an oversized draft is refused by bytes before the agent is asked", async () => {
  const { service, seen } = setup();
  const result = await service.preview(REF, { name: "notes", content: "ä".repeat(MAX_COMPOSE_BYTES / 2 + 1) });
  assert.equal(!result.ok && result.failure.kind === "problem" && result.failure.status, 413);
  assert.deepEqual(seen.previews, []);
});

test("preview and create open the host as writing", async () => {
  const { service, seen } = setup();
  await service.preview(REF, { name: "notes", content: DRAFT });
  await service.create(REF, { name: "notes", content: DRAFT });
  assert.deepEqual(seen.opened, ["writes", "writes"]);
});

test("a failure of the chain goes back without asking the agent", async () => {
  const { service, seen } = setup({
    open: { ok: false, failure: { kind: "problem", status: 409, error: "agent-outdated", message: "zu alt" } }
  });
  const result = await service.create(REF, { name: "notes", content: DRAFT });
  assert.equal(!result.ok && result.failure.kind === "problem" && result.failure.error, "agent-outdated");
  assert.deepEqual(seen.creates, []);
});

test("create passes only the confirmations as lists and reconciles afterwards", async () => {
  const { service, seen } = setup();
  const result = await service.create(REF, {
    name: " notes ",
    content: DRAFT,
    confirmNew: ["app", 7],
    acknowledgeImagePull: "example/notes:1.0",
    confirmExternalSources: ["/mnt/user/media"],
    projectDir: "/elsewhere"
  });
  assert.deepEqual(seen.creates, [
    {
      name: "notes",
      content: DRAFT,
      confirmNew: ["app"],
      acknowledgeImagePull: [],
      acknowledgeHardening: [],
      confirmExternalSources: ["/mnt/user/media"]
    }
  ]);
  assert.equal(seen.resyncs, 1);
  assert.deepEqual(result.ok && result.outcome, {
    kind: "created",
    project: { ok: true },
    resync: { status: "ok", error: null }
  });
});

test("a question of the agent is answered without reconciling", async () => {
  const { service, seen } = setup({
    create: { ok: false, question: { kind: "external-sources", sources: ["/mnt/user/media"] }, projectDirRemoved: true }
  });
  const result = await service.create(REF, { name: "notes", content: DRAFT });
  assert.deepEqual(result.ok && result.outcome, {
    kind: "question",
    question: { kind: "external-sources", sources: ["/mnt/user/media"] },
    projectDirRemoved: true
  });
  assert.equal(seen.resyncs, 0);
});

test("a refusal of the agent stays a value, and a failed reconciliation does not undo the create", async () => {
  const refused = setup({ create: new AgentError("belegt", 409, { detail: { error: "directory-taken" } }) });
  const result = await refused.service.create(REF, { name: "notes", content: DRAFT });
  assert.equal(!result.ok && result.failure.kind, "agent-error");

  const unsynced = setup({ resync: new Error("Arm weg") });
  const created = await unsynced.service.create(REF, { name: "notes", content: DRAFT });
  assert.deepEqual(created.ok && created.outcome.kind === "created" && created.outcome.resync, {
    status: "failed",
    error: "Arm weg"
  });

  const unwired = setup({ resync: null });
  const skipped = await unwired.service.create(REF, { name: "notes", content: DRAFT });
  assert.deepEqual(skipped.ok && skipped.outcome.kind === "created" && skipped.outcome.resync, {
    status: "skipped",
    error: null
  });
});

// --- The agent client -------------------------------------------------------

function stub(body: unknown, status = 200) {
  const seen: Array<{ url: string; body: unknown; signal: AbortSignal | null | undefined }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), body: JSON.parse(String(init?.body)), signal: init?.signal });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const ACTOR = { kind: "user" as const, id: "u-7" };

test("the client asks the dry run by name and keeps only readable mount sources", async () => {
  const { fetchImpl, seen } = stub({
    projectDir: "/home/docker/notes",
    stackName: "notes",
    valid: true,
    services: ["app"],
    missingImages: null,
    mountSources: [
      { service: "app", kind: "external", source: "/mnt/user/media", target: "/media", readOnly: true, shared: false },
      { service: "app", kind: "elsewhere", source: "/x", target: "/x", readOnly: false, shared: false }
    ],
    externalSources: ["/mnt/user/media"]
  });
  const preview = await previewProjectOnAgent(TARGET, "notes", DRAFT, { actor: ACTOR, fetchImpl });
  assert.equal(seen[0]?.url, "http://agent.test/stacks/raw-preview");
  assert.deepEqual(seen[0]?.body, { name: "notes", content: DRAFT });
  assert.equal(preview.missingImages, null);
  assert.equal(preview.mountSources.length, 1);
  assert.deepEqual(preview.externalSources, ["/mnt/user/media"]);
});

test("the client turns a named follow-up question into a value with the cleanup flag", async () => {
  const { fetchImpl } = stub(
    { error: "external-source-confirmation-missing", externalSources: ["/mnt/user/media"], projectDirRemoved: true },
    409
  );
  const input: ProjectCreateInput = {
    name: "notes",
    content: DRAFT,
    confirmNew: ["app"],
    acknowledgeImagePull: [],
    acknowledgeHardening: [],
    confirmExternalSources: []
  };
  assert.deepEqual(await createProjectOnAgent(TARGET, input, { actor: ACTOR, fetchImpl }), {
    ok: false,
    question: { kind: "external-sources", sources: ["/mnt/user/media"] },
    projectDirRemoved: true
  });

  const taken = stub({ error: "directory-taken", projectDir: "/home/docker/notes" }, 409);
  await assert.rejects(createProjectOnAgent(TARGET, input, { actor: ACTOR, fetchImpl: taken.fetchImpl }), AgentError);
});

test("mount sources from a foreign side never crash the reader", () => {
  assert.deepEqual(mountSourcesOf(null), []);
  assert.deepEqual(mountSourcesOf([{ kind: "volume" }]), []);
});
