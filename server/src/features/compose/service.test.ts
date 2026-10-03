import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_HOST_THEME, HUB_STREAM_BROKEN } from "contract";
import type { ContainerOverviewEntry } from "../../domain/containers/index.js";
import type { ContainerAccessResult, HostCycleOutcome, HostRecord, RouteWriting } from "../../domain/hosts/index.js";
import { AgentError, type Actor, type AgentTarget } from "../../platform/agent-transport/protocol.js";
import type { RouteFailure } from "../../platform/http/route-failure.js";
import { MAX_COMPOSE_BYTES } from "./agent-client.js";
import { createComposeService, type ComposeAgent, type ComposeStream } from "./service.js";
import type { ComposeApplyInput, ComposeApplyResult, ComposeDryRun, ComposeFile } from "./types.js";

// The service of the feature `compose` without Express, without Postgres and
// without an agent (#264): a fake chain, a fake agent that records what it was
// asked, and a stream that records what it was told. What is checked is what
// the service decides — the order of the checks, the lock against the hub's own
// stack, the name that the hub reads instead of the browser, the two
// fallbacks for old arms and the way applying ends.

const TARGET: AgentTarget = { baseUrl: "http://agent.test", secret: "s".repeat(32) };
const REF = { hostId: "h1", containerId: "c0ffee", userId: "admin-1" };
const OWN_ID = "37bfb9511f3f";

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
  createdAt: new Date("2026-09-08T10:00:00.000Z"),
  registeredAt: null,
  lastSeenAt: null,
  display: DEFAULT_HOST_THEME
};

const FILE: ComposeFile = {
  projectDir: "/opt/stacks/medien",
  composeFileName: "compose.yaml",
  stackName: "medien",
  content: "services:\n  sonarr:\n    image: sonarr:1\n",
  composeHash: "h1",
  services: ["sonarr"],
  servicesInFile: ["sonarr", "radarr"],
  fileReadable: true,
  containerIds: { sonarr: "c-sonarr" },
  inventoryViolations: []
};

const DRY_RUN: ComposeDryRun = {
  source: "agent",
  valid: true,
  reason: null,
  errors: [],
  configError: null,
  services: ["sonarr"],
  diff: { remaining: ["sonarr"], new: [], removed: [] },
  imagesByService: {},
  missingImages: [],
  servicesWithoutImage: [],
  inventoryViolations: [],
  composeHash: "h1",
  stackName: "medien",
  currentServices: ["sonarr"],
  steps: [],
  uncertainties: []
};

const DRAFT = "services:\n  sonarr:\n    image: sonarr:2\n";
const BODY = { content: DRAFT, expectedComposeHash: "h1" };

function entry(id: string, project: string): ContainerOverviewEntry {
  return {
    id,
    name: id,
    image: "img:1",
    status: "running",
    running: true,
    startedAt: null,
    health: null,
    compose: { project, service: id.slice(0, 4) },
    stats: null,
    externalManagement: null
  } as ContainerOverviewEntry;
}

/** An error as `agentRequest` builds it from the body of the arm. */
function refusal(status: number, detail: unknown): AgentError {
  return new AgentError("abgelehnt", status, { detail });
}

type Call = { method: string; args: unknown[] };

type Replies = {
  read?: () => ComposeFile;
  preview?: () => ComposeDryRun;
  /** What the stream does: call the callbacks it is given, then answer or throw. */
  stream?: (input: ComposeApplyInput, options: Parameters<ComposeAgent["applyComposeStreaming"]>[3]) => Promise<ComposeApplyResult>;
  apply?: () => ComposeApplyResult;
};

