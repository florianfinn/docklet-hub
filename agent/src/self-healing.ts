import { randomUUID } from "node:crypto";
import {
  SELF_HEALING_RECOMMENDATION, type ExpectedContainer, type SelfHealingCause,
  type SelfHealingConfig, type SelfHealingLog
} from "contract";
import type { DockerMonitorEvent, RawInspect } from "./engine-model.js";
import { expectedContainerMatches, runtimeStateOf } from "./runtime-actions.js";
import { StackEndpointError } from "./stack-control.js";
import { isStopSignal, stopIntentTarget, targetKey } from "./stop-intent.js";
import { SelfHealingStore, type HealingEntry } from "./self-healing-store.js";

export type HealingPorts = {
  onIncident?: (containerId: string) => void;
  config: () => SelfHealingConfig;
  eligible?: (container: RawInspect) => boolean;
  restartInProgress?: (id: string) => boolean;
  check: (id: string) => Promise<RawInspect | null>;
  inspect: (id: string) => Promise<RawInspect | null>;
  start: (id: string, expected: ExpectedContainer, signal: AbortSignal, reserve: (container: RawInspect) => void)
    => Promise<{ status: number; body: Record<string, unknown>; mutationStarted: boolean }>;
  evidence: (container: RawInspect, cause: SelfHealingCause) => Promise<{ logs: SelfHealingLog; cause: SelfHealingCause }>;
};

function expectedOf(container: RawInspect): ExpectedContainer {
  const state = runtimeStateOf(container);
  return { containerId: container.Id, status: state.status, startedAt: state.startedAt };
}
function retryPolicy(container: RawInspect): "heal" | "wait" | "observe" {
  const policy = container.HostConfig?.RestartPolicy;
  if (policy?.Name === "no" || !policy?.Name) return "heal";
  if (policy.Name !== "on-failure" || !(policy.MaximumRetryCount && policy.MaximumRetryCount > 0)) return "observe";
  return !container.State?.Running && !container.State?.Restarting && container.State?.Status === "exited"
    && (container.RestartCount ?? 0) >= policy.MaximumRetryCount ? "heal" : "wait";
}

export class SelfHealingController {
  private busy = false;
  private available = true;
  private observing = false;
  private retryAt = 0;
  private retryDelay = 1000;
  private observationLost = false;
  private shuttingDown = false;
  private abort = new AbortController();
  constructor(readonly store: SelfHealingStore, private readonly ports: HealingPorts, private readonly now: () => number = Date.now,
    private readonly monotonic: () => number = () => performance.now()) {}

  isAvailable(): boolean { return this.available; }
  setObserving(observing: boolean): void {
    if (this.shuttingDown) return;
    const lostObservation = this.observing && !observing;
    this.observing = observing;
    if (!observing) this.abort.abort();
    else if (this.abort.signal.aborted) this.abort = new AbortController();
    if (lostObservation) { this.observationLost = true; this.clearObservation(); }
  }
  shutdown(): void { this.shuttingDown = true; this.observing = false; this.abort.abort(); }
  private clearObservation(): void {
    this.store.change((state) => {
      for (const entry of state.entries) {
        entry.pending = null;
        entry.runningSince = null;
      }
    });
    this.observationLost = false;
  }
  // Internal failures retain reservations; watcher disconnects cancel pending retries separately.
  fail(): void {
    if (this.available) {
      this.retryAt = this.monotonic() + this.retryDelay;
      this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
    }
    this.available = false; this.abort.abort();
  }
  reconcileInventory(containers: readonly RawInspect[]): void {
    this.store.reconcileInventory(new Set(containers.map(stopIntentTarget).filter((target) => target !== null).map(targetKey)));
  }
  private canTrack(container: RawInspect): boolean {
    const target = stopIntentTarget(container);
    return target !== null && (this.ports.eligible?.(container) ?? true) && this.store.canTrack(target);
  }

  reconcile(container: RawInspect): void {
    const target = stopIntentTarget(container);
    if (!target) return;
    const entry = this.store.get(target);
    if (!entry) {
      if (!this.canTrack(container)) return;
      this.store.put({ target, containerId: container.Id, attempts: [], pending: null, healingStart: null,
        lastStart: { containerId: container.Id, startedAt: container.State?.StartedAt ?? null,
          restartCount: container.RestartCount ?? 0, observedAt: this.now() },
        runningSince: container.State?.Running ? this.now() : null });
      return;
    }
    const startedAt = container.State?.StartedAt ?? null;
    if (entry.lastStart && (entry.lastStart.containerId !== container.Id || entry.lastStart.startedAt !== startedAt)) {
      this.started(container, this.now());
    } else {
      // Matching StartedAt proves continuity; unknown/offline observation never creates a new failure.
      entry.containerId = container.Id;
      if (!container.State?.Running || container.State?.Restarting) entry.runningSince = null;
      else entry.runningSince ??= this.now();
      this.store.put(entry);
    }
  }

