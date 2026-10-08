import * as z from "zod/mini";

export const UPDATE_START_DEADLINE_SECONDS = { default: 120, min: 10, max: 1800 } as const;
export const updateStartDeadlineSchema = z.int().check(
  z.minimum(UPDATE_START_DEADLINE_SECONDS.min), z.maximum(UPDATE_START_DEADLINE_SECONDS.max)
);
export const UPDATE_STABILITY_WINDOW_MS = 30_000;
export const UPDATE_PREVIEW_TIMEOUT_MS = 60_000;
export const UPDATE_PREVIEW_MANIFEST_MODE = "parallel";
export const UPDATE_PRECHECK_TIMEOUT_MS = 60_000;
export const UPDATE_PULL_TIMEOUT_MS = 15 * 60_000;
export const BACKUP_COPY_TIMEOUT_MS = 60 * 60_000;
export const UPDATE_STOP_TIMEOUT_MS = 10 * 60_000;
export const UPDATE_CREATE_TIMEOUT_MS = 90_000;
export const UPDATE_READBACK_TIMEOUT_MS = 30_000;
export const UPDATE_MUTATION_RESERVE_MS = UPDATE_STOP_TIMEOUT_MS + UPDATE_CREATE_TIMEOUT_MS + UPDATE_READBACK_TIMEOUT_MS;
export const BACKUP_PHASE_TIMEOUT_MS = BACKUP_COPY_TIMEOUT_MS + UPDATE_MUTATION_RESERVE_MS;

function startBudgetMs(startDeadlineSeconds: number): number {
  if (!Number.isInteger(startDeadlineSeconds) || startDeadlineSeconds < UPDATE_START_DEADLINE_SECONDS.min
    || startDeadlineSeconds > UPDATE_START_DEADLINE_SECONDS.max) throw new RangeError("Invalid update start deadline");
  return Math.max(startDeadlineSeconds * 1000, UPDATE_STABILITY_WINDOW_MS);
}

// Each service gets its own mutation and verification budget, including on rollback.
export function updateExchangeTimeoutMs(startDeadlineSeconds: number): number {
  return UPDATE_MUTATION_RESERVE_MS + startBudgetMs(startDeadlineSeconds);
}
export function updateRollbackTimeoutMs(startDeadlineSeconds: number): number {
  return UPDATE_MUTATION_RESERVE_MS + startBudgetMs(startDeadlineSeconds);
}
export function restorePhaseTimeoutMs(startDeadlineSeconds: number): number {
  return BACKUP_PHASE_TIMEOUT_MS + startBudgetMs(startDeadlineSeconds);
}

// Reserve recovery for every service, including a stop for a backup before exchange.
export function updateRunBudgetMs(services: readonly { startDeadlineSeconds: number; backup: boolean }[]): number {
  return services.reduce((total, service) => total + UPDATE_PRECHECK_TIMEOUT_MS + UPDATE_PULL_TIMEOUT_MS
    + (service.backup ? BACKUP_PHASE_TIMEOUT_MS : 0) + updateExchangeTimeoutMs(service.startDeadlineSeconds)
    + updateRollbackTimeoutMs(service.startDeadlineSeconds), 0) + UPDATE_READBACK_TIMEOUT_MS;
}