function fixture(
  options: {
    chain?: RouteFailure;
    /** The hub's own stack stands in this arm's list. */
    own?: boolean;
    /** The arm is `outdated`: writes are locked by the chain. */
    outdated?: boolean;
    /** Which container carries an external manager (#56). */
    managed?: "anchor" | "neighbour" | "other-project";
    replies?: Replies;
    resync?: (record: HostRecord, actor: Actor) => Promise<HostCycleOutcome>;
  } = {}
) {
  const opened: RouteWriting[] = [];
  const calls: Call[] = [];
  const replies = options.replies ?? {};

  const record = <T>(method: string, args: unknown[], value: () => T): T => {
    calls.push({ method, args });
    return value();
  };

  const agent: ComposeAgent = {
    readComposeFile: async (...args) => record("readComposeFile", args, replies.read ?? (() => FILE)),
    previewComposeOnAgent: async (...args) => record("previewComposeOnAgent", args, replies.preview ?? (() => DRY_RUN)),
    applyCompose: async (...args) =>
      record("applyCompose", args, replies.apply ?? (() => ({ ok: true, body: { applied: true } }))),
    applyComposeStreaming: async (...args) => {
      calls.push({ method: "applyComposeStreaming", args });
      const answer = replies.stream ?? (async () => ({ ok: true as const, body: { applied: true } }));
      return answer(args[2], args[3]);
    },
    readProjectEnv: async (...args) =>
      record("readProjectEnv", args, () => ({
        projectDir: "/opt/stacks/medien",
        composeFileName: "compose.yaml",
        filePresent: true,
        plaintext: args[2],
        entries: []
      })),
    readComposeCandidates: async (...args) =>
      record("readComposeCandidates", args, () => ({
        anchor: { ok: true as const, projectDir: "/opt/stacks/medien" },
        selectedFilePath: null,
        labelFilePaths: [],
        candidates: []
      })),
    selectComposeFile: async (...args) => record("selectComposeFile", args, () => args[2]),
    clearComposeSelection: async (...args) => record("clearComposeSelection", args, () => undefined)
  };

  const service = createComposeService({
    openContainer: async (request, writing): Promise<ContainerAccessResult> => {
      opened.push(writing);
      if (options.chain) return { ok: false, failure: options.chain };
      const anchor = entry(request.containerId, "medien");
      const unraid = { manager: "unraid" };
      if (options.managed === "anchor") anchor.externalManagement = unraid;
      const containers = options.own === true ? [anchor, entry(`${OWN_ID}${"a".repeat(52)}`, "medien")] : [anchor];
      if (options.managed === "neighbour" || options.managed === "other-project") {
        const other = entry("radarr0", options.managed === "neighbour" ? "medien" : "spiele");
        other.externalManagement = unraid;
        containers.push(other);
      }
      return {
        ok: true,
        access: {
          host: HOST,
          target: TARGET,
          container: anchor,
          options: { actor: { kind: "user", id: request.userId } },
          containers,
          writable: options.outdated !== true
        }
      };
    },
    ...(options.resync === undefined ? {} : { resyncHost: options.resync }),
    ownShortId: () => OWN_ID,
    agent
  });

  return { service, agent, opened, calls };
}

/** The stream to the browser, recording every line and the order of events. */
function recordingStream(order: string[] = []) {
  const lines: Record<string, unknown>[] = [];
  const controller = new AbortController();
  const stream: ComposeStream = {
    signal: controller.signal,
    write: async (event) => {
      const line = event as Record<string, unknown>;
      lines.push(line);
      order.push(`line:${String(line.kind)}`);
    }
  };
  return { stream, lines, abort: () => controller.abort() };
}

async function planned(f: ReturnType<typeof fixture>, body: unknown = BODY) {
  const plan = await f.service.planApply(REF, body);
  assert.ok(plan.ok, "der Plan hätte stehen müssen");
  return plan;
}

// ── Lesen ───────────────────────────────────────────────────────────────────

test("lesen: die Leitungsform trägt den Befund des Hubs neben denen des Arms", async () => {
  const f = fixture();
  const read = await f.service.read(REF);
  assert.ok(read.ok);
  assert.equal(read.compose.hubOwnStack, false);
  assert.equal(read.compose.stackName, "medien");
  assert.deepEqual(read.compose.servicesInFile, ["sonarr", "radarr"]);
  assert.deepEqual(f.opened, ["reads"]);
});

test("lesen: der eigene Stack des Hubs wird gemeldet, nicht gesperrt", async () => {
  const read = await fixture({ own: true }).service.read(REF);
  assert.ok(read.ok);
  assert.equal(read.compose.hubOwnStack, true);
});

