import { selfHealingConfigSchema } from "contract";
import { actionFailureOf } from "../action-failure.js";
import { selfHealingConfig, audit } from "../runtime/state.js";
import { send, readJsonBody, parseRequest, rejectionReason, InvalidJsonError, type RouteContext } from "../runtime/http.js";

export async function handleSelfHealingConfig(ctx: RouteContext): Promise<void> {
  let writing = false;
  let status: number;
  let body: Record<string, unknown>;
  let outcome: "allowed" | "denied" | "error";
  let reason: string;
  try {
    const parsed = parseRequest(selfHealingConfigSchema, await readJsonBody(ctx.request));
    if (!parsed.ok) {
      status = 400;
      body = parsed.rejection;
      outcome = "denied";
      reason = rejectionReason(parsed.rejection);
    } else {
      // Read-only mode permits configuration storage; healing actions still use the mutation gate.
      writing = true;
      body = { config: selfHealingConfig.write(parsed.value) };
      status = 200;
      outcome = "allowed";
      reason = "configuration-saved";
    }
  } catch (error) {
    const failure = error instanceof InvalidJsonError
      ? { status: 400, body: { error: "invalid-json", field: "" }, auditReason: "invalid-json" }
      : actionFailureOf(error, true);
    status = failure.status;
    body = failure.body;
    outcome = writing ? "error" : "denied";
    reason = failure.auditReason;
  }
  audit.write({ action: "self-healing-config", containerId: null, containerName: null,
    actor: ctx.actor, outcome, reason });
  send(ctx.response, status, body);
}
