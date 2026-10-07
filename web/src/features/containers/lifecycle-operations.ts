import type { QueryClient } from "@tanstack/react-query";
import type { RuntimeServiceResult, HubContainerRuntimeResult, HubStackRuntimeResult } from "contract";
import { targetKey, targetsOverlap, type LifecycleTarget } from "./lifecycle-state";

export type OperationResult = HubContainerRuntimeResult | HubStackRuntimeResult;
export type LifecycleOperation = {
  target: LifecycleTarget;
  busy: boolean;
  phase: "preparing" | "waiting" | "running" | "done";
  message?: "ok" | "partial" | "failed" | "timeout" | "unknown" | "state-changed" | "write-ok";
  error?: string;
  progress: RuntimeServiceResult[];
  result?: OperationResult;
};
export function createOperations() {
  let state: ReadonlyMap<string, LifecycleOperation> = new Map();
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) listener(); };
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => state,
    busy: (target: LifecycleTarget) => [...state.values()].some((entry) => entry.busy && targetsOverlap(entry.target, target)),
    reserve: (target: LifecycleTarget) => {
      if ([...state.values()].some((entry) => entry.busy && targetsOverlap(entry.target, target))) return false;
      state = new Map(state).set(targetKey(target), { target, busy: true, phase: "preparing", progress: [] }); publish(); return true;
    },
    update: (target: LifecycleTarget, update: Partial<LifecycleOperation>) => {
      const key = targetKey(target); const previous = state.get(key);
      if (!previous) return;
      state = new Map(state).set(key, { ...previous, ...update }); publish();
    },
    clear: (target: LifecycleTarget | string) => {
      const key = typeof target === "string" ? target : targetKey(target); if (state.get(key)?.busy) return;
      state = new Map(state); (state as Map<string, LifecycleOperation>).delete(key); publish();
    }
  };
}
const stores = new WeakMap<QueryClient, ReturnType<typeof createOperations>>();
export function lifecycleOperations(client: QueryClient) {
  let store = stores.get(client);
  if (!store) { store = createOperations(); stores.set(client, store); }
  return store;
}
