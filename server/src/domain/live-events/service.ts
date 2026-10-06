import { monitorEventLineSchema, readNdjson, type ContainerEntry, type LiveAction, type LiveEvent, type LiveStatus } from "contract";
import { createRecreateBatch } from "./recreate.js";

export type LiveHost = { id: string; agentUrl: string; state: "pending" | "registered" };
export type RefreshTarget = { containerId: string } | { project: string } | { host: true };
export type LiveListener = (event: LiveEvent | null) => void;
export type LiveEvents = {
  subscribe: (listener: LiveListener) => () => void;
  reconcile: (hosts: readonly LiveHost[]) => Promise<void>;
  removeHost: (hostId: string) => void;
  disconnectHost: (hostId: string) => void;
  refresh: (hostId: string, target: RefreshTarget, options?: { resync?: boolean }) => Promise<ContainerEntry[]>;
  stop: () => Promise<void>;
};
export type LiveEventsDeps = {
  open: (host: LiveHost, signal: AbortSignal) => Promise<Response>;
  read: (hostId: string) => Promise<ContainerEntry[]>;
  resync: (hostId: string) => Promise<void>;
  onError?: (error: unknown) => void;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
};

type Subscription = { host: LiveHost; abort: AbortController; task: Promise<void>; status: LiveStatus; attempt?: AbortController };
export const LIVE_BACKOFF_MAX_MS = 30_000;
export function liveBackoffMs(failures: number): number {
  return Math.min(1_000 * 2 ** Math.min(failures, 5), LIVE_BACKOFF_MAX_MS);
}
export function monitorAction(action: string): LiveAction | null {
  if (action === "health_status" || action.startsWith("health_status:")) return "health";
  if (action === "create" || action === "destroy" || action === "recreate") return "recreate";
  return ["start", "stop", "restart", "die"].includes(action) ? action as LiveAction : null;
}

export function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    timer.unref();
    signal.addEventListener("abort", done, { once: true });
  });
}

