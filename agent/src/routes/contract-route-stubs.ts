import { gate } from "../runtime/gate.js";
import { audit } from "../runtime/state.js";
import { send, type RouteContext } from "../runtime/http.js";

// A stub checks every known target but never schedules work or changes Docker state.
export async function unavailableRoute(
  ctx: RouteContext, action: string, gateAction: string, mutating: boolean,
  containerIds: readonly (string | null)[] = []
): Promise<void> {
  for (const containerId of containerIds) {
    const result = await gate(containerId, { action: gateAction, mutating, actor: ctx.actor });
    if (!result.ok) {
      audit.write({ action, containerId, containerName: null, actor: ctx.actor, outcome: "denied", reason: result.reason });
      send(ctx.response, result.status, { error: result.reason });
      return;
    }
  }
  audit.write({ action, containerId: containerIds[0] ?? null, containerName: null,
    actor: ctx.actor, outcome: "denied", reason: "not-implemented" });
  send(ctx.response, 501, { error: "not-implemented" });
}
