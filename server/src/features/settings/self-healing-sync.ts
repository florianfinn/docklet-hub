import type { SelfHealingConfig } from "contract";
import type { HostRecord } from "../../domain/hosts/index.js";
import type { StoredSelfHealing } from "./runtime-store.js";

export type SelfHealingSyncDeps = {
  read: () => Promise<StoredSelfHealing>;
  listHosts: () => Promise<readonly HostRecord[]>;
  send: (host: HostRecord, config: SelfHealingConfig) => Promise<void>;
  record: (hostId: string, revision: number, status: "synced" | "failed") => Promise<void>;
};

// Serializing deliveries prevents an older configuration from overwriting a newer one.
export function createSelfHealingSync(deps: SelfHealingSyncDeps) {
  const queues = new Map<string, Promise<void>>();
  const delivered = new Map<string, number>();

  const syncHost = (host: HostRecord, force = false): Promise<void> => {
    const previous = queues.get(host.id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const latest = await deps.read();
      if (!force && delivered.get(host.id) === latest.revision) return;
      try {
        await deps.send(host, latest.config);
        await deps.record(host.id, latest.revision, "synced");
        delivered.set(host.id, latest.revision);
      } catch {
        delivered.delete(host.id);
        await deps.record(host.id, latest.revision, "failed");
      }
    });
    queues.set(host.id, run);
    void run.finally(() => { if (queues.get(host.id) === run) queues.delete(host.id); }).catch(() => undefined);
    return run;
  };

  return {
    syncHost,
    syncConnected: async (): Promise<void> => {
      const hosts = await deps.listHosts();
      // The live connection and its health probe retry failed deliveries.
      await Promise.all(hosts.filter((host) => host.state !== "pending")
        .map((host) => syncHost(host)));
    }
  };
}
export type SelfHealingSync = ReturnType<typeof createSelfHealingSync>;