test("lesen: die Ablehnung des Arms bleibt ein Wert mit ihrem Grund", async () => {
  const error = refusal(409, { error: "compose-file-missing", projectDir: "/x" });
  const f = fixture({
    replies: {
      read: () => {
        throw error;
      }
    }
  });
  const read = await f.service.read(REF);
  assert.ok(!read.ok);
  assert.deepEqual(read.failure, { kind: "agent-error", error });
});

test("lesen: ein Fehler der Kette geht zurück, und der Arm wird nicht gefragt", async () => {
  const chain: RouteFailure = { kind: "problem", status: 503, error: "host-unreachable", message: "aus" };
  const f = fixture({ chain });
  const read = await f.service.read(REF);
  assert.deepEqual(read, { ok: false, failure: chain });
  assert.deepEqual(f.calls, []);
});

test("lesen: etwas, das kein AgentError ist, ist ein Fehler des Hubs und wird nicht zum Wert", async () => {
  const f = fixture({
    replies: {
      read: () => {
        throw new TypeError("Fehler im Hub");
      }
    }
  });
  await assert.rejects(f.service.read(REF), TypeError);
});

test("die .env: der eigene Stack bleibt gesperrt, und der Arm wird nicht gefragt", async () => {
  const f = fixture({ own: true });
  const env = await f.service.readEnv(REF, true);
  assert.ok(!env.ok);
  assert.deepEqual(env.failure, {
    kind: "problem",
    status: 403,
    error: "hub-own-stack",
    message: "Die Umgebung des Hub-Stacks bleibt gesperrt."
  });
  assert.deepEqual(f.calls, []);
});

test("die .env: Klartext wird nur auf ausdrücklichen Wunsch angefordert", async () => {
  const f = fixture();
  const masked = await f.service.readEnv(REF, false);
  const revealed = await f.service.readEnv(REF, true);
  assert.ok(masked.ok && revealed.ok);
  assert.deepEqual(
    f.calls.map((call) => [call.method, call.args[2]]),
    [
      ["readProjectEnv", false],
      ["readProjectEnv", true]
    ]
  );
  assert.deepEqual(f.opened, ["reads", "reads"]);
});

// ── Trockenlauf ─────────────────────────────────────────────────────────────

test("Trockenlauf: die Vorschau kommt vom Arm, ohne Leseaufruf", async () => {
  const f = fixture();
  const answer = await f.service.preview(REF, { content: DRAFT });
  assert.ok(answer.ok);
  assert.equal(answer.preview.source, "agent");
  assert.deepEqual(f.calls.map((call) => call.method), ["previewComposeOnAgent"]);
  // The preview changes nothing: it counts as `reads` for the write lock.
  assert.deepEqual(f.opened, ["reads"]);
  assert.equal(f.calls[0]?.args[2], DRAFT);
});

test("Trockenlauf: ein Rumpf ohne Text ist ein leerer Entwurf und kein Absturz", async () => {
  for (const body of [undefined, null, {}, { content: 7 }]) {
    const f = fixture();
    assert.ok((await f.service.preview(REF, body)).ok);
    assert.equal(f.calls[0]?.args[2], "");
  }
});

test("Trockenlauf: ein Arm ohne die Route bekommt die eigene Rechnung — und sagt es", async () => {
  const f = fixture({
    replies: {
      preview: () => {
        throw refusal(404, { error: "unbekannte-route" });
      }
    }
  });
  const answer = await f.service.preview(REF, { content: DRAFT });
  assert.ok(answer.ok);
  assert.equal(answer.preview.source, "hub");
  assert.deepEqual(answer.preview.diff?.removed, []);
  assert.deepEqual(f.calls.map((call) => call.method), ["previewComposeOnAgent", "readComposeFile"]);
});

test("Trockenlauf: eine 404 ohne Rumpf heißt auch Route unbekannt", async () => {
  const f = fixture({
    replies: {
      preview: () => {
        throw new AgentError("404", 404);
      }
    }
  });
  assert.equal(((await f.service.preview(REF, { content: DRAFT })) as { preview: ComposeDryRun }).preview.source, "hub");
});

