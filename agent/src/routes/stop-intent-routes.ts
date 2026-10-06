import { type StopIntentsResponse } from "contract";
import { audit, dockerEvents, stopIntents } from "../runtime/state.js";
import { send, type RouteContext } from "../runtime/http.js";

export async function handleStopIntents(ctx: RouteContext): Promise<void> {
  const observing = dockerEvents.isObserving();
  audit.write({ action: "stop-intents", containerId: null, containerName: null,
    actor: ctx.actor, outcome: observing ? "allowed" : "error", reason: observing ? undefined : "events-unavailable" });
  ctx.response.setHeader("cache-control", "no-store");
  send(ctx.response, observing ? 200 : 503, {
    observing, intents: stopIntents.list(), recentExits: stopIntents.recentExits()
  } satisfies StopIntentsResponse);
}
