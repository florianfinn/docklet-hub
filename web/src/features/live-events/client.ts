import type { QueryClient } from "@tanstack/react-query";
import type { HostOverview, HostView, LiveEvent } from "contract";

import { retainHostOverview, type LiveState } from "../../domain/hosts";
import { queryKeys } from "../../platform/query/query-keys";
import { ApiError } from "../../platform/http/transport";
import { reportUnauthorized } from "../../platform/http/session-expiry";
import { fetchLiveHostOverview, readLiveEvents } from "./api";

export type LiveClientDeps = {
  read?: typeof readLiveEvents;
  overview?: typeof fetchLiveHostOverview;
  retryMs?: (failures: number) => number;
};
export function connectLiveEvents(client: QueryClient, deps: LiveClientDeps = {}): () => void {
  const controller = new AbortController();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const refreshing = new Set<string>();
  const dirty = new Set<string>();
  const deferred = new Set<string>();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let silence: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const updateState = (update: (state: LiveState) => LiveState) => {
    if (!controller.signal.aborted) client.setQueryData<LiveState>(queryKeys.hosts.live(), (state) => update(state ?? { transport: false, hosts: {} }));
  };
  const schedule = (hostId: string) => {
    if (pending.has(hostId) || controller.signal.aborted) return;
    if (refreshing.has(hostId)) { dirty.add(hostId); return; }
    pending.set(hostId, setTimeout(() => { pending.delete(hostId); void refresh(hostId); }, 150));
  };
  const refresh = async (hostId: string) => {
    refreshing.add(hostId);
    try {
      // Let a full read finish before applying a newer scoped read.
      const overviewState = client.getQueryState(queryKeys.containers.overview());
      if (overviewState?.data === undefined || overviewState.fetchStatus === "fetching") deferred.add(hostId);
      else {
        const next = await (deps.overview ?? fetchLiveHostOverview)(hostId, controller.signal);
        if (controller.signal.aborted || removed.has(hostId)) return;
        client.setQueryData<HostOverview[]>(queryKeys.containers.overview(), (current) => {
          if (!current) return current;
          return current.some((entry) => entry.host.id === hostId)
            ? current.map((entry) => entry.host.id === hostId ? retainHostOverview(next, entry) : entry)
            : [...current, next];
        });
        updateState((state) => ({ ...state, unavailable: { ...state.unavailable, [hostId]: next.error !== null } }));
        client.setQueryData<HostView[]>(queryKeys.hosts.list(), (current) => current === undefined ? current :
          current.some((host) => host.id === hostId) ? current.map((host) => host.id === hostId ? next.host : host) : [...current, next.host]);
      }
      if (!controller.signal.aborted && !removed.has(hostId)) await client.invalidateQueries({ queryKey: queryKeys.hosts.containers(hostId), exact: true });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) remove(hostId);
      else if (!controller.signal.aborted && !removed.has(hostId)) updateState((state) => ({ ...state, unavailable: { ...state.unavailable, [hostId]: true } }));
    } finally {
      refreshing.delete(hostId);
      if (dirty.delete(hostId)) schedule(hostId);
    }
  };
  const remove = (hostId: string) => {
    removed.add(hostId);
    clearTimeout(pending.get(hostId)); pending.delete(hostId); dirty.delete(hostId); deferred.delete(hostId);
    updateState((state) => ({ ...state, hosts: Object.fromEntries(Object.entries(state.hosts).filter(([id]) => id !== hostId)) }));
    client.setQueryData<HostOverview[]>(queryKeys.containers.overview(), (current) => current?.filter((entry) => entry.host.id !== hostId));
    client.setQueryData<HostView[]>(queryKeys.hosts.list(), (current) => current?.filter((host) => host.id !== hostId));
    client.removeQueries({ queryKey: queryKeys.hosts.containers(hostId), exact: true });
  };
  const removed = new Set<string>();
  const receive = (event: LiveEvent) => {
    if (controller.signal.aborted) return;
    updateState((state) => ({ ...state, transport: true }));
    switch (event.kind) {
      case "session-expired": reportUnauthorized(); stop(); break;
      case "heartbeat": break;
      case "snapshot": {
        const registered = new Set([
          ...(client.getQueryData<HostOverview[]>(queryKeys.containers.overview()) ?? []).map((entry) => entry.host),
          ...(client.getQueryData<HostView[]>(queryKeys.hosts.list()) ?? [])
        ].filter((host) => host.state === "registered").map((host) => host.id));
        const present = new Set(event.hosts.map((host) => host.hostId));
        for (const hostId of registered) if (!present.has(hostId) && !removed.has(hostId)) schedule(hostId);
        updateState(() => ({ transport: true, hosts: Object.fromEntries(event.hosts.map((host) => [host.hostId, host.status])) }));
        for (const host of event.hosts) { removed.delete(host.hostId); if (host.status === "connected") schedule(host.hostId); }
        void client.invalidateQueries({ queryKey: queryKeys.hosts.list(), exact: true });
        break;
      }
      case "removed": remove(event.hostId); break;
      case "status":
        updateState((state) => ({ ...state, hosts: { ...state.hosts, [event.hostId]: event.status } }));
        removed.delete(event.hostId);
        if (event.status === "connected") {
          schedule(event.hostId);
          void client.invalidateQueries({ queryKey: queryKeys.hosts.list(), exact: true });
        }
        break;
      case "changed":
        schedule(event.hostId);
        if (event.containerIds.length === 0) void client.invalidateQueries({ queryKey: queryKeys.metrics.host(event.hostId) });
        for (const id of event.containerIds) void client.invalidateQueries({ queryKey: queryKeys.metrics.containerStats(event.hostId, id), exact: true });
        if (event.action === "recreate") void client.invalidateQueries({ queryKey: queryKeys.resources.host(event.hostId), exact: true });
        break;
    }
  };
  const unsubscribeCache = client.getQueryCache().subscribe((event) => {
    const key = queryKeys.containers.overview();
    if (event.type !== "updated" || event.action.type !== "success" ||
      event.query.queryKey.length !== key.length || !key.every((part, index) => event.query.queryKey[index] === part)) return;
    for (const hostId of deferred) { deferred.delete(hostId); schedule(hostId); }
  });
  const run = async () => {
    const attempt = new AbortController();
    const abort = () => attempt.abort();
    controller.signal.addEventListener("abort", abort, { once: true });
    const watchdog = () => { clearTimeout(silence); silence = setTimeout(abort, 45_000); };
    watchdog();
    let connectedAt: number | undefined;
    try {
      await (deps.read ?? readLiveEvents)(attempt.signal, (event) => { connectedAt ??= Date.now(); watchdog(); receive(event); });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { stop(); return; }
    } finally {
      attempt.abort(); clearTimeout(silence); controller.signal.removeEventListener("abort", abort);
    }
    if (controller.signal.aborted) return;
    updateState((state) => ({ ...state, transport: false }));
    if (connectedAt !== undefined && Date.now() - connectedAt >= 30_000) failures = 0;
    const delay = (deps.retryMs ?? ((count) => Math.min(1_000 * 2 ** Math.min(count, 5), 30_000)))(failures++);
    retry = setTimeout(() => { void run(); }, delay);
  };
  function stop() {
    controller.abort(); clearTimeout(retry); clearTimeout(silence);
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear(); dirty.clear(); deferred.clear(); unsubscribeCache();
  }
  void run();
  return stop;
}