test("Trockenlauf: eine 404 mit not-allowlisted löst KEINEN Rückfall aus", async () => {
  const error = refusal(404, { error: "not-allowlisted" });
  const f = fixture({
    replies: {
      preview: () => {
        throw error;
      }
    }
  });
  const answer = await f.service.preview(REF, { content: DRAFT });
  assert.ok(!answer.ok);
  assert.deepEqual(answer.failure, { kind: "agent-error", error });
  assert.deepEqual(f.calls.map((call) => call.method), ["previewComposeOnAgent"]);
});

test("Trockenlauf: ein abgeschalteter Arm und eine belegte Sperre fallen NICHT auf die eigene Rechnung", async () => {
  for (const error of [refusal(503, { error: "agent-read-only" }), refusal(409, { error: "stack-busy" })]) {
    const f = fixture({
      replies: {
        preview: () => {
          throw error;
        }
      }
    });
    const answer = await f.service.preview(REF, { content: DRAFT });
    assert.ok(!answer.ok);
    assert.deepEqual(f.calls.map((call) => call.method), ["previewComposeOnAgent"]);
  }
});

// ── Anwenden: was vor dem Strom feststeht ───────────────────────────────────

test("Anwenden: die Kette läuft mit Schreibsperre, und ihr Fehler geht zurück, ohne den Arm zu fragen", async () => {
  const chain: RouteFailure = { kind: "problem", status: 409, error: "agent-outdated", message: "zu alt" };
  const f = fixture({ chain });
  assert.deepEqual(await f.service.planApply(REF, BODY), { ok: false, failure: chain });
  assert.deepEqual(f.opened, ["writes"]);
  assert.deepEqual(f.calls, []);
});

test("Anwenden: der eigene Stack des Hubs wird vor allem anderen abgelehnt", async () => {
  // ⚠️ Even a body that would fail the next check: the lock comes first.
  const f = fixture({ own: true });
  const plan = await f.service.planApply(REF, { content: "x" });
  assert.ok(!plan.ok);
  assert.equal(plan.failure.kind, "problem");
  assert.equal(plan.failure.kind === "problem" ? plan.failure.error : "", "hub-own-stack");
  assert.equal(plan.failure.kind === "problem" ? plan.failure.status : 0, 403);
  assert.deepEqual(f.calls, []);
});

test("Anwenden: ohne Hash wird gar nicht erst gefragt", async () => {
  for (const body of [{ content: DRAFT }, { content: DRAFT, expectedComposeHash: "" }, { content: DRAFT, expectedComposeHash: 7 }, undefined, null]) {
    const f = fixture();
    const plan = await f.service.planApply(REF, body);
    assert.ok(!plan.ok);
    assert.equal(plan.failure.kind === "problem" ? plan.failure.error : "", "compose-hash-missing");
    assert.equal(plan.failure.kind === "problem" ? plan.failure.status : 0, 400);
    assert.deepEqual(f.calls, []);
  }
});

test("Anwenden: die Grenze zählt Bytes und wird vor dem Aufruf gemeldet", async () => {
  // A comment of 2-byte characters is over the limit at half its length.
  const over = "ä".repeat(MAX_COMPOSE_BYTES / 2 + 1);
  assert.ok(over.length <= MAX_COMPOSE_BYTES);
  const f = fixture();
  const plan = await f.service.planApply(REF, { content: over, expectedComposeHash: "h1" });
  assert.ok(!plan.ok);
  assert.equal(plan.failure.kind === "problem" ? plan.failure.error : "", "too-large");
  assert.equal(plan.failure.kind === "problem" ? plan.failure.status : 0, 413);
  assert.deepEqual(f.calls, []);

  const exactly = fixture();
  assert.ok((await exactly.service.planApply(REF, { content: "a".repeat(MAX_COMPOSE_BYTES), expectedComposeHash: "h1" })).ok);
});

// ── Anwenden: der Strom ─────────────────────────────────────────────────────

test("Anwenden: der Hub setzt den Namen aus dem Leseaufruf und nicht aus dem Rumpf", async () => {
  const f = fixture({ replies: { read: () => ({ ...FILE, stackName: "aus-dem-arm" }) } });
  const plan = await planned(f, { ...BODY, stackName: "aus-dem-browser", confirmName: "aus-dem-browser" });
  await plan.run(recordingStream().stream);

  const stream = f.calls.find((call) => call.method === "applyComposeStreaming");
  const input = stream?.args[2] as ComposeApplyInput;
  assert.equal(input.stackName, "aus-dem-arm");
  assert.equal(input.expectedComposeHash, "h1");
  assert.equal(input.content, DRAFT);
});

