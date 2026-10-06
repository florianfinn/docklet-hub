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

// The check chain that runs before EVERY container-related action. The order is
// deliberately identical to the main API, but carried out independently.
export type GateResult =
  | {
      ok: true;
      inspect: Awaited<ReturnType<DockerEngine["inspect"]>>;
      delegationLocked: boolean;
    }
  | { ok: false; status: number; reason: string };

export async function gate(
  containerId: string,
  options: { mutating: boolean; action: string; actor?: string | null; onDelegation?: (reason: string) => void }
): Promise<GateResult> {
  // 1. Kill switch. Comes first so that it really stops everything.
  if (options.mutating && config.readOnly) {
    return { ok: false, status: 503, reason: "agent-read-only" };
  }

  // 2. Own copy of the allowlist. The observer class may read but, even with
  // allowed=true, not act; the narrower class takes precedence (#78). An
  // externally managed entry may do everything except the definition actions.
  const access = registry.checkAccess(containerId, options.mutating, DEFINITION_ACTIONS.has(options.action));
  if (access === "observe-only" || access === "externally-managed") {
    return { ok: false, status: 403, reason: access };
  }
  if (access === "not-allowlisted") {
    return { ok: false, status: 404, reason: "not-allowlisted" };
  }

  // 3. Fresh inspect — not the state from back then. Containers change, not
  //    least because Dockge keeps editing alongside until it is switched off.
  let inspect;
  try {
    inspect = await engine.inspect(containerId);
  } catch (error) {
    if (error instanceof EngineError && error.status === 404) {
      return { ok: false, status: 404, reason: "container-gone" };
    }
    throw error;
  }

  // 4. Self-management lock.
  //
  // Containers that carry the operation of the dashboard itself — API,
  // database, agent, Traefik, authentik, frpc — must not be mutated through
  // this API. Otherwise the API can stop itself or its ingress and has thereby
  // also taken away its own ability to undo that.
  //
  // ⚠️ The path is derived here from the CONTAINER'S LABELS, not from the
  // management level that the main API stored on adoption. That is
  // intentional: the stored level would come in via the sync, and the agent is
  // the last authority — it must not rely on the API having filtered correctly.
  //
  // Without this check "read-only" would be a label and not a rule: unlocking
  // in the allowlist (PUT /api/docker/registry/:id sets allowed) would have been
  // enough to make stop/recreate/remove possible on exactly these containers.
  // The working_dir label is read RAW, not via composeContextOf: that one
  // additionally requires an unambiguous file reference (config_files) and
  // would return null if it is missing. A lock that lapses because a label is
  // incomplete is no lock.
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

  // 5. Hardening against the ACTUAL state, anew on every action.
  //
  // The delegation lock (the rules whose statement is "this container IS the
  // host", plus `volume-unresolved` while that cannot be checked) is reported
  // but does not block. Mutating actions pass the note to onDelegation for the
  // handler's action audit, or write a separate entry when no callback is given.
  const inspected = await inspectedContainer(inspect);
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

// --- Project-wide stack control (S11) --------------------------------------
