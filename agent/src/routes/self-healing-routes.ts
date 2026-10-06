import { selfHealingConfigSchema } from "contract";
import { selfHealingConfig, audit } from "../runtime/state.js";
import { send, readJsonBody, parseRequest, rejectRequest, type RouteContext } from "../runtime/http.js";

export async function handleSelfHealingConfig(ctx: RouteContext): Promise<void> {
  const parsed = parseRequest(selfHealingConfigSchema, await readJsonBody(ctx.request));
  if (!parsed.ok) {
    rejectRequest(ctx, { action: "self-healing-config", containerId: null, containerName: null }, parsed.rejection);
    return;
  }
  // Configuration may be received in read-only mode; it executes no container action.
  const config = selfHealingConfig.write(parsed.value);
  audit.write({ action: "self-healing-config", containerId: null, containerName: null,
    actor: ctx.actor, outcome: "allowed", reason: "configuration-saved" });
  send(ctx.response, 200, { config });
}
