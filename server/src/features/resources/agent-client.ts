import { hostResourcesSchema, type HostResources } from "contract";

import { agentGet, AgentError, type AgentTarget, type RequestOptions } from "../../platform/agent-transport/protocol.js";

// The agent's resource read, `GET /resources` (#10). The agent gives
// `/system/df` up to 60 seconds; the hub waits a little longer so that the
// agent's own timeout answers first and names its section.
export const RESOURCES_TIMEOUT_MS = 75_000;

const ROUTE = "/resources";

export async function fetchHostResources(target: AgentTarget, options: RequestOptions): Promise<HostResources> {
  const answer = await agentGet(target, ROUTE, { timeoutMs: RESOURCES_TIMEOUT_MS, ...options });
  const parsed = hostResourcesSchema.safeParse(answer);
  if (!parsed.success) {
    throw new AgentError(`Die Antwort des Agenten auf „${ROUTE}“ passt nicht zum Vertrag.`, null, { cause: parsed.error });
  }
  return parsed.data;
}
