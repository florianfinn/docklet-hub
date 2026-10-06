import type { Pool } from "pg";
import { createHostAccess, type HostRepository } from "../domain/hosts/index.js";
import { createSelfHealingSync, readSelfHealingConfig, recordSelfHealingDelivery, sendSelfHealingConfig }
  from "../features/settings/index.js";

export function createRuntimeSettingsSync(options: { pool: Pool; repository: HostRepository; agentSecret: string }) {
  const access = createHostAccess(options);
  return createSelfHealingSync({
    read: () => readSelfHealingConfig(options.pool),
    listHosts: () => access.list(),
    send: async (host, config) => sendSelfHealingConfig(await access.connect(host), config),
    record: (hostId, revision, status) => recordSelfHealingDelivery(options.pool, hostId, revision, status)
  });
}
