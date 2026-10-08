import { UPDATE_PRECHECK_TIMEOUT_MS, RUNTIME_TRANSPORT_RESERVE_MS, agentJobsResponseSchema, agentJobResponseSchema, updatePreviewResponseSchema, updateStartResponseSchema,
  updateCancelResponseSchema, type UpdatePreviewRequest, type UpdateStartRequest, type AgentJobsQuery } from "contract";
import { agentGet, agentPost, AgentError, type AgentTarget, type RequestOptions } from "../../platform/agent-transport/protocol.js";
import { runtimePost } from "../../platform/agent-transport/runtime-transport.js";

function parsed<T>(schema: { safeParse(raw: unknown): { success: true; data: T } | { success: false } }, raw: unknown): T {
  const value = schema.safeParse(raw);
  if (!value.success) throw new AgentError("Ungültige Update-Antwort.", 502, { detail: { error: "runtime-invalid-response" } });
  return value.data;
}
export async function preview(target: AgentTarget, body: UpdatePreviewRequest, options: RequestOptions) {
  return parsed(updatePreviewResponseSchema, await runtimePost(target, "/update-previews", body, options));
}
export async function start(target: AgentTarget, body: UpdateStartRequest, options: RequestOptions) {
  return parsed(updateStartResponseSchema, await agentPost(target, "/updates", body, { ...options, timeoutMs: options.timeoutMs ?? UPDATE_PRECHECK_TIMEOUT_MS + RUNTIME_TRANSPORT_RESERVE_MS }));
}
export async function list(target: AgentTarget, query: AgentJobsQuery, options: RequestOptions) {
  const params = new URLSearchParams();
  if (query.kind) params.set("kind", query.kind);
  if (query.target) params.set("target", JSON.stringify(query.target));
  return parsed(agentJobsResponseSchema, await agentGet(target, `/jobs?${params}`, options));
}
export async function progress(target: AgentTarget, id: string, options: RequestOptions) {
  return parsed(agentJobResponseSchema, await agentGet(target, `/jobs/${encodeURIComponent(id)}`, options));
}
export async function cancel(target: AgentTarget, id: string, options: RequestOptions) {
  return parsed(updateCancelResponseSchema, await agentPost(target, `/jobs/${encodeURIComponent(id)}/cancel`, {}, options));
}