export function createLiveEvents(deps: LiveEventsDeps): LiveEvents {
  const subscriptions = new Map<string, Subscription>();
  const listeners = new Set<LiveListener>();
  const removed = new Set<string>();
  const reads = new Map<string, Promise<ContainerEntry[]>>();
  const wait = deps.wait ?? abortableWait;
  const now = deps.now ?? Date.now;
  let stopped = false;
  let initialized = false;
  let reconciliation = Promise.resolve();
  const deliver = (listener: LiveListener, event: LiveEvent | null) => {
    try { listener(event); } catch { listeners.delete(listener); }
  };
  const emit = (event: LiveEvent) => { for (const listener of [...listeners]) deliver(listener, event); };
  const active = (entry: Subscription) => !stopped && !entry.abort.signal.aborted;
  const status = (entry: Subscription, value: LiveStatus) => {
    if (!active(entry)) return;
    entry.status = value;
    emit({ kind: "status", hostId: entry.host.id, status: value });
  };
  const read = (hostId: string): Promise<ContainerEntry[]> => {
    const pending = reads.get(hostId);
    if (pending) return pending;
    const task = deps.read(hostId).finally(() => { if (reads.get(hostId) === task) reads.delete(hostId); });
    reads.set(hostId, task);
    return task;
  };
  const removeHost = (hostId: string) => {
    removed.add(hostId);
    const entry = subscriptions.get(hostId);
    if (!entry || entry.abort.signal.aborted) return;
    entry.abort.abort();
    emit({ kind: "removed", hostId });
  };

  async function run(entry: Subscription): Promise<void> {
    let failures = 0;
    while (active(entry)) {
      const attempt = new AbortController();
      entry.attempt = attempt;
      const abort = () => attempt.abort();
      entry.abort.signal.addEventListener("abort", abort, { once: true });
      let response: Response | undefined;
      let connectedAt: number | null = null;
      const recreate = createRecreateBatch({
        signal: attempt.signal, wait,
        resync: () => deps.resync(entry.host.id),
        changed: () => {
          if (active(entry)) emit({ kind: "changed", hostId: entry.host.id, containerIds: [], action: "recreate" });
        },
        onError: (error) => {
          if (active(entry) && !attempt.signal.aborted) { deps.onError?.(error); attempt.abort(); }
        }
      });
      try {
        response = await deps.open(entry.host, attempt.signal);
        if (!response.ok || !response.body) throw new Error("monitor-stream-unavailable");
        if (!active(entry)) break;
        // Open first: events occurring during the snapshot remain in the bounded transport buffer.
        await deps.resync(entry.host.id);
        if (!active(entry)) break;
        await read(entry.host.id);
        if (!active(entry)) break;
        if (attempt.signal.aborted) throw new Error("monitor-stream-interrupted");
        connectedAt = now();
        status(entry, "connected");
        emit({ kind: "changed", hostId: entry.host.id, containerIds: [], action: "refresh" });
        await readNdjson(response.body, { signal: attempt.signal }, (raw) => {
          const parsed = monitorEventLineSchema.safeParse(raw);
          if (!parsed.success || !parsed.data.containerId) return;
          const action = monitorAction(parsed.data.action);
          if (!action) return;
          if (action === "recreate") { recreate.schedule(); return; }
          if (active(entry) && !attempt.signal.aborted) emit({ kind: "changed", hostId: entry.host.id, containerIds: [parsed.data.containerId], action });
        });
        if (active(entry) && !attempt.signal.aborted) throw new Error("monitor-stream-ended");
      } catch (error) {
        if (active(entry) && !attempt.signal.aborted) deps.onError?.(error);
      } finally {
        attempt.abort();
        await recreate.settled();
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
        entry.abort.signal.removeEventListener("abort", abort);
      }
      if (!active(entry)) break;
      status(entry, "disconnected");
      if (connectedAt !== null && now() - connectedAt >= LIVE_BACKOFF_MAX_MS) failures = 0;
      await wait(liveBackoffMs(failures++), entry.abort.signal);
    }
  }

  return {
    subscribe: (listener) => {
      if (stopped) { listener(null); return () => undefined; }
      listeners.add(listener);
      if (initialized) deliver(listener, { kind: "snapshot", hosts: [...subscriptions.values()].filter(active).map((entry) => ({ hostId: entry.host.id, status: entry.status })) });
      return () => { listeners.delete(listener); };
    },
    reconcile: (hosts) => {
      reconciliation = reconciliation.then(async () => {
        if (stopped) return;
        for (const id of removed) if (!hosts.some((host) => host.id === id)) removed.delete(id);
        const wanted = new Map(hosts.filter((host) => host.state === "registered" && !removed.has(host.id)).map((host) => [host.id, host]));
        for (const [id, entry] of subscriptions) {
          const host = wanted.get(id);
          if (!host || host.agentUrl !== entry.host.agentUrl || entry.abort.signal.aborted) {
            entry.abort.abort();
            if (!host) emit({ kind: "removed", hostId: id });
            await entry.task;
            subscriptions.delete(id);
          }
        }
        for (const [id, host] of wanted) {
          if (subscriptions.has(id) || stopped) continue;
          const entry: Subscription = { host, abort: new AbortController(), task: Promise.resolve(), status: "connecting" };
          subscriptions.set(id, entry);
          status(entry, "connecting");
          entry.task = run(entry);
        }
        if (!initialized && !stopped) {
          initialized = true;
          emit({ kind: "snapshot", hosts: [...subscriptions.values()].filter(active).map((entry) => ({ hostId: entry.host.id, status: entry.status })) });
        }
      });
      return reconciliation;
    },
    removeHost,
    disconnectHost: (hostId) => { subscriptions.get(hostId)?.attempt?.abort(); },
    refresh: async (hostId, target, options) => {
      if (stopped) throw new Error("live-events-stopped");
      const entry = subscriptions.get(hostId);
      if (!entry || !active(entry)) throw new Error("host-unknown");
      // A follow-up read must start after the action, not reuse a pre-action snapshot.
      await reads.get(hostId)?.catch(() => undefined);
      if (!active(entry)) throw new Error("host-unknown");
      if (options?.resync !== false) await deps.resync(hostId);
      if (!active(entry)) throw new Error("host-unknown");
      const containers = await read(hostId);
      const selected = containers.filter((container) =>
        "host" in target || ("containerId" in target ? container.id === target.containerId : container.compose?.project === target.project));
      if (active(entry)) emit({ kind: "changed", hostId, containerIds: "containerId" in target ? [target.containerId] : selected.map((container) => container.id), action: "refresh" });
      return selected;
    },
    stop: async () => {
      stopped = true;
      for (const entry of subscriptions.values()) entry.abort.abort();
      for (const listener of [...listeners]) deliver(listener, null);
      listeners.clear();
      await Promise.all([...subscriptions.values()].map((entry) => entry.task));
      subscriptions.clear();
      await reconciliation;
    }
  };
}