test("Anwenden: die Bestätigungslisten reisen als Listen von Text und sonst leer", async () => {
  const f = fixture();
  const plan = await planned(f, {
    ...BODY,
    confirmNew: ["a", 7, "b"],
    confirmRemoved: "kein-array",
    acknowledgeImagePull: ["x:1"]
  });
  await plan.run(recordingStream().stream);
  const input = f.calls.find((call) => call.method === "applyComposeStreaming")?.args[2] as ComposeApplyInput;
  assert.deepEqual(input.confirmNew, ["a", "b"]);
  assert.deepEqual(input.confirmRemoved, []);
  assert.deepEqual(input.acknowledgeImagePull, ["x:1"]);
  assert.deepEqual(input.acknowledgeHardening, []);
});

test("Anwenden: start, Schritte und Ergebnis kommen in dieser Reihenfolge, der Abgleich vor dem Ergebnis", async () => {
  const order: string[] = [];
  const f = fixture({
    replies: {
      stream: async (_input, options) => {
        options.onStart?.({ projectDir: "/opt/stacks/medien", composeFileName: "compose.yaml", stackName: "medien" });
        await options.onStep?.({ step: "check", detail: null });
        await options.onStep?.({ step: "start", detail: "sonarr" });
        return { ok: true, body: { applied: true } };
      }
    },
    resync: async (record, actor) => {
      order.push("resync");
      assert.equal(record.id, "h1");
      assert.deepEqual(actor, { kind: "user", id: "admin-1" });
      return { hostId: "h1", hostName: "unraid", status: "synced", entryCount: 3, error: null };
    }
  });
  const { stream, lines } = recordingStream(order);
  await (await planned(f)).run(stream);

  assert.deepEqual(lines, [
    { kind: "start", projectDir: "/opt/stacks/medien", composeFileName: "compose.yaml", stackName: "medien", live: true },
    { kind: "step", step: "check", detail: null },
    { kind: "step", step: "start", detail: "sonarr" },
    { kind: "result", applied: { applied: true }, resync: { status: "synced", error: null } }
  ]);
  assert.deepEqual(order, ["line:start", "line:step", "line:step", "resync", "line:result"]);
});

test("Anwenden: ohne verdrahteten Abgleich sagt das Ergebnis das, statt zu schweigen", async () => {
  const f = fixture();
  const { stream, lines } = recordingStream();
  await (await planned(f)).run(stream);
  assert.deepEqual(lines, [{ kind: "result", applied: { applied: true }, resync: { status: "skipped", error: null } }]);
});

test("Anwenden: ein gescheiterter Abgleich meldet sich und lässt das Anwenden gelten", async () => {
  const f = fixture({
    resync: async () => {
      throw new Error("der Arm hat den Abgleich abgelehnt");
    }
  });
  const { stream, lines } = recordingStream();
  await (await planned(f)).run(stream);
  assert.deepEqual(lines, [
    {
      kind: "result",
      applied: { applied: true },
      resync: { status: "failed", error: "der Arm hat den Abgleich abgelehnt" }
    }
  ]);
});

test("Anwenden: eine Frage des Arms ist eine Zeile `question` und löst keinen Abgleich aus", async () => {
  let resynced = 0;
  const question = { kind: "services" as const, added: ["radarr"], removed: [] };
  const f = fixture({
    replies: { stream: async () => ({ ok: false, question }) },
    resync: async () => {
      resynced += 1;
      throw new Error("darf nicht laufen");
    }
  });
  const { stream, lines } = recordingStream();
  await (await planned(f)).run(stream);
  assert.deepEqual(lines, [{ kind: "question", question }]);
  assert.equal(resynced, 0);
});

// ── Anwenden: Rückfall, Ablehnung, Abbruch ──────────────────────────────────

