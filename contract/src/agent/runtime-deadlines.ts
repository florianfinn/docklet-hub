import type { RuntimeAction } from "./runtime-actions.js";

export const DEFAULT_STOP_GRACE_SECONDS = 10;
export const ACTION_QUEUE_WAIT_MS = 60_000;
export const STOP_BUFFER_MS = 10_000;
export const STACK_BUFFER_MS = 30_000;
export const RESTART_START_RESERVE_MS = 30_000;
export const MAX_STOP_GRACE_MS = 10 * 60_000;
export const MAX_STACK_ACTION_MS = MAX_STOP_GRACE_MS;
export const MIN_STACK_ACTION_MS = 60_000;
export const RUNTIME_READBACK_RESERVE_MS = 30_000;
export const RUNTIME_TRANSPORT_RESERVE_MS = 30_000;
export const LIFECYCLE_DELIVERY_RESERVE_MS = 10_000;

export function stopTimeoutSeconds(value: unknown): number {
  if (value === -1) return MAX_STOP_GRACE_MS / 1000;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : DEFAULT_STOP_GRACE_SECONDS;
}

// Bound the HTTP wait without changing Docker's configured stop grace period.
export function containerActionTimeoutMs(action: RuntimeAction, stopTimeout: unknown): number {
  if (action === "start") return RESTART_START_RESERVE_MS;
  const stopDeadline = Math.min(MAX_STOP_GRACE_MS, stopTimeoutSeconds(stopTimeout) * 1000) + STOP_BUFFER_MS;
  return stopDeadline + (action === "restart" ? RESTART_START_RESERVE_MS : 0);
}

export function stackActionTimeoutMs(action: RuntimeAction, gracePeriods: readonly number[]): number {
  const longest = Math.max(DEFAULT_STOP_GRACE_SECONDS, ...gracePeriods.map(stopTimeoutSeconds));
  return Math.min(MAX_STACK_ACTION_MS, Math.max(MIN_STACK_ACTION_MS, longest * 1000 + STACK_BUFFER_MS) * (action === "restart" ? 2 : 1));
}

export const MAX_CONTAINER_ACTION_MS = containerActionTimeoutMs("restart", -1);
export const MAX_AGENT_ACTION_MS = Math.max(MAX_CONTAINER_ACTION_MS, MAX_STACK_ACTION_MS);
// Cover the longest action, including restart's start phase, before delivery.
export const HUB_RUNTIME_TIMEOUT_MS = ACTION_QUEUE_WAIT_MS + MAX_AGENT_ACTION_MS
  + RUNTIME_READBACK_RESERVE_MS + RUNTIME_TRANSPORT_RESERVE_MS;
export const LIFECYCLE_TIMEOUT_MS = HUB_RUNTIME_TIMEOUT_MS + LIFECYCLE_DELIVERY_RESERVE_MS;
