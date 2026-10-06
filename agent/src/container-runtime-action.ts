import { StackEndpointError } from "./stack-control.js";
import type { ContainerRuntimeResult, ExpectedContainer, RuntimeAction } from "contract";
import { actionFailureOf } from "./action-failure.js";
import type { RawInspect } from "./engine.js";
import { expectedContainerMatches, runtimeStateOf, runtimeTargetReached } from "./runtime-actions.js";

export async function executeContainerRuntimeAction(
  ops: { inspect: () => Promise<RawInspect | null>; execute: (inspect: RawInspect) => Promise<void> },
  action: RuntimeAction, expected: ExpectedContainer, before: RawInspect, signal?: AbortSignal
): Promise<{ status: number; auditReason?: string; body: ContainerRuntimeResult & Record<string, unknown> }> {
  let error: string | undefined;
  let auditReason: string | undefined;
  let status = 409;
  let details: Record<string, unknown> = {};
  try {
    if (!expectedContainerMatches(expected, runtimeStateOf(before))) error = "state-changed";
    else if (signal?.aborted) error = "action-caller-disconnected";
    else await ops.execute(before);
  } catch (failure) {
    const mapped = actionFailureOf(failure);
    error = failure instanceof StackEndpointError ? failure.code : String(mapped?.body.error ?? "internal-error");
    status = failure instanceof StackEndpointError ? failure.status : mapped?.status ?? 500;
    details = mapped?.body ?? {};
    auditReason = failure instanceof StackEndpointError ? failure.code :
      mapped?.auditReason ?? (failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure));
  }
  let state;
  try { state = runtimeStateOf(await ops.inspect()); }
  catch { state = runtimeStateOf(null, true); error = "runtime-state-unreadable"; }
  const outcome = runtimeTargetReached(action, state) ? "ok" : "failed";
  const ok = outcome === "ok" && !error;
  return { status: ok ? 200 : status, auditReason, body: {
    ...details, ok, action, outcome, state,
    ...(error ? { error } : ok ? {} : { error: "runtime-target-not-reached" })
  } };
}
