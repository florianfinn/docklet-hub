import type { LifecycleBlocker } from "./lifecycle-state";
export const BLOCKER_MESSAGES = {
  offline: "lifecycleOffline", role: "lifecycleRole", "read-only": "lifecycleReadOnly",
  "not-allowlisted": "lifecycleNotAllowlisted", "observe-only": "lifecycleObserveOnly", "self-management-locked": "lifecycleSelfLocked",
  capability: "lifecycleCapability", busy: "lifecycleBusy", "unknown-state": "lifecycleUnknownState",
  "already-running": "lifecycleAlreadyRunning", "already-stopped": "lifecycleAlreadyStopped", completed: "lifecycleCompleted"
} as const satisfies Record<LifecycleBlocker, string>;
export const ACTION_MESSAGES = { start: "lifecycleStart", stop: "lifecycleStop", restart: "lifecycleRestart" } as const;
export const SERVICE_MESSAGES = { ok: "lifecycleServiceOk", failed: "lifecycleServiceFailed",
  "not-created-externally-managed": "lifecycleNotCreated" } as const;
export const RESULT_MESSAGES = {
  ok: "lifecycleOk", partial: "lifecyclePartial", failed: "lifecycleFailed", timeout: "lifecycleTimeout", unknown: "lifecycleUnknownResult",
  "state-changed": "lifecycleStateChanged", "write-ok": "lifecycleWriteOk"
} as const;
