import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  stopIntentTargetSchema, expectedContainerSchema, selfHealingAttemptSchema, selfHealingCauseSchema,
  selfHealingMaintenanceSchema, selfHealingIncidentSchema,
  type SelfHealingConfig, type SelfHealingMaintenanceTarget, type SelfHealingStatusResponse, type StopIntentTarget,
  type ExpectedContainer, type SelfHealingAttempt, type SelfHealingCause, type SelfHealingMaintenance, type SelfHealingIncident
} from "contract";
import { targetKey } from "./stop-intent.js";

export type HealingEntry = {
  target: StopIntentTarget; containerId: string; attempts: SelfHealingAttempt[];
  lastStart: { containerId: string; startedAt: string | null; restartCount: number; observedAt: number } | null;
  runningSince: number | null;
  healingStart: { containerId: string; previousStartedAt: string | null; requestedAt: number } | null;
  pending: { id: string; expected: ExpectedContainer; dueAt: number | null; occurredAt: number; cause: SelfHealingCause } | null;
};
type State = { version: 1; entries: HealingEntry[]; maintenance: SelfHealingMaintenance[]; incidents: SelfHealingIncident[] };
const timestamp = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const textOrNull = (value: unknown) => value === null || typeof value === "string";

function validateState(value: unknown): State {
  const state = value as State;
  if (!state || state.version !== 1 || !Array.isArray(state.entries) || !Array.isArray(state.maintenance)
    || !Array.isArray(state.incidents)) throw new Error("Invalid self-healing state");
  const keys = new Set<string>();
  for (const entry of state.entries) {
    stopIntentTargetSchema.parse(entry.target);
    if (keys.has(targetKey(entry.target))) throw new Error("Duplicate self-healing target");
    keys.add(targetKey(entry.target));
    if (typeof entry.containerId !== "string" || !Array.isArray(entry.attempts) || entry.attempts.length > 10
      || !(entry.runningSince === null || timestamp(entry.runningSince))) throw new Error("Invalid healing budget");
    entry.attempts.forEach((attempt) => selfHealingAttemptSchema.parse(attempt));
    if (entry.lastStart !== null) {
      const start = entry.lastStart;
      if (!start || typeof start.containerId !== "string" || !textOrNull(start.startedAt) || !timestamp(start.observedAt)
        || !Number.isSafeInteger(start.restartCount) || start.restartCount < 0) throw new Error("Invalid observed start");
    }
    if (entry.healingStart !== null) {
      const start = entry.healingStart;
      if (!start || typeof start.containerId !== "string" || !textOrNull(start.previousStartedAt)
        || !timestamp(start.requestedAt)) throw new Error("Invalid healing start");
    }
    if (entry.pending !== null) {
      const pending = entry.pending;
      if (!pending || typeof pending.id !== "string" || !(pending.dueAt === null || timestamp(pending.dueAt)) || !timestamp(pending.occurredAt)) throw new Error("Invalid scheduled healing");
      expectedContainerSchema.parse(pending.expected);
      selfHealingCauseSchema.parse(pending.cause);
    }
  }
  const maintenanceKeys = new Set<string>();
  for (const item of state.maintenance) {
    selfHealingMaintenanceSchema.parse(item);
    const key = maintenanceKey(item.target);
    if (maintenanceKeys.has(key)) throw new Error("Duplicate maintenance target");
    maintenanceKeys.add(key);
  }
  const openTargets = new Set<string>();
  for (const incident of state.incidents) {
    selfHealingIncidentSchema.parse(incident);
    if (incident.closedAt === null) {
      const key = targetKey(incident.target);
      if (openTargets.has(key)) throw new Error("Duplicate open incident");
      openTargets.add(key);
    }
  }
  return state;
}
export function maintenanceKey(target: SelfHealingMaintenanceTarget): string {
  return target.kind === "stack" ? JSON.stringify(["stack", target.projectName]) : targetKey(target);
}

