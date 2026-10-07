import type { ContainerViewSettings, HostOverview } from "contract";

import { readLifecycleSnapshot } from "../../domain/lifecycle/index.js";
import { fetchStackDiscovery } from "../../domain/containers/index.js";
import { fetchContainers } from "../../domain/containers/index.js";
import type { AgentHealth, HostAccess, HostRecord } from "../../domain/hosts/index.js";
import type { HostDecoration } from "./decoration.js";
import { buildOverview } from "./overview.js";
import { normalizeShowSystem } from "./view-store.js";

// The service of the feature `containers` (#282): everything between the HTTP
// routes and the agent. The routes read parameters, set the status and write
// the answer; which arms are asked, as whom, and what a bad value of the
// container view comes to is decided here, and `service.test.ts` decides it
// without Express and without Postgres.

/** The agent call of this surface; injectable for `service.test.ts`. */
export type ContainersAgent = {
  fetchContainers: typeof fetchContainers;
};

export type ContainersServiceDeps = {
  hosts: Pick<HostAccess, "list" | "connect">;
  /** The reachability of an arm, from the observation store where it is fresh (`resolveProbeHost`). */
  probe: (record: HostRecord) => Promise<AgentHealth>;
  /**
   * The marks and the display of one arm. Handed in from the app
   * (`server/src/app/features.ts`): the feature `marks` owns them, and a feature
   * imports no other feature.
   */
  decorationFor: (record: HostRecord) => Promise<HostDecoration>;
  writeViewSettings: (settings: ContainerViewSettings) => Promise<ContainerViewSettings>;
  agent?: ContainersAgent;
  readLifecycleSettings?: () => Promise<{ applyDefinition: boolean; maintenanceDurationSeconds: number | null }>;
};

export type ContainersService = {
  /**
   * All arms with their stacks, as `GET /overview` answers.
   *
   * ⚠️ `userId` is the caller of the session and goes to the agent as the
   * actor of every container call: the audit log of the agent is the one trace
   * that points from this hub to a person. The background cycle appears there
   * as `system:hub`, and an inventory taken from it would delete that trace.
   */
  overview: (caller: { userId: string; hostId?: string }) => Promise<HostOverview[]>;
  // `{ ok: false }` for anything that is not a boolean.
  updateViewSettings: (
    showSystem: unknown
  ) => Promise<{ ok: true; settings: ContainerViewSettings } | { ok: false }>;
};

const DEFAULT_AGENT: ContainersAgent = { fetchContainers };

export function createContainersService({
  hosts,
  probe,
  decorationFor,
  writeViewSettings,
  agent = DEFAULT_AGENT,
  readLifecycleSettings
}: ContainersServiceDeps): ContainersService {
  return {
    overview: async ({ userId, hostId }) => {
      const settings = await readLifecycleSettings?.();
      return buildOverview((await hosts.list()).filter((record) => hostId === undefined || record.id === hostId), {
        // ⚠️ The REACHABILITY comes from the holder of the background cycle,
        // not from a probe per request (B4a-C2, #5). Before, this one surface
        // waited for N agents with 3 s each, and the wait grew with every new
        // arm. If the holder knows nothing or is too old, `probe` asks itself;
        // `createObservedProbe` explains both cases.
        probeHost: (record) => probe(record),
        // ⚠️ The CONTAINERS are still fetched HERE, with the caller of the
        // session (see `overview` in the type above).
        fetchContainersFor: async (record) =>
          agent.fetchContainers(await hosts.connect(record), { actor: { kind: "user", id: userId } }),
        // The own marks and the indent of this arm (D7b, #62). They come from
        // the own database and not from the agent, which knows nothing of
        // them and should not.
        decorationFor,
        ...(settings ? { lifecycleFor: async (record: HostRecord) => {
          const target = await hosts.connect(record);
          const options = { actor: { kind: "user" as const, id: userId } };
          const [lifecycle, discovery] = await Promise.all([
            readLifecycleSnapshot(target, options, settings),
            fetchStackDiscovery(target, options).catch(() => null)
          ]);
          return { lifecycle, hubOwnedProjects: new Set(discovery?.stacks.filter((stack) => stack.filePresent && stack.management === "full")
            .map((stack) => stack.projectName) ?? []) };
        } } : {})
      });
    },
    updateViewSettings: async (showSystem) => {
      const parsed = normalizeShowSystem(showSystem);
      if (!parsed.ok) return { ok: false };
      return { ok: true, settings: await writeViewSettings({ showSystem: parsed.value }) };
    }
  };
}
