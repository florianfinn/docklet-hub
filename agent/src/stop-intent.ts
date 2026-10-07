import fs from "node:fs";
import path from "node:path";
import { constants } from "node:os";
import { stopIntentSchema, stopIntentTargetSchema, type ContainerExit, type StopIntent, type StopIntentTarget } from "contract";
import type { DockerMonitorEvent, RawInspect } from "./engine-model.js";

export const STOP_INTENT_BUFFER_MS = 5_000;
const DEFAULT_STOP_TIMEOUT_SECONDS = 10;
// Docker uses the Linux/glibc application signal range.
const LINUX_SIGRTMIN = 34;
const LINUX_SIGRTMAX = 64;
const RECENT_EXIT_LIMIT = 256;
export const STOP_INTENT_LIMIT = 256;
type PendingKill = { target: StopIntentTarget; containerId: string; atMs: number; windowMs: number; actor: string | null };
type HubStop = { actor: string | null; startedAt: number; finishedAt: number };

export function stopIntentTarget(container: RawInspect): StopIntentTarget | null {
  const labels = container.Config?.Labels;
  const projectName = labels?.["com.docker.compose.project"];
  const serviceName = labels?.["com.docker.compose.service"];
  if (projectName && serviceName) return { kind: "compose", projectName, serviceName };
  const containerName = container.Name.replace(/^\/+/, "");
  return containerName ? { kind: "container", containerName } : null;
}

export function targetKey(target: StopIntentTarget): string {
  return JSON.stringify(target.kind === "compose"
    ? [target.kind, target.projectName, target.serviceName]
    : [target.kind, target.containerName]);
}

export function stopIntentWindow(container: RawInspect): number {
  const timeout = container.Config?.StopTimeout;
  return (typeof timeout === "number" && Number.isFinite(timeout) && timeout >= 0
    ? timeout : DEFAULT_STOP_TIMEOUT_SECONDS) * 1_000 + STOP_INTENT_BUFFER_MS;
}

function signalNumber(signal: string | undefined): number | null {
  if (!signal) return null;
  if (/^\d+$/.test(signal)) return Number(signal);
  const upper = signal.toUpperCase();
  const name = upper.startsWith("SIG") ? upper : `SIG${upper}`;
  const realtime = /^SIGRT(MIN|MAX)(?:([+-])(\d+))?$/.exec(name);
  if (realtime) {
    const [, bound, direction, offset = "0"] = realtime;
    const fromMin = bound === "MIN";
    if (direction && direction !== (fromMin ? "+" : "-")) return null;
    const number = fromMin ? LINUX_SIGRTMIN + Number(offset) : LINUX_SIGRTMAX - Number(offset);
    return number >= LINUX_SIGRTMIN && number <= LINUX_SIGRTMAX ? number : null;
  }
  return constants.signals[name as keyof typeof constants.signals] ?? null;
}