  observe(event: DockerMonitorEvent, container: RawInspect, classification: "manual-stop" | "unexpected" | null, restartRequested = false): void {
    const target = stopIntentTarget(container);
    if (!target) return;
    const at = event.atMs ?? this.now();
    if (event.action === "start") { this.started(container, at); return; }
    if (!this.store.get(target) && !this.canTrack(container)) return;
    const entry = this.store.get(target) ?? { target, containerId: container.Id, attempts: [],
      pending: null, healingStart: null, lastStart: null, runningSince: null };
    if ((event.action === "kill" && isStopSignal(container, event.signal)) || event.action === "destroy"
      || (event.action === "stop" && !restartRequested)) {
      entry.pending = null; entry.runningSince = null; this.store.put(entry); return;
    }
    if (event.action !== "die" && event.action !== "restart") return;
    if (event.action === "restart" && (classification !== "unexpected" || container.State?.Running
      || container.State?.Status !== "exited")) return;
    entry.runningSince = null;
    entry.pending = null;
    const exitCode = event.exitCode ?? container.State?.ExitCode;
    const config = this.ports.config();
    if (classification === "unexpected" && typeof exitCode === "number" && (exitCode !== 0 || restartRequested) && config.enabled
      && retryPolicy(container) !== "observe" && !this.store.maintained(target, this.now()) && !this.store.hasIncident(target)) {
      entry.pending = { id: randomUUID(), expected: expectedOf(container), occurredAt: at,
        dueAt: config.retryDelaysSeconds[entry.attempts.length] === undefined ? null
          : this.now() + config.retryDelaysSeconds[entry.attempts.length] * 1000,
        cause: { exitCode, engineError: container.State?.Error || null } };
    }
    this.store.put(entry);
  }

  private started(container: RawInspect, at: number): void {
    const target = stopIntentTarget(container);
    if (!target) return;
    let entry = this.store.get(target);
    if (!entry) { this.reconcile(container); return; }
    const startedAt = container.State?.StartedAt ?? null;
    const restartCount = container.RestartCount ?? 0;
    if (entry.lastStart?.containerId === container.Id && entry.lastStart.startedAt === startedAt
      && entry.lastStart.restartCount === restartCount) return;
    // Docker increments relative to the LAST start, while manual starts reset the count.
    const docker = entry.lastStart?.containerId === container.Id && restartCount > entry.lastStart.restartCount;
    const healing = entry.healingStart?.containerId === container.Id && at >= entry.healingStart.requestedAt
      && startedAt !== entry.healingStart.previousStartedAt;
    if (!docker && !healing) {
      this.store.refill(target, this.now(), "manual-start");
      entry = this.store.get(target)!;
    }
    entry.lastStart = { containerId: container.Id, startedAt, restartCount, observedAt: at };
    entry.containerId = container.Id;
    entry.runningSince = this.now();
    entry.healingStart = null;
    entry.pending = null;
    this.store.put(entry);
  }

  async tick(): Promise<void> {
    if (this.busy || this.shuttingDown || (!this.available && this.monotonic() < this.retryAt)) return;
    this.busy = true;
    try {
      if (!this.available) {
        if (this.observationLost) this.clearObservation();
        else this.store.change((state) => {
          for (const entry of state.entries) for (const attempt of entry.attempts) {
            if (attempt.result === "pending") attempt.result = "interrupted";
          }
        });
        this.available = true;
        if (this.observing) this.abort = new AbortController();
      }
      this.store.expire(this.now());
      if (!this.observing) {
        this.retryDelay = 1000;
        return;
      }
      for (const snapshot of this.store.entries()) {
        if (!this.observing) break;
        await this.process(snapshot);
      }
      this.retryDelay = 1000;
    } catch (error) {
      this.available = false; this.abort.abort();
      this.retryAt = this.monotonic() + this.retryDelay;
      this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
      throw error;
    }
    finally { this.busy = false; }
  }

