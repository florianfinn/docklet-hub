import type { Pool } from "pg";

import type { AgentTarget } from "../../platform/agent-transport/protocol.js";
import { resolveAgentSecret } from "./agent-secret.js";
import type { HostRecord } from "./host-record.js";
import type { HostRepository } from "./host-repository.js";

// The three steps logs, shell, files and compose take before they do anything:
// find the host, resolve its secret, build the way to its agent
// (docs/design/feature-architecture.md, section 4).
//
// Before #251 each route wrote the last two itself, as
// `{ baseUrl: host.agentUrl, secret: await resolveAgentSecret(…) }`, in nine
// places. The secret is now read here and nowhere else outside this folder;
// `resolveAgentSecret` is not part of the door (`index.ts`).
//
// ⚠️ `find` and `connect` stay two calls on purpose. Several routes decide
// something between them (the file chain probes the agent and answers 503 for
// a `pending` or `offline` arm before it reads any secret), and one call for
// both would read the secret for requests that end before the agent is asked.

export type HostAccessDeps = {
  repository: Pick<HostRepository, "find" | "list">;
  pool: Pool;
  // The secret from the environment (`DOCKER_AGENT_SECRET`). It is valid for
  // the local arm only; `resolveAgentSecret` decides which secret belongs to
  // which arm (#77).
  agentSecret: string;
};

export type HostAccess = {
  // `null` is "host-unknown": the hub does not keep a host with this id. Every
  // state is found, `pending` included; whether an arm can be asked is the
  // caller's decision (`deriveHostStatus`), not a filter here.
  find: (hostId: string) => Promise<HostRecord | null>;
  // Every host of the inventory, local first, without any filter.
  list: () => Promise<HostRecord[]>;
  // The way to the agent of this host. Throws `AgentError` for an attached arm
  // whose row holds no secret, and never falls back to the environment for it.
  connect: (host: HostRecord) => Promise<AgentTarget>;
};

export function createHostAccess(deps: HostAccessDeps): HostAccess {
  return {
    find: (hostId) => deps.repository.find(hostId),
    list: () => deps.repository.list(),
    connect: async (host) => ({
      baseUrl: host.agentUrl,
      secret: await resolveAgentSecret(deps.pool, host, deps.agentSecret)
    })
  };
}
