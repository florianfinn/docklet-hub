import { ApiError, errorCode } from "../../platform/http/transport";
import type { LifecycleTarget } from "./lifecycle-state";
import { useLifecycleState } from "./use-lifecycle";

export function useLifecycleWrite(target: LifecycleTarget, reload: () => Promise<unknown>) {
  const { operations, signal } = useLifecycleState(target);
  return async (write: (signal?: AbortSignal) => Promise<unknown>) => {
    if (!operations.reserve(target)) return;
    operations.update(target, { phase: "running" });
    try {
      await write(signal); signal?.throwIfAborted();
      operations.update(target, { phase: "done", message: "write-ok" });
    } catch (error) {
      if (signal?.aborted) return;
      operations.update(target, { phase: "done", message: error instanceof ApiError ? "failed" : "unknown", error: errorCode(error) ?? undefined });
    } finally { if (!signal?.aborted) { await reload().catch(() => undefined); operations.update(target, { busy: false }); } }
  };
}
