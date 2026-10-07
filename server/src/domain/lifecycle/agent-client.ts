import { stopIntentsResponseSchema, selfHealingStatusResponseSchema,
  type StopIntentsResponse, type SelfHealingStatusResponse } from "contract";
import { AgentError, agentGet, agentPut, agentDelete, agentPost,
  type AgentTarget, type RequestOptions } from "../../platform/agent-transport/protocol.js";

function invalid(): never {
  throw new AgentError("Ungültiger Beobachtungsstand.", 502, { detail: { error: "lifecycle-invalid-response" } });
}
export async function readStopIntents(target: AgentTarget, options: RequestOptions): Promise<StopIntentsResponse> {
  const parsed = stopIntentsResponseSchema.safeParse(await agentGet(target, "/stop-intents", options));
  if (!parsed.success) invalid();
  if (!parsed.data.observing) throw new AgentError("Beobachtung nicht verfügbar.", 503,
    { detail: { error: "lifecycle-observation-unavailable" } });
  return parsed.data;
}
export async function readSelfHealing(target: AgentTarget, options: RequestOptions): Promise<SelfHealingStatusResponse> {
  let raw: unknown;
  try { raw = await agentGet(target, "/self-healing/status", options); }
  catch (error) {
    if (!(error instanceof AgentError) || error.status !== 503) throw error;
    raw = error.detail;
  }
  const parsed = selfHealingStatusResponseSchema.safeParse(raw);
  if (!parsed.success) invalid();
  return parsed.data;
}
export async function writeLifecycle(target: AgentTarget, operation: "maintenance-on" | "maintenance-off" | "acknowledge",
  body: unknown, options: RequestOptions): Promise<{ ok: true }> {
  const result = operation === "maintenance-on" ? await agentPut(target, "/self-healing/maintenance", body, options)
    : operation === "maintenance-off" ? await agentDelete(target, "/self-healing/maintenance", options, body)
      : await agentPost(target, "/self-healing/incidents/acknowledge", body, options);
  if (typeof result !== "object" || result === null || !("ok" in result) || result.ok !== true) invalid();
  return { ok: true };
}