test("Anwenden: ein Arm ohne Anwende-Strom bekommt den synchronen Weg, und die Fläche erfährt es", async () => {
  const f = fixture({
    replies: {
      stream: async () => {
        throw refusal(404, { error: "unbekannte-route" });
      },
      apply: () => ({ ok: true, body: { applied: true } })
    }
  });
  const { stream, lines } = recordingStream();
  await (await planned(f)).run(stream);
  assert.deepEqual(f.calls.map((call) => call.method), ["readComposeFile", "applyComposeStreaming", "applyCompose"]);
  assert.deepEqual(lines[0], { kind: "start", projectDir: "", composeFileName: "", stackName: "medien", live: false });
  assert.equal(lines[1]?.kind, "result");
});

test("Anwenden: eine 404 mit not-allowlisted fällt NICHT auf den synchronen Weg, und es steht noch keine Zeile", async () => {
  const error = refusal(404, { error: "not-allowlisted" });
  const f = fixture({
    replies: {
      stream: async () => {
        throw error;
      }
    }
  });
  const { stream, lines } = recordingStream();
  // ⚠️ IT THROWS BEFORE A LINE IS OUT, so the route can still answer with a
  // status. Had the fallback started, `start` would be out and the surface
  // would read "state unknown" for a stack the arm never touched (#129).
  await assert.rejects((await planned(f)).run(stream), (thrown: unknown) => thrown === error);
  assert.deepEqual(lines, []);
  assert.deepEqual(f.calls.map((call) => call.method), ["readComposeFile", "applyComposeStreaming"]);
});

test("Anwenden: scheitert schon der Leseaufruf, ist es ein Status und keine Zeile", async () => {
  const error = refusal(409, { error: "compose-file-missing", projectDir: "/x" });
  const f = fixture({
    replies: {
      read: () => {
        throw error;
      }
    }
  });
  const { stream, lines } = recordingStream();
  await assert.rejects((await planned(f)).run(stream), (thrown: unknown) => thrown === error);
  assert.deepEqual(lines, []);
});

test("Anwenden: nach der ersten Zeile steht ein Fehler als Zeile, mit dem Grund des Arms wörtlich", async () => {
  for (const [sent, expected] of [
    [{ reason: "engine-unreachable" }, "engine-unreachable"],
    [{ reason: null }, null]
  ] as const) {
    const f = fixture({
      replies: {
        stream: async (_input, options) => {
          options.onStart?.({ projectDir: "/p", composeFileName: "compose.yaml", stackName: "medien" });
          options.onFailure?.(sent);
          throw new AgentError("Der Anwende-Strom endete mit einem Fehler.");
        }
      }
    });
    const { stream, lines } = recordingStream();
    await (await planned(f)).run(stream);
    assert.deepEqual(lines.map((line) => line.kind), ["start", "error"]);
    assert.ok(lines[1]?.reason === expected, JSON.stringify(lines[1]));
  }
});

test("Anwenden: ein Strom ohne Abschlusszeile gilt nicht als Erfolg und trägt das Wort des Hubs", async () => {
  const f = fixture({
    replies: {
      stream: async (_input, options) => {
        options.onStart?.({ projectDir: "/p", composeFileName: "compose.yaml", stackName: "medien" });
        throw new AgentError("Der Anwende-Strom endete ohne Abschlusszeile.");
      }
    }
  });
  const { stream, lines } = recordingStream();
  await (await planned(f)).run(stream);
  assert.equal(lines.filter((line) => line.kind === "result").length, 0, "kein Ergebnis darf erfunden werden");
  assert.deepEqual(lines[1], { kind: "error", reason: HUB_STREAM_BROKEN });
});

test("Anwenden: ein Fehler des Hubs nach der ersten Zeile wird ebenfalls eine Zeile", async () => {
  const f = fixture({
    replies: {
      stream: async (_input, options) => {
        options.onStart?.({ projectDir: "/p", composeFileName: "compose.yaml", stackName: "medien" });
        throw new TypeError("Fehler im Hub");
      }
    }
  });
  const { stream, lines } = recordingStream();
  await (await planned(f)).run(stream);
  assert.deepEqual(lines[1], { kind: "error", reason: HUB_STREAM_BROKEN });
});

test("Anwenden: ein Fehler des Hubs VOR der ersten Zeile wird nicht verschluckt", async () => {
  const f = fixture({
    replies: {
      read: () => {
        throw new TypeError("Fehler im Hub");
      }
    }
  });
  await assert.rejects((await planned(f)).run(recordingStream().stream), TypeError);
});

