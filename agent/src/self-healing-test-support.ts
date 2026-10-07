import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { DEFAULT_SELF_HEALING_CONFIG, type SelfHealingConfig, type SelfHealingCause, type SelfHealingLog } from "contract";
import { SelfHealingStore } from "./self-healing-store.js";
import { SelfHealingController, type HealingPorts } from "./self-healing.js";
import { StopIntentStore, stopIntentTarget } from "./stop-intent.js";
import type { RawInspect, DockerMonitorEvent } from "./engine-model.js";

export function healingFixture(t: TestContext, policy = "no", maximum = 0) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "healing-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");
  let monotonic = 0;
  let now = 1_800_000_000_000;
  let config: SelfHealingConfig = { ...DEFAULT_SELF_HEALING_CONFIG, retryDelaysSeconds: [1, 2, 3], stabilityWindowSeconds: 10 };
  let current: RawInspect = { Id: "a".repeat(64), Name: "/demo-web", Config: { Labels: {} }, RestartCount: 0,
    HostConfig: { RestartPolicy: { Name: policy, MaximumRetryCount: maximum } },
    State: { Status: "running", Running: true, StartedAt: new Date(now - 1000).toISOString(), ExitCode: 0 } };
  let blocked = false;
  let failures = false;
  let starts = 0;
  let logCalls = 0;
  const incidentChanges: string[] = [];
  let evidence: { logs: SelfHealingLog; cause: SelfHealingCause } | null = null;
  let store = new SelfHealingStore(file, () => now, () => monotonic);
  let intents = new StopIntentStore(path.join(directory, "intents.json"), () => now);
  let controller: SelfHealingController;
  const ports: HealingPorts = {
    config: () => structuredClone(config),
    restartInProgress: (id) => intents.isHubRestartActive(id),
    onIncident: (id) => incidentChanges.push(id),
    check: async () => blocked ? null : structuredClone(current),
    inspect: async () => structuredClone(current),
    start: async (_id, expected, _signal, reserve) => {
      if (blocked) return { status: 403, body: { error: "observe-only" }, mutationStarted: false };
      try { reserve(structuredClone(current)); }
      catch { return { status: 409, body: { error: "state-changed" }, mutationStarted: false }; }
      starts++;
      if (failures) return { status: 503, body: { error: "engine-action-failed" }, mutationStarted: true };
      current.State = { ...current.State, Running: true, Status: "running", StartedAt: new Date(now).toISOString(), ExitCode: 0 };
      current.RestartCount = 0;
      emit("start");
      return { status: 200, body: { ok: true, state: current.State, expected }, mutationStarted: true };
    },
    evidence: async (_container, cause) => { logCalls++; return evidence ?? { logs: { available: true, lines: ["synthetic log"] }, cause }; }
  };
  const emit = (action: DockerMonitorEvent["action"], exitCode?: number) => {
    const event: DockerMonitorEvent = { action, containerId: current.Id, atMs: now, ...(action === "kill" ? { signal: "15" } : {}), ...(exitCode === undefined ? {} : { exitCode }) };
    const restarting = intents.restartRequested(event);
    controller.observe(event, structuredClone(current), intents.observe(event, current), restarting);
  };
  const setup = () => {
    controller = new SelfHealingController(store, ports, () => now, () => monotonic);
    controller.reconcile(current);
    controller.setObserving(true);
  };
  setup();
  return {
    file, directory, ports, incidentChanges, get controller() { return controller; }, get store() { return store; },
    get current() { return current; }, set current(value: RawInspect) { current = value; },
    get config() { return config; }, set config(value: SelfHealingConfig) { config = value; },
    get intents() { return intents; },
    target: () => stopIntentTarget(current)!, now: () => now,
    advance: (ms: number) => { now += ms; monotonic += ms; },
    jump: (ms: number) => { now += ms; },
    monotonic: () => monotonic,
    emit, crash: (exitCode = 1) => {
      current.State = { ...current.State, Running: false, Restarting: false, Status: "exited", ExitCode: exitCode, Error: "synthetic engine error" };
      emit("die", exitCode);
    },
    manualStart: (count = 0) => {
      now++;
      current.RestartCount = count;
      current.State = { ...current.State, Running: true, Restarting: false, Status: "running", StartedAt: new Date(now).toISOString() };
      emit("start");
    },
    restart: () => { store = new SelfHealingStore(file, () => now, () => monotonic); intents = new StopIntentStore(path.join(directory, "intents.json"), () => now); setup(); },
    block: (value = true) => { blocked = value; }, failStarts: () => { failures = true; },
    evidence: (value: typeof evidence) => { evidence = value; }, starts: () => starts, logCalls: () => logCalls,
    status: () => store.status(config, controller.isAvailable(), now)
  };
}
