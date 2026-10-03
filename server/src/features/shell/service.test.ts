import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_HOST_THEME, HUB_PERMISSION_REVOKED, HUB_SESSION_CLOSED, HUB_STREAM_BROKEN } from "contract";
import type { ContainerAccessResult, HostRecord } from "../../domain/hosts/index.js";
import { AgentError, type AgentTarget } from "../../platform/agent-transport/protocol.js";
import type { RouteFailure } from "../../platform/http/route-failure.js";
import type { ExecOutcome, ExecStreamOptions } from "./agent-client.js";
import type { CurrentUser, Scheduler } from "./permission-watch.js";
import { EXEC_MAX_SESSIONS_PER_USER, ExecSessionRegister } from "./session-register.js";
import { createShellService, type ShellAgent, type ShellStream } from "./service.js";

// The session service of the feature `shell` without Express, without an
// agent and without a database (#260): a fake chain, a fake agent whose stream
// the test holds open, a stream that records what the browser would be told,
// and a beat the test fires by hand. What is checked is what the service
// decides: whom a session belongs to, when it ends and what the browser hears
// at its end.

const TARGET: AgentTarget = { baseUrl: "http://agent.test", secret: "s".repeat(32) };
const AGENT_SESSION_ID = "agent-id-bleibt-auf-dem-server";
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function host(id: string): HostRecord {
  return {
    id,
    name: id,
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
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
  const parts = {} as Deferred<T>;
  parts.promise = new Promise<T>((resolve, reject) => {
    parts.resolve = resolve;
    parts.reject = reject;
  });
  return parts;
}

type Fixture = ReturnType<typeof fixture>;

/**
 * The service with every neighbour faked. `startExec` opens the stream, couples
 * the session and then waits: until the test ends it with `outcome.resolve`, or
 * the hub aborts it (answered with `unterminated`, as the real reader does).
 */
function fixture(options: { openContainer?: () => Promise<ContainerAccessResult>; knownHosts?: string[] } = {}) {
  const register = new ExecSessionRegister();
  const outcome = deferred<ExecOutcome>();
  const calls: { startExec: number; sendInput: unknown[]; resize: unknown[]; closeExec: unknown[] } = {
    startExec: 0,
    sendInput: [],
    resize: [],
    closeExec: []
  };
  const behaviour: { startExecBefore: "open" | "throw" | "open-then-throw"; shortCallError: unknown } = {
    startExecBefore: "open",
    shortCallError: null
  };
  const beat: { task: (() => void) | null; stopped: boolean } = { task: null, stopped: false };
  const schedule: Scheduler = (task) => {
    beat.task = task;
    return () => {
      beat.stopped = true;
    };
  };

  const agent: ShellAgent = {
    startExec: async (_target, _container, execOptions: ExecStreamOptions, onOutput) => {
      calls.startExec += 1;
      if (behaviour.startExecBefore === "throw") throw new AgentError("refused before the first line", 409);
      execOptions.onOpen?.();
      if (behaviour.startExecBefore === "open-then-throw") throw new TypeError("terminated");
      execOptions.onStart?.({ agentSession: AGENT_SESSION_ID, shell: "bash", containerName: "ignored" });
      // An abort ends the stream even while an output line waits on back-pressure.
      execOptions.signal.addEventListener("abort", () => outcome.resolve({ kind: "unterminated" }), { once: true });
      await onOutput("hallo");
      return outcome.promise;
    },
    sendInput: async (_target, session, bytes, callOptions) => {
      if (behaviour.shortCallError) throw behaviour.shortCallError;
      calls.sendInput.push({ session, bytes, actor: callOptions.actor });
    },
    resize: async (_target, session, size, callOptions) => {
      if (behaviour.shortCallError) throw behaviour.shortCallError;
      calls.resize.push({ session, size, actor: callOptions.actor });
    },
    closeExec: async (_target, session, callOptions) => {
      calls.closeExec.push({ session, actor: callOptions.actor });
      if (behaviour.shortCallError) throw behaviour.shortCallError;
    }
  };

  const known = options.knownHosts ?? ["h1"];
  const service = createShellService({
    openContainer:
      options.openContainer ??
      (async (request) => {
        if (!known.includes(request.hostId)) {
          return { ok: false, failure: { kind: "problem", status: 404, error: "host-unknown", message: "no" } };
        }
        return {
          ok: true,
          access: {
            host: host(request.hostId),
            target: TARGET,
            container: { id: request.containerId, name: "immich" } as never,
            options: { actor: { kind: "user", id: request.userId } },
            containers: [],
            writable: true
          }
        };
      }),
    hosts: {
      find: async (id) => (known.includes(id) ? host(id) : null),
      connect: async () => TARGET
    },
    register,
    schedule,
    agent
  });
  return { service, register, outcome, calls, behaviour, beat };
}

/**
 * The browser's end of the stream: everything written, whether it opened, and a
 * way to leave. With `backpressure` an output line is accepted only when the
 * test lets it through (`release`), like a response whose buffer is full.
 */
function browser(options: { backpressure?: boolean } = {}): {
  stream: ShellStream;
  events: unknown[];
  opened: () => boolean;
  leave: () => void;
  release: () => void;
} {
  const controller = new AbortController();
  const state = { events: [] as unknown[], opened: false };
  const gate = deferred<void>();
  return {
    stream: {
      signal: controller.signal,
      open: () => {
        state.opened = true;
      },
      write: async (event) => {
        state.events.push(event);
        if (options.backpressure && (event as { kind?: string }).kind === "output") await gate.promise;
      }
    },
    events: state.events,
    opened: () => state.opened,
    leave: () => controller.abort(),
    release: () => gate.resolve()
  };
}

const admin = (id: string): CurrentUser => () => Promise.resolve({ id, role: "admin" });
const REQUEST = { hostId: "h1", containerId: "c1", userId: "u-1" };

/** Plans a session and starts it; resolves once the agent stream has opened and coupled. */
async function openShell(
  f: Fixture,
  request = REQUEST,
  currentUser: CurrentUser = admin(request.userId),
  clientOptions: { backpressure?: boolean } = {}
) {
  const plan = await f.service.planSession(request);
  assert.ok(plan.ok, "the plan was refused");
  const client = browser(clientOptions);
  const running = plan.run({ size: {}, stream: client.stream, currentUser });
  await tick();
  return { client, running };
}

const call = (sessionId: string, overrides: Partial<{ userId: string; hostId: string; containerId: string }> = {}) => ({
  sessionId,
  userId: "u-1",
  hostId: "h1",
  containerId: "c1",
  ...overrides
});

/** The hub's session id, as the browser learns it from the `start` line. */
function sessionIdOf(events: unknown[]): string {
  const start = events.find((event) => (event as { kind?: string }).kind === "start") as { session: string } | undefined;
  assert.ok(start, "no start line");
  return start.session;
}

const failureOf = (result: { ok: boolean; failure?: RouteFailure }): RouteFailure => {
  assert.equal(result.ok, false, "the call was not refused");
  assert.ok(result.failure);
  return result.failure;
};

// ── The opening ──────────────────────────────────────────────────────────────

test("ein Fehler der Kette gilt vor jedem Aufruf des Agenten", async () => {
  const f = fixture({ knownHosts: [] });
  const plan = await f.service.planSession(REQUEST);
  assert.equal(plan.ok, false);
  assert.equal(failureOf(plan as never).kind, "problem");
  assert.equal(f.calls.startExec, 0);
  assert.equal(f.register.size, 0);
});

test("die start-Zeile trägt die Id des Hubs und den Namen aus der Container-Liste, nie die Id des Agenten", async () => {
  const f = fixture();
  const { client, running } = await openShell(f);

  assert.equal(client.opened(), true, "the stream was not opened when the agent stream stood");
  const start = client.events.find((event) => (event as { kind?: string }).kind === "start");
  assert.deepEqual(Object.keys(start as object).sort(), ["containerName", "kind", "session"]);
  assert.equal((start as { containerName: string }).containerName, "immich");
  assert.ok(!JSON.stringify(client.events).includes(AGENT_SESSION_ID), "the agent's session id left the server");

  f.outcome.resolve({ kind: "ended", exitCode: 0 });
  await running;
  assert.deepEqual(client.events.at(-1), { kind: "end", exitCode: 0 });
});

test("das Ende der Sitzung trägt sie aus dem Register aus und bestellt den Takt ab", async () => {
  const f = fixture();
  const { running } = await openShell(f);
  assert.equal(f.register.size, 1);
  assert.equal(f.beat.stopped, false);

  f.outcome.resolve({ kind: "ended", exitCode: 0 });
  await running;

  assert.equal(f.register.size, 0, "a corpse stayed in the register");
  assert.equal(f.beat.stopped, true, "the beat kept running after its stream ended");
});

test("ein Fehler vor dem Öffnen geht an die Route und räumt trotzdem auf", async () => {
  const f = fixture();
  f.behaviour.startExecBefore = "throw";
  const plan = await f.service.planSession(REQUEST);
  assert.ok(plan.ok);
  const client = browser();
  await assert.rejects(plan.run({ size: {}, stream: client.stream, currentUser: admin("u-1") }), AgentError);
  assert.equal(client.opened(), false);
  assert.deepEqual(client.events, [], "a failure before the stream opened was written as a line");
  assert.equal(f.register.size, 0);
});

test("reißt der Strom nach dem Öffnen ab, steht eine Zeile im Strom und kein Wurf", async () => {
  const f = fixture();
  f.behaviour.startExecBefore = "open-then-throw";
  const plan = await f.service.planSession(REQUEST);
  assert.ok(plan.ok);
  const client = browser();
  await plan.run({ size: {}, stream: client.stream, currentUser: admin("u-1") });
  assert.deepEqual(client.events, [{ kind: "error", reason: HUB_STREAM_BROKEN }]);
  assert.equal(f.register.size, 0);
});

// ── The limit ────────────────────────────────────────────────────────────────

test("die eigene Grenze weist ab, bevor der Agent angefasst wird, und zählt je Mensch", async () => {
  const f = fixture();
  for (let index = 0; index < EXEC_MAX_SESSIONS_PER_USER; index += 1) {
    assert.ok((await f.service.planSession(REQUEST)).ok);
  }
  const calls = f.calls.startExec;

  const refused = await f.service.planSession(REQUEST);
  assert.equal(refused.ok, false);
  const failure = failureOf(refused as never);
  assert.deepEqual(
    { kind: failure.kind, error: failure.kind === "problem" ? failure.error : null, status: failure.kind === "problem" ? failure.status : null },
    { kind: "problem", error: "own-session-limit", status: 429 }
  );
  assert.equal(f.calls.startExec, calls, "the agent was asked although the limit was reached");

  // Another person on the same arm still gets their shell.
  assert.ok((await f.service.planSession({ ...REQUEST, userId: "u-2" })).ok);
});

// ── Whom a session belongs to ────────────────────────────────────────────────

test("ein fremder Mensch wird bei Eingabe, Größe und Schließen abgewiesen — mit derselben Antwort wie bei einer unbekannten Id", async () => {
  const f = fixture();
  const { client, running } = await openShell(f);
  const id = sessionIdOf(client.events);
  const body = { data: "bHMK" };

  const unknown = failureOf(await f.service.sendInput(call("gibt-es-nicht"), body));
  for (const stranger of [
    await f.service.sendInput(call(id, { userId: "u-2" }), body),
    await f.service.resize(call(id, { userId: "u-2" }), {}),
    await f.service.close(call(id, { userId: "u-2" }))
  ]) {
    assert.deepEqual(failureOf(stranger), unknown, "a foreign session answered differently from an unknown one");
  }
  assert.equal(f.calls.sendInput.length + f.calls.resize.length + f.calls.closeExec.length, 0, "the agent was reached");
  assert.equal(f.register.size, 1, "a stranger closed the session of the owner");

  f.outcome.resolve({ kind: "ended", exitCode: 0 });
  await running;
});

test("Arm und Container kommen aus dem Pfad: derselbe Mensch auf einem anderen Arm oder Container wird abgewiesen", async () => {
  const f = fixture({ knownHosts: ["h1", "h2"] });
  const { client, running } = await openShell(f);
  const id = sessionIdOf(client.events);

  failureOf(await f.service.sendInput(call(id, { hostId: "h2" }), { data: "bHMK" }));
  failureOf(await f.service.sendInput(call(id, { containerId: "c2" }), { data: "bHMK" }));
  assert.equal(f.calls.sendInput.length, 0);

  f.outcome.resolve({ kind: "ended", exitCode: 0 });
  await running;
});

test("der Besitzer tippt, ändert die Größe und schließt — immer als er selbst", async () => {
  const f = fixture();
  const { client, running } = await openShell(f);
  const id = sessionIdOf(client.events);

  assert.deepEqual(await f.service.sendInput(call(id), { data: "bHMK" }), { ok: true });
  assert.deepEqual(await f.service.resize(call(id), { cols: 100, rows: 30 }), { ok: true });
  const actor = { kind: "user", id: "u-1" };
  assert.deepEqual(f.calls.sendInput, [{ session: AGENT_SESSION_ID, bytes: new Uint8Array([0x6c, 0x73, 0x0a]), actor }]);
  assert.deepEqual(f.calls.resize, [{ session: AGENT_SESSION_ID, size: { cols: 100, rows: 30 }, actor }]);

  assert.deepEqual(await f.service.close(call(id)), { ok: true });
  assert.deepEqual(f.calls.closeExec, [{ session: AGENT_SESSION_ID, actor }]);
  await running;
  assert.equal(f.register.size, 0);
  // The stream ended because the hub closed it, and the browser is told so.
  assert.deepEqual(client.events.at(-1), { kind: "error", reason: HUB_SESSION_CLOSED });
});

test("eine ungültige Eingabe wird abgelehnt und nicht als leere Eingabe durchgelassen", async () => {
  const f = fixture();
  const { client, running } = await openShell(f);
  const id = sessionIdOf(client.events);

  for (const body of [undefined, {}, { data: "" }, { data: 7 }, { data: "!!!!" }, { data: "bHM" }]) {
    const failure = failureOf(await f.service.sendInput(call(id), body));
    assert.equal(failure.kind === "problem" ? failure.error : null, "invalid-input", JSON.stringify(body));
  }
  assert.equal(f.calls.sendInput.length, 0);

  f.outcome.resolve({ kind: "ended", exitCode: 0 });
  await running;
});

test("ein Fehler des Arms bei der Eingabe geht als Wert an die Route, jeder andere Fehler nach oben", async () => {
  const f = fixture();
  const { client, running } = await openShell(f);
  const id = sessionIdOf(client.events);

  f.behaviour.shortCallError = new AgentError("too big", 413);
  const failure = failureOf(await f.service.sendInput(call(id), { data: "bHMK" }));
  assert.equal(failure.kind, "agent-error");

  f.behaviour.shortCallError = new RangeError("bug in the hub");
  await assert.rejects(f.service.sendInput(call(id), { data: "bHMK" }), RangeError);

  f.behaviour.shortCallError = null;
  f.outcome.resolve({ kind: "ended", exitCode: 0 });
  await running;
});

// ── Back-pressure ────────────────────────────────────────────────────────────

test("Eingabe und Größe gehen durch, während die Ausgabe am Gegendruck hängt", async () => {
  const f = fixture();
  const { client, running } = await openShell(f, REQUEST, admin("u-1"), { backpressure: true });
  const id = sessionIdOf(client.events);
  const settled = { value: false };
  void running.then(() => {
    settled.value = true;
  });

  // The output line is written but not accepted: the agent stream waits on it.
  assert.equal(client.events.filter((event) => (event as { kind?: string }).kind === "output").length, 1);
  assert.equal(settled.value, false);

  // Typing and resizing are requests of their own and do not queue behind it.
  assert.deepEqual(await f.service.sendInput(call(id), { data: "bHMK" }), { ok: true });
  assert.deepEqual(await f.service.resize(call(id), { cols: 100, rows: 30 }), { ok: true });
  assert.equal(f.calls.sendInput.length, 1);
  assert.equal(f.calls.resize.length, 1);
  assert.equal(f.register.size, 1, "the session was dropped while its output waited");

  // Closing under back-pressure ends the session as well.
  assert.deepEqual(await f.service.close(call(id)), { ok: true });
  client.release();
  await running;
  assert.equal(f.register.size, 0);
});

// ── Closing ──────────────────────────────────────────────────────────────────

test("das Schließen antwortet auch dann ok, wenn der Arm den Aufruf ablehnt", async () => {
  const f = fixture();
  const { client, running } = await openShell(f);
  f.behaviour.shortCallError = new AgentError("agent-read-only", 503);

  assert.deepEqual(await f.service.close(call(sessionIdOf(client.events))), { ok: true });
  await running;
  assert.equal(f.register.size, 0);
});

test("das Schließen antwortet ok, wenn der Arm inzwischen entfernt wurde, und trägt die Sitzung aus", async () => {
  const f = fixture();
  const { client, running } = await openShell(f);
  const id = sessionIdOf(client.events);

  // The arm leaves the inventory; the input route answers `session-unknown`,
  // `close` still closes.
  const gone = createShellService({
    openContainer: async () => ({ ok: false, failure: { kind: "problem", status: 404, error: "host-unknown", message: "no" } }),
    hosts: { find: async () => null, connect: async () => TARGET },
    register: f.register,
    schedule: () => () => undefined
  });
  failureOf(await gone.sendInput(call(id), { data: "bHMK" }));
  assert.deepEqual(await gone.close(call(id)), { ok: true });
  assert.equal(f.register.size, 0);
  await running;
});

// ── The permission check ─────────────────────────────────────────────────────

test("Rechteentzug schreibt die Zeile zuerst, beendet den Agenten-Strom und trägt die Sitzung aus", async () => {
  const f = fixture();
  const current: { user: { id: string; role: "admin" | "user" } | null } = { user: { id: "u-1", role: "admin" } };
  const { client, running } = await openShell(f, REQUEST, () => Promise.resolve(current.user));
  assert.ok(f.beat.task, "no beat was started when the stream opened");

  // Right still held: nothing happens.
  f.beat.task();
  await tick();
  assert.equal(f.register.size, 1);

  // Demoted to User: the next beat ends the shell.
  current.user = { id: "u-1", role: "user" };
  f.beat.task();
  await running;

  assert.deepEqual(client.events.at(-1), { kind: "error", reason: HUB_PERMISSION_REVOKED });
  assert.equal(
    client.events.filter((event) => (event as { kind?: string }).kind === "error").length,
    1,
    "a second failure line followed the revocation"
  );
  assert.equal(f.register.size, 0);
  assert.equal(f.beat.stopped, true);
});

// ── Who ended the stream ─────────────────────────────────────────────────────

test("verlässt der Browser die Seite, endet der Agenten-Strom still und ohne eigene Zeile", async () => {
  const f = fixture();
  const { client, running } = await openShell(f);
  const before = client.events.length;

  client.leave();
  await running;

  assert.equal(client.events.length, before, "a line was written to a connection that is gone");
  assert.equal(f.register.size, 0);
  assert.equal(f.beat.stopped, true);
});
