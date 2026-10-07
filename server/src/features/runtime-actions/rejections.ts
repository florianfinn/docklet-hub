import { hubRuntimeErrorSchema, hubContainerRuntimeResultSchema, hubStackRuntimeResultSchema,
  type HubRuntimeError } from "contract";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import { agentFailureReason } from "../../platform/agent-transport/stream-rejection.js";

export function runtimeErrorKey(reason: unknown): HubRuntimeError {
  const parsed = hubRuntimeErrorSchema.safeParse(reason);
  if (parsed.success) return parsed.data;
  // The gate may append its private directory to this key.
  if (typeof reason === "string" && reason.startsWith("self-management-locked:")) return "self-management-locked";
  return "runtime-agent-failed";
}

export function runtimeRejection(error: AgentError, stack: boolean) {
  const reason = agentFailureReason(error);
  const key = reason === "agent-request-timeout" ? "runtime-action-timeout" : error.status === null ? "runtime-agent-unreachable" : runtimeErrorKey(reason);
  const status = error.status !== null && error.status >= 400 && error.status < 600 ? error.status : 502;
  const detail = typeof error.detail === "object" && error.detail !== null ? error.detail : {};
  const body = { ...detail, error: key };
  const parsed = (stack ? hubStackRuntimeResultSchema : hubContainerRuntimeResultSchema).safeParse(body);
  return { status, body: parsed.success ? parsed.data : { error: key } };
}
