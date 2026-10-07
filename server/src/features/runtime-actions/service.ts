import { hubContainerActionRequestSchema, hubStackActionRequestSchema, type RuntimeAction } from "contract";
import type { ContainerAccessRequest, ContainerAccessResult } from "../../domain/hosts/index.js";
import type { LiveEvents, RefreshTarget } from "../../domain/live-events/index.js";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import type { AgentStreamRelay } from "../../platform/streams/agent-stream-relay.js";
import * as agentClient from "./agent-client.js";

export type RuntimeActionsDeps = {
  openContainer: (request: ContainerAccessRequest) => Promise<ContainerAccessResult>;
  readApplyDefinition: () => Promise<boolean>;
  liveEvents?: Pick<LiveEvents, "refresh">;
  agent?: Pick<typeof agentClient, "runContainer" | "runStack">;
};
function rejected(status: number, error: string): never {
  throw new AgentError("Laufzeitaktion abgelehnt.", status, { detail: { error } });
}

export function createRuntimeActionsService(deps: RuntimeActionsDeps) {
  const agent = deps.agent ?? agentClient;
  async function execute(ref: ContainerAccessRequest, action: RuntimeAction, body: unknown,
    signal: AbortSignal, relay?: AgentStreamRelay) {
    const stack = relay !== undefined;
    const input = (stack ? hubStackActionRequestSchema : hubContainerActionRequestSchema).safeParse(body);
    if (!input.success) rejected(400, "invalid-input");
    let target: RefreshTarget = "expectedStack" in input.data
      ? { project: input.data.expectedStack.projectName } : { containerId: ref.containerId };
    try {
      signal.throwIfAborted();
      // Monitor availability is independent of the health check performed by openContainer.
      const opened = await deps.openContainer(ref);
      if (!opened.ok) {
        const failure = opened.failure;
        if (failure.kind === "agent-error") throw failure.error;
        rejected(failure.status, failure.error === "host-unreachable" ? "runtime-host-offline" : failure.error);
      }
      const access = opened.access;
      signal.throwIfAborted();
      if (!stack) return await agent.runContainer(access.target, ref.containerId, action, input.data,
        { ...access.options, signal });
      if (access.container.compose) target = { project: access.container.compose.project };
      const request = { ...input.data,
        ...(action === "stop" ? {} : { applyDefinition: await deps.readApplyDefinition() }) };
      signal.throwIfAborted();
      await agent.runStack(access.target, ref.containerId, action, request, access.options, relay);
      return undefined;
    } catch (error) {
      if (signal.aborted || error instanceof AgentError) throw error;
      rejected(500, "internal-error");
    } finally {
      // Refresh errors cannot replace the action result, including partial failures or caller aborts.
      void deps.liveEvents?.refresh(ref.hostId, target).catch(() => undefined);
    }
  }
  return { execute };
}