test("Anwenden: geht der Browser, schreibt der Hub keine Zeile auf die geschlossene Verbindung", async () => {
  const f = fixture({
    replies: {
      stream: async (_input, options) => {
        options.onStart?.({ projectDir: "/p", composeFileName: "compose.yaml", stackName: "medien" });
        assert.equal(options.signal.aborted, false, "solange der Browser zuhört, läuft der Strom");
        abort();
        assert.equal(options.signal.aborted, true, "das Signal des Browsers erreicht den Arm");
        throw new AgentError("abgebrochen");
      }
    }
  });
  const { stream, lines, abort } = recordingStream();
  await (await planned(f)).run(stream);
  assert.deepEqual(lines.map((line) => line.kind), ["start"]);
});

// ── The selection by hand (#185) ────────────────────────────────────────────

test("selection: all three routes open the chain as writes and ask the arm", async () => {
  const f = fixture();
  assert.ok((await f.service.candidates(REF)).ok);
  assert.deepEqual(await f.service.select(REF, { filePath: "/opt/stacks/medien/compose.yaml" }), {
    ok: true,
    selectedFilePath: "/opt/stacks/medien/compose.yaml"
  });
  assert.deepEqual(await f.service.clearSelection(REF), { ok: true, selectedFilePath: null });
  assert.deepEqual(f.opened, ["writes", "writes", "writes"]);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ["readComposeCandidates", "selectComposeFile", "clearComposeSelection"]
  );
});

test("selection: the hub's own stack stays locked before the arm is asked", async () => {
  const f = fixture({ own: true });
  for (const result of [
    await f.service.candidates(REF),
    await f.service.select(REF, { filePath: "/x" }),
    await f.service.clearSelection(REF)
  ]) {
    assert.ok(!result.ok);
    assert.equal(result.failure.kind === "problem" ? result.failure.error : null, "hub-own-stack");
  }
  assert.deepEqual(f.calls, []);
});

test("selection: the read says where the selection is offered", async () => {
  for (const [options, expected] of [
    [{}, true],
    [{ own: true }, false],
    [{ outdated: true }, false]
  ] as const) {
    const read = await fixture(options).service.read(REF);
    assert.ok(read.ok);
    assert.equal(read.compose.selectionSupported, expected, JSON.stringify(options));
  }
  const missing = await fixture({
    replies: {
      read: () => {
        throw refusal(409, { error: "compose-anchor-file-ambiguous" });
      }
    }
  }).service.read(REF);
  assert.ok(!missing.ok);
  assert.equal(missing.selectionSupported, true);
});

// ── External management (#56) ───────────────────────────────────────────────

const MANAGED_FAILURE = {
  kind: "problem",
  status: 403,
  error: "externally-managed",
  message: "Ein Dienst dieses Stacks wird fremdverwaltet. Seine Definition bleibt beim Verwalter."
};

test("external management: preview and apply are refused before the arm is asked", async () => {
  for (const managed of ["anchor", "neighbour"] as const) {
    const f = fixture({ managed });
    const preview = await f.service.preview(REF, BODY);
    assert.deepEqual(preview, { ok: false, failure: MANAGED_FAILURE }, managed);
    const plan = await f.service.planApply(REF, BODY);
    assert.deepEqual(plan, { ok: false, failure: MANAGED_FAILURE }, managed);
    assert.deepEqual(f.calls, [], managed);
  }
});

test("external management: reading stays open and reports the lock", async () => {
  const read = await fixture({ managed: "neighbour" }).service.read(REF);
  assert.ok(read.ok);
  assert.equal(read.compose.externallyManaged, true);
  assert.equal(read.compose.content, FILE.content);
});

test("external management: a managed container of another project does not lock this stack", async () => {
  const f = fixture({ managed: "other-project" });
  const read = await f.service.read(REF);
  assert.ok(read.ok);
  assert.equal(read.compose.externallyManaged, false);
  assert.ok((await f.service.preview(REF, BODY)).ok);
  const plan = await planned(f);
  const { stream, lines } = recordingStream();
  await plan.run(stream);
  assert.equal(lines.at(-1)?.kind, "result");
});
