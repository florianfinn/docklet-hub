import { StackEndpointError } from "./stack-control.js";
import type { ExpectedContainer, RuntimeAction } from "contract";
import type { RawInspect } from "./engine.js";
import { expectedContainerMatches, runtimeStateOf, runtimeTargetReached } from "./runtime-actions.js";
import { runtimeReadback } from "./runtime-readback.js";

export async function executeContainerRuntimeAction(
  ops: { inspect: () => Promise<RawInspect | null>; execute: (inspect: RawInspect) => Promise<void>; lastKnownInspect?: () => RawInspect | null },
  action: RuntimeAction, expected: ExpectedContainer, before: RawInspect, signal?: AbortSignal
) {
  return runtimeReadback(async () => {
    if (!expectedContainerMatches(expected, runtimeStateOf(before))) throw new StackEndpointError(409, "state-changed");
    if (signal?.aborted) throw new StackEndpointError(409, "action-caller-disconnected");
    await ops.execute(before);
  }, async () => runtimeStateOf(await ops.inspect()), () => runtimeStateOf(ops.lastKnownInspect?.() ?? null, true), (state) => {
    const ok = runtimeTargetReached(action, state);
    return { ok, action, outcome: ok ? "ok" as const : "failed" as const, state,
      ...(ok ? {} : { error: "runtime-target-not-reached" }) };
  });
}
