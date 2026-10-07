import { probeAgent, type HostAccess, type HostRecord } from "../hosts/index.js";
import { fetchContainers, REGISTRY_SYNC_ACTOR } from "../containers/index.js";
import { agentStream } from "../../platform/agent-transport/protocol.js";
import { createLiveEvents, type LiveEvents } from "./service.js";
import { createLiveErrorReporter, type LiveRuntimeError } from "./error-reporting.js";

export type RunningLiveEvents = LiveEvents & { start: () => void };
export function startLiveEvents(options: {
  hosts: HostAccess;
  resync: (hostId: string) => Promise<void>;
  onError: (error: LiveRuntimeError) => void;
  onConnected?: (hostId: string) => Promise<void>;
  onHostReachable?: (host: HostRecord) => Promise<void>;
  fetchImpl?: typeof fetch;
}): RunningLiveEvents {
  const report = createLiveErrorReporter(options.onError);
  const live = createLiveEvents({
    onError: (error, hostId) => report("monitor", error, hostId),
    open: async (host, signal) => {
      const record = await options.hosts.find(host.id);
      if (!record) throw new Error("host-unknown");
      return agentStream(await options.hosts.connect(record), "/monitor-events", {
        actor: { kind: "system", name: "monitor" }, signal, timeoutMs: 3_000, fetchImpl: options.fetchImpl
      });
    },
    resync: options.resync,
    onConnected: options.onConnected,
    read: async (hostId) => {
      const record = await options.hosts.find(hostId);
      if (!record) throw new Error("host-unknown");
      return fetchContainers(await options.hosts.connect(record), { actor: REGISTRY_SYNC_ACTOR, fetchImpl: options.fetchImpl });
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let started = false;
  let lastProbe = 0;
  let running: Promise<void> = Promise.resolve();
  const tick = async () => {
    try {
      const hosts = await options.hosts.list();
      await live.reconcile(hosts);
      if (!stopped && Date.now() - lastProbe >= 15_000) {
        lastProbe = Date.now();
        await Promise.all(hosts.filter((host) => host.state === "registered").map(async (host) => {
          const health = await probeAgent(host.agentUrl, { timeoutMs: 3_000, fetchImpl: options.fetchImpl });
          if (!health.reachable) live.disconnectHost(host.id);
          else await options.onHostReachable?.(host).catch((error: unknown) => report("reconcile", error, host.id));
        }));
      }
    }
    catch (error) { if (!stopped) report("reconcile", error); }
    if (!stopped) { timer = setTimeout(() => { running = tick(); }, 5_000); timer.unref(); }
  };
  return {
    ...live,
    start: () => { if (started || stopped) return; started = true; running = tick(); },
    stop: async () => { stopped = true; clearTimeout(timer); await live.stop(); await running; }
  };
}
