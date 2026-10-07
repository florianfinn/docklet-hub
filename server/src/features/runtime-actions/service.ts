import { hubContainerActionRequestSchema, hubStackActionRequestSchema, hubRuntimeContextSchema, type RuntimeAction } from "contract";
import * as z from "zod/mini";
import type { ContainerAccessRequest, ContainerAccessResult } from "../../domain/hosts/index.js";
import type { LiveEvents, RefreshTarget } from "../../domain/live-events/index.js";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import type { AgentStreamRelay } from "../../platform/streams/agent-stream-relay.js";
import * as agentClient from "./agent-client.js";

export type RuntimeActionsDeps = {
  openContainer: (request: ContainerAccessRequest, writing?: "reads" | "writes") => Promise<ContainerAccessResult>;
  readApplyDefinition: () => Promise<boolean>;
  liveEvents?: Pick<LiveEvents, "refresh">;
  agent?: Pick<typeof agentClient, "runContainer" | "runStack">;
};
function rejected(status: number, error: string): never {
  throw new AgentError("Laufzeitaktion abgelehnt.", status, { detail: { error } });
}

export function createRuntimeActionsService(deps: RuntimeActionsDeps) {
  const agent = deps.agent ?? agentClient;
  async function context(ref: ContainerAccessRequest) {
    const opened = await deps.openContainer(ref, "reads");
    if (!opened.ok) {
      if (opened.failure.kind === "agent-error") throw opened.failure.error;
      rejected(opened.failure.status, opened.failure.error === "host-unreachable" ? "runtime-host-offline" : opened.failure.error);
    }
    const { access } = opened;
    const raw = await agentClient.readContext(access.target, ref.containerId, access.options);
    const schema = z.object({ projectName: z.string(), projectDir: z.string(), composeFileName: z.string(), readOnly: z.boolean(),
      services: hubRuntimeContextSchema.shape.services });
    const parsed = schema.safeParse(raw);
    if (!parsed.success) rejected(502, "runtime-invalid-response");
    const value = parsed.data;
    const external = access.containers.some((entry) => entry.compose?.project === value.projectName && entry.externalManagement !== null);
    return hubRuntimeContextSchema.parse({ ...value,
      expectedStack: { ...value, services: value.services }, hubOwned: !external,
      applyDefinition: await deps.readApplyDefinition() });
  }

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
      const mode = action === "stop" ? false : await deps.readApplyDefinition();
      if ("expectedApplyDefinition" in input.data && input.data.expectedApplyDefinition !== undefined &&
        action !== "stop" && input.data.expectedApplyDefinition !== mode) rejected(409, "state-changed");
      const request = { expectedStack: "expectedStack" in input.data ? input.data.expectedStack : undefined,
        ...(action === "stop" ? {} : { applyDefinition: mode }) };
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
  return { execute, context };
}