export class SelfHealingStore {
  private state: State = { version: 1, entries: [], maintenance: [], incidents: [] };
  constructor(private readonly file: string) {
    try {
      this.state = validateState(JSON.parse(fs.readFileSync(file, "utf8")));
      fs.chmodSync(file, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Reservations survive a crash; never repeat an uncertain engine mutation for free.
    if (this.state.entries.some((entry) => entry.attempts.some((attempt) => attempt.result === "pending"))) {
      this.change((state) => {
        for (const entry of state.entries) for (const attempt of entry.attempts) {
          if (attempt.result === "pending") attempt.result = "interrupted";
        }
      });
    }
  }
  entries(): HealingEntry[] { return structuredClone(this.state.entries); }
  get(target: StopIntentTarget): HealingEntry | undefined {
    return this.entries().find((entry) => targetKey(entry.target) === targetKey(target));
  }
  put(entry: HealingEntry): void {
    this.change((state) => {
      const index = state.entries.findIndex((item) => targetKey(item.target) === targetKey(entry.target));
      if (index < 0) state.entries.push(entry); else state.entries[index] = entry;
    });
  }
  change(update: (state: State) => void): void {
    const next = structuredClone(this.state);
    update(next);
    // Closed incidents form a bounded handoff history; open incidents are never discarded.
    next.incidents = [...next.incidents.filter((item) => item.closedAt !== null).slice(-256),
      ...next.incidents.filter((item) => item.closedAt === null)];
    validateState(next);
    const directory = path.dirname(this.file);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file);
      const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      this.state = next;
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  expire(now: number): void {
    if (this.state.maintenance.some((item) => item.expiresAt !== null && Date.parse(item.expiresAt) <= now)) {
      this.change((state) => { state.maintenance = state.maintenance.filter((item) => item.expiresAt === null || Date.parse(item.expiresAt) > now); });
    }
  }
  maintained(target: StopIntentTarget, now: number): boolean {
    this.expire(now);
    return this.state.maintenance.some((item) => maintenanceKey(item.target) === targetKey(target)
      || (target.kind === "compose" && item.target.kind === "stack" && item.target.projectName === target.projectName));
  }
  setMaintenance(target: SelfHealingMaintenanceTarget, duration: number | null, actor: string | null, now: number): void {
    this.change((state) => {
      state.maintenance = state.maintenance.filter((item) => maintenanceKey(item.target) !== maintenanceKey(target));
      state.maintenance.push({ target, startedAt: new Date(now).toISOString(),
        expiresAt: duration === null ? null : new Date(now + duration * 1000).toISOString(), actor });
      // Entering maintenance discards scheduled failures, including new stack services.
      for (const entry of state.entries) if (maintenanceKey(target) === targetKey(entry.target)
        || (target.kind === "stack" && entry.target.kind === "compose" && target.projectName === entry.target.projectName)) entry.pending = null;
    });
  }
  clearMaintenance(target: SelfHealingMaintenanceTarget): void {
    this.change((state) => { state.maintenance = state.maintenance.filter((item) => maintenanceKey(item.target) !== maintenanceKey(target)); });
  }
  refill(target: StopIntentTarget, now: number, reason: "manual-start" | "acknowledged" | "stable"): void {
    this.change((state) => {
      const entry = state.entries.find((item) => targetKey(item.target) === targetKey(target));
      if (entry) { entry.attempts = []; entry.pending = null; entry.healingStart = null; }
      if (reason !== "stable") for (const incident of state.incidents) {
        if (targetKey(incident.target) === targetKey(target) && incident.closedAt === null) {
          incident.closedAt = new Date(now).toISOString(); incident.closedReason = reason;
        }
      }
    });
  }
  hasIncident(target: StopIntentTarget): boolean {
    return this.state.incidents.some((item) => targetKey(item.target) === targetKey(target) && item.closedAt === null);
  }
  status(config: SelfHealingConfig, observing: boolean, now: number): SelfHealingStatusResponse {
    this.expire(now);
    return structuredClone({ observing, budgets: this.state.entries.map((entry) => ({
      target: entry.target, containerId: entry.containerId, usedAttempts: entry.attempts.length,
      remainingAttempts: Math.max(0, config.attempts - entry.attempts.length), attempts: entry.attempts,
      nextAttemptAt: entry.pending?.dueAt != null ? new Date(entry.pending.dueAt).toISOString() : null,
      runningSince: entry.runningSince === null ? null : new Date(entry.runningSince).toISOString()
    })), maintenance: this.state.maintenance, incidents: this.state.incidents });
  }
}