  private async process(snapshot: HealingEntry): Promise<void> {
    const config = this.ports.config();
    const key = targetKey(snapshot.target);
    if (snapshot.runningSince !== null && snapshot.attempts.length > 0
      && this.store.isStable(snapshot, config.stabilityWindowSeconds) && !this.store.hasIncident(snapshot.target)) {
      const current = await this.ports.inspect(snapshot.containerId);
      const latest = this.store.get(snapshot.target)!;
      if (current?.State?.Running && !current.State.Restarting && latest.runningSince === snapshot.runningSince
        && current.State.StartedAt === latest.lastStart?.startedAt) this.store.refill(snapshot.target, this.now(), "stable");
    }
    let entry = this.store.get(snapshot.target)!;
    if (!entry.pending) return;
    if (!config.enabled || this.store.maintained(entry.target, this.now()) || this.store.hasIncident(entry.target)) {
      entry.pending = null; this.store.put(entry); return;
    }
    const pending = entry.pending;
    if (this.ports.restartInProgress?.(entry.containerId)) return;
    const current = await this.ports.check(entry.containerId);
    entry = this.store.get(snapshot.target)!;
    if (!entry.pending || entry.pending.id !== pending.id) return;
    if (!current || current.Id !== pending.expected.containerId || (current.State?.StartedAt ?? null) !== pending.expected.startedAt
      || retryPolicy(current) === "observe") {
      entry.pending = null; this.store.put(entry); return;
    }
    const policy = retryPolicy(current);
    if (policy === "wait") {
      // Docker's next start/die event supplies fresh evidence; a stopped state cannot promise a retry.
      entry.pending = null; this.store.put(entry); return;
    }
    if (current.State?.Running || current.State?.Restarting) return;
    if (current.State?.Status !== "exited") { entry.pending = null; this.store.put(entry); return; }
    if (!this.available || !this.observing || !this.ports.config().enabled || this.store.maintained(entry.target, this.now())) return;
    if (entry.attempts.length >= this.ports.config().attempts) {
      const evidence = await this.ports.evidence(current, pending.cause);
      const latest = this.store.get(entry.target)!;
      if (!latest.pending || latest.pending.id !== pending.id || this.store.maintained(entry.target, this.now())
        || !this.observing || !this.ports.config().enabled || latest.attempts.length < this.ports.config().attempts
        || this.store.hasIncident(entry.target)) return;
      this.store.change((state) => {
        state.incidents.push({ id: randomUUID(), target: entry.target, containerId: current.Id,
          openedAt: new Date(this.now()).toISOString(), closedAt: null, closedReason: null,
          cause: evidence.cause, logs: evidence.logs, attempts: latest.attempts,
          recommendation: SELF_HEALING_RECOMMENDATION });
        state.entries.find((item) => targetKey(item.target) === key)!.pending = null;
      });
      this.ports.onIncident?.(current.Id);
      return;
    }
    if (pending.dueAt === null) {
      entry.pending!.dueAt = this.now() + this.ports.config().retryDelaysSeconds[entry.attempts.length] * 1000;
      this.store.put(entry);
      return;
    }
    if (!this.store.isDue(entry)) return;
    const expected = expectedOf(current);
    const number = entry.attempts.length + 1;
    let reservationAt: string | null = null;
    let reservationFailure: unknown;
    const result = await this.ports.start(current.Id, expected, this.abort.signal, (before) => {
      const latest = this.store.get(entry.target)!;
      if (!this.available || !this.observing || this.ports.restartInProgress?.(before.Id) || !this.ports.config().enabled || number > this.ports.config().attempts
        || this.store.maintained(entry.target, this.now()) || !latest.pending || latest.pending.id !== pending.id || latest.attempts.length !== number - 1
        || !expectedContainerMatches(expected, runtimeStateOf(before)) || before.State?.Running || retryPolicy(before) !== "heal") {
        throw new StackEndpointError(409, "state-changed");
      }
      reservationAt = new Date(this.now()).toISOString();
      latest.attempts.push({ attempt: number, startedAt: reservationAt, finishedAt: null, result: "pending", error: null });
      latest.healingStart = { containerId: before.Id, previousStartedAt: before.State?.StartedAt ?? null, requestedAt: this.now() };
      const nextDelay = this.ports.config().retryDelaysSeconds[number];
      latest.pending = { ...pending, dueAt: nextDelay === undefined ? null : this.now() + nextDelay * 1000 };
      try { this.store.put(latest); }
      catch (error) { reservationFailure = error; throw error; }
    });
    if (reservationFailure !== undefined) throw reservationFailure;
    const latest = this.store.get(entry.target)!;
    const attempt = latest.attempts.find((item) => item.attempt === number && item.startedAt === reservationAt);
    if (!attempt) {
      if (!this.shuttingDown && !result.mutationStarted && latest.pending?.id === pending.id && latest.attempts.length < this.ports.config().attempts) {
        latest.pending = null; this.store.put(latest);
      }
      return;
    }
    if (!result.mutationStarted) {
      // Persisted reservations count only once the engine call has begun.
      latest.attempts = latest.attempts.filter((item) => item !== attempt);
      latest.healingStart = entry.healingStart;
      if (latest.pending?.id === pending.id) latest.pending = pending;
      this.store.put(latest);
      return;
    }
    attempt.finishedAt = new Date(this.now()).toISOString();
    attempt.result = result.status === 200 ? "ok" : "failed";
    attempt.error = result.status === 200 ? null : String(result.body.error ?? "internal-error");
    this.store.put(latest);
    // A refused engine start has no die event. Its next bounded attempt still uses the original failure.
    if (result.status !== 200 && latest.healingStart) {
      const fresh = await this.ports.inspect(current.Id);
      const updated = this.store.get(entry.target)!;
      if (fresh && expectedContainerMatches(expected, runtimeStateOf(fresh)) && updated.healingStart
        && updated.pending?.id === pending.id && !this.store.maintained(updated.target, this.now())) {
        updated.healingStart = null;
        const nextDelay = this.ports.config().retryDelaysSeconds[updated.attempts.length];
        updated.pending = { ...pending, expected: expectedOf(fresh),
          dueAt: nextDelay === undefined ? null : this.now() + nextDelay * 1000 };
        this.store.put(updated);
      }
    }
  }
}