export class StopIntentStore {
  private generation: string | null = null;
  private intents = new Map<string, StopIntent>();
  private kills = new Map<string, PendingKill>();
  private hubStops = new Map<string, HubStop>();
  private exits: ContainerExit[] = [];

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
    private readonly warn: (message: string) => void = (message) => console.warn(message)
  ) {
    let text: string;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("Stop intent state unreadable", { cause: error });
    }
    try {
      this.load(JSON.parse(text) as unknown);
    } catch {
      this.generation = null;
      this.intents.clear();
      this.kills.clear();
      fs.renameSync(filePath, `${filePath}.corrupt-${this.now()}-${process.hrtime.bigint()}`);
      this.syncDirectory();
      this.warn("[agent] Invalid stop intent state archived; starting with empty intent state");
    }
  }

  private load(value: unknown): void {
    const state = value as { version?: unknown; generation?: unknown; intents?: unknown; kills?: unknown };
    if (!state || state.version !== 1 || !(state.generation === null || typeof state.generation === "string")
      || !Array.isArray(state.intents) || !Array.isArray(state.kills)) throw new Error("Invalid stop intent state");
    this.generation = state.generation;
    for (const raw of state.intents) {
      const intent = stopIntentSchema.parse(raw);
      this.intents.set(targetKey(intent.target), intent);
    }
    for (const raw of state.kills) {
      const kill = raw as PendingKill;
      stopIntentTargetSchema.parse(kill.target);
      if (typeof kill.containerId !== "string" || !Number.isFinite(kill.atMs)
        || !(Number.isFinite(kill.windowMs) && kill.windowMs >= 0)
        || !(kill.actor === null || typeof kill.actor === "string")) throw new Error("Invalid pending stop intent");
      this.kills.set(kill.containerId, kill);
    }
    this.limitEntries();
  }

  setDaemonGeneration(generation: string): void {
    if (this.generation === generation) return;
    this.generation = generation;
    this.intents.clear();
    this.kills.clear();
    this.hubStops.clear();
    this.exits = [];
    this.persist();
  }

  daemonDisconnected(): void {
    this.generation = null;
    this.intents.clear();
    this.kills.clear();
    this.hubStops.clear();
    this.exits = [];
    this.persist();
  }

  // Stop routes annotate the request; only Docker's kill/die confirms intent.
  beginHubStop(containerIds: readonly string[], actor: string | null): () => void {
    const annotation: HubStop = { actor, startedAt: this.now(), finishedAt: Infinity };
    for (const id of containerIds) this.hubStops.set(id, annotation);
    return () => { annotation.finishedAt = this.now(); };
  }

  observe(event: DockerMonitorEvent, container: RawInspect): ContainerExit["kind"] | null {
    const target = stopIntentTarget(container);
    if (!target) return null;
    const atMs = event.atMs ?? this.now();
    for (const [id, annotation] of this.hubStops) {
      if (annotation.finishedAt < atMs - STOP_INTENT_BUFFER_MS) this.hubStops.delete(id);
    }
    for (const [id, kill] of this.kills) {
      if (atMs - kill.atMs > kill.windowMs) this.kills.delete(id);
    }
    if (event.action === "kill") {
      const signal = signalNumber(event.signal);
      if (signal === null || (signal !== signalNumber(container.Config?.StopSignal || "SIGTERM")
        && signal !== constants.signals.SIGKILL)) return null;
      const annotation = this.hubStops.get(event.containerId);
      const actor = annotation && atMs >= annotation.startedAt && atMs <= annotation.finishedAt
        ? annotation.actor : null;
      this.kills.set(event.containerId, { target, containerId: event.containerId, atMs, windowMs: stopIntentWindow(container), actor });
      this.persist();
      return null;
    }
    if (event.action === "start") {
      this.kills.delete(event.containerId);
      this.hubStops.delete(event.containerId);
      this.intents.delete(targetKey(target));
      this.persist();
      return null;
    }
    if (event.action !== "die") return null;
    const kill = this.kills.get(event.containerId);
    const manual = Boolean(kill && atMs >= kill.atMs && atMs - kill.atMs <= kill.windowMs);
    this.kills.delete(event.containerId);
    this.hubStops.delete(event.containerId);
    const kind = manual ? "manual-stop" : "unexpected";
    if (manual) this.intents.set(targetKey(target), {
      target, containerId: event.containerId, stoppedAt: new Date(atMs).toISOString(), actor: kill!.actor
    });
    this.exits.push({ target, containerId: event.containerId, occurredAt: new Date(atMs).toISOString(), kind });
    this.exits = this.exits.slice(-RECENT_EXIT_LIMIT);
    this.persist();
    return kind;
  }

  // Reconcile starts missed while the agent was offline, including recreate.
  reconcile(container: RawInspect): void {
    const target = stopIntentTarget(container);
    if (!target) return;
    const intent = this.intents.get(targetKey(target));
    if (intent && (container.State?.Running || Date.parse(container.State?.StartedAt ?? "") > Date.parse(intent.stoppedAt))) {
      this.intents.delete(targetKey(target));
      this.persist();
    }
  }

  // A complete inventory is needed to remove targets absent from Docker.
  reconcileInventory(containers: readonly RawInspect[]): void {
    const targets = new Set(containers.map(stopIntentTarget).filter((target) => target !== null).map(targetKey));
    const ids = new Set(containers.map((container) => container.Id));
    let changed = false;
    for (const [key] of this.intents) {
      if (!targets.has(key)) { this.intents.delete(key); changed = true; }
    }
    for (const [id] of this.kills) {
      if (!ids.has(id)) { this.kills.delete(id); changed = true; }
    }
    if (changed) this.persist();
  }

  private limitEntries(): void {
    const intents = [...this.intents.entries()].sort((a, b) => Date.parse(a[1].stoppedAt) - Date.parse(b[1].stoppedAt));
    for (const [key] of intents.slice(0, Math.max(0, intents.length - STOP_INTENT_LIMIT))) this.intents.delete(key);
    const kills = [...this.kills.entries()].sort((a, b) => a[1].atMs - b[1].atMs);
    for (const [id] of kills.slice(0, Math.max(0, kills.length - STOP_INTENT_LIMIT))) this.kills.delete(id);
  }

  list(): StopIntent[] { return structuredClone([...this.intents.values()]); }
  recentExits(): ContainerExit[] { return structuredClone(this.exits); }

  private syncDirectory(): void {
    const fd = fs.openSync(path.dirname(this.filePath), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  private persist(): void {
    this.limitEntries();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: 1, generation: this.generation, intents: this.list(), kills: [...this.kills.values()] }), "utf8");
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, this.filePath);
    this.syncDirectory();
  }
}
