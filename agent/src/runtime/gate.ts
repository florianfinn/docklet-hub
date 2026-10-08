import { runtimeCall, type RuntimeBudget } from "../runtime-budget.js";
import {
  DockerEngine,
  EngineError
} from "../engine.js";
import {
  hardeningReport,
  hardeningRuleNames
} from "../hardening.js";
import { DEFINITION_ACTIONS } from "../route-policy.js";
import { forcedManagement } from "../stacks.js";
import { config, engine, registry, audit } from "./state.js";
import { hardeningOptionsFor, inspectedContainer } from "./containers.js";

// Fresh authorization and hardening evidence for container actions.
export type GateResult =
  | {
      ok: true;
      inspect: Awaited<ReturnType<DockerEngine["inspect"]>>;
      delegationLocked: boolean;
    }
  | { ok: false; status: number; reason: string };

export async function gate(
  containerId: string | null,
  options: { mutating: boolean; action: string; actor?: string | null; onDelegation?: (reason: string) => void; budget?: RuntimeBudget; onInspect?: (inspect: Awaited<ReturnType<DockerEngine["inspect"]>>) => void }
): Promise<GateResult> {
  // The kill switch takes precedence over all other gates.
  if (options.mutating && config.readOnly) {
    return { ok: false, status: 503, reason: "agent-read-only" };
  }

  // Job stubs have no stored target yet and must fail closed before inspection.
  if (containerId === null) return { ok: false, status: 501, reason: "not-implemented" };

  // Authorization comes exclusively from the agent registry.
  const access = registry.checkAccess(containerId, options.mutating, DEFINITION_ACTIONS.has(options.action));
  if (access === "observe-only" || access === "externally-managed") {
    return { ok: false, status: 403, reason: access };
  }
  if (access === "not-allowlisted") {
    return { ok: false, status: 404, reason: "not-allowlisted" };
  }

  // Inspect again for every action, within the caller’s remaining budget.
  let inspect;
  try {
    inspect = await runtimeCall(options.budget, (call) => engine.inspect(containerId, call));
  } catch (error) {
    if (error instanceof EngineError && error.status === 404) {
      return { ok: false, status: 404, reason: "container-gone" };
    }
    throw error;
  }

  options.onInspect?.(inspect);

  // Raw working-directory labels protect self-management even when the
  // remaining Compose labels cannot form a valid context.
  if (options.mutating) {
    const ownDirectory = inspect.Config?.Labels?.["com.docker.compose.project.working_dir"];
    if (ownDirectory && forcedManagement(ownDirectory) === "read-only") {
      return {
        ok: false,
        status: 403,
        reason: `self-management-locked: ${ownDirectory}`
      };
    }
  }

  // Delegation evidence is allowed but joins the handler's single action
  // audit. Callers without an action callback retain the standalone audit.
  const inspected = await inspectedContainer(inspect, options.budget);
  const hardeningOptions = hardeningOptionsFor(containerId);
  const report = hardeningReport(inspected, hardeningOptions);
  if (options.mutating && report.delegationLock.length > 0) {
    const reason = `delegation-lock-allowed: ${hardeningRuleNames(inspected, hardeningOptions).delegationLock.join(",")}`;
    if (options.onDelegation) options.onDelegation(reason);
    else audit.write({
      action: options.action,
      containerId,
      containerName: (inspect.Name ?? "").replace(/^\//, ""),
      actor: options.actor ?? null,
      outcome: "allowed",
      reason
    });
  }

  return { ok: true, inspect, delegationLocked: report.delegationLock.length > 0 };
}
