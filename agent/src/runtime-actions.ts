import type {
  ExpectedContainer, RuntimeAction, RuntimeOutcome, RuntimeServiceResult, RuntimeState
} from "contract";
import type { RawInspect } from "./engine-model.js";

export const ACTION_QUEUE_WAIT_MS = 60_000;
export const STOP_BUFFER_MS = 10_000;
export const STACK_BUFFER_MS = 30_000;
export const RESTART_START_RESERVE_MS = 30_000;
export const MAX_STACK_ACTION_MS = 10 * 60_000;

export function stopTimeoutSeconds(value: unknown): number {
  if (value === -1) return MAX_STACK_ACTION_MS / 1000;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 10;
}

export function containerActionTimeoutMs(action: RuntimeAction, stopTimeout: unknown): number {
  if (action === "start") return RESTART_START_RESERVE_MS;
  const stopDeadline = stopTimeoutSeconds(stopTimeout) * 1000 + STOP_BUFFER_MS;
  return stopDeadline + (action === "restart" ? RESTART_START_RESERVE_MS : 0);
}

// Compose normalizes durations as Go duration strings, including fractions.
export function gracePeriodSeconds(value: unknown): number {
  if (typeof value !== "string") return 10;
  const units: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 0.001, us: 0.000001, "µs": 0.000001, ns: 0.000000001 };
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|us|µs|ns|h|m|s)/g)];
  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== value) return 10;
  const seconds = parts.reduce((sum, part) => sum + Number(part[1]) * units[part[2]], 0);
  return Number.isFinite(seconds) ? seconds : 10;
}

export function stackActionTimeoutMs(action: RuntimeAction, gracePeriods: readonly number[]): number {
  const longest = Math.max(10, ...gracePeriods.map(stopTimeoutSeconds));
  return Math.min(MAX_STACK_ACTION_MS, Math.max(60_000, longest * 1000 + STACK_BUFFER_MS) * (action === "restart" ? 2 : 1));
}

export function runtimeStateOf(inspect: RawInspect | null, unreadable = false): RuntimeState {
  return {
    containerId: inspect?.Id ?? null,
    status: inspect?.State?.Restarting ? "restarting" : inspect?.State?.Status ?? (unreadable ? "unknown" : "missing"),
    exitCode: inspect?.State?.ExitCode ?? null,
    health: inspect?.State?.Health?.Status ?? null,
    startedAt: inspect?.State?.StartedAt ?? null
  };
}

export function expectedContainerMatches(expected: ExpectedContainer, state: RuntimeState): boolean {
  return expected.containerId === state.containerId && expected.status === state.status && expected.startedAt === state.startedAt;
}

export function runtimeTargetReached(action: RuntimeAction, state: RuntimeState): boolean {
  if (!state.containerId) return action === "stop" && state.status === "missing";
  if (action === "stop") return state.status === "exited" || state.status === "created";
  return state.status === "running" || (state.status === "exited" && state.exitCode === 0);
}

export function serviceResult(
  action: RuntimeAction, serviceName: string, state: RuntimeState, externallyManaged: boolean
): RuntimeServiceResult {
  return {
    serviceName, ...state,
    outcome: action !== "stop" && externallyManaged && state.status === "missing"
      ? "not-created-externally-managed"
      : runtimeTargetReached(action, state) ? "ok" : "failed"
  };
}

export function runtimeOutcome(services: readonly RuntimeServiceResult[]): RuntimeOutcome {
  const succeeded = services.filter((service) => service.outcome === "ok").length;
  return succeeded === 0 ? "failed" : succeeded === services.length ? "ok" : "partial";
}
