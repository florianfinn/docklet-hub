import {
  DockerEngine,
  EngineError
} from "../engine.js";
import {
  hardeningReport,
  hardeningRuleNames
} from "../hardening.js";
import {
  DEFINITION_ACTIONS,
  INTERNAL_ONLY_ACTIONS
} from "../route-policy.js";
import { forcedManagement } from "../stacks.js";
import { config, engine, registry, audit } from "./state.js";
import { hardeningOptionsFor, inspectedContainer } from "./containers.js";
import { AgentTier } from "./http.js";

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
  options: { mutating: boolean; action: string; tier: AgentTier | null; actor?: string | null }
): Promise<GateResult> {
  // 1. Kill switch. Comes first so that it really stops everything.
  if (options.mutating && config.readOnly) {
    return { ok: false, status: 503, reason: "agent-read-only" };
  }

  // 2. Own tier check, independent of the main API's. Without a usable tier
  //    nothing happens at all.
  if (!options.tier) {
    return { ok: false, status: 400, reason: "tier-missing" };
  }
  if (INTERNAL_ONLY_ACTIONS.has(options.action) && options.tier !== "internal") {
    return { ok: false, status: 403, reason: "internal-only-action" };
  }

  // 3. Own copy of the allowlist. The observer class may read but, even with
  // allowed=true, not act; the narrower class takes precedence (#78). An
  // externally managed entry may do everything except the definition actions.
  const access = registry.checkAccess(containerId, options.mutating, DEFINITION_ACTIONS.has(options.action));
  if (access === "observe-only" || access === "externally-managed") {
    return { ok: false, status: 403, reason: access };
  }
  if (access === "not-allowlisted") {
    return { ok: false, status: 404, reason: "not-allowlisted" };
  }

  // 4. Fresh inspect — not the state from back then. Containers change, not
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

  // 5. Self-management lock (stage 5d).
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

  // 6. Hardening against the ACTUAL state, anew on every action.
  //
  // ⚠️ S9 (K4, §4.2) recut the effect of this check. Before, ALL "blocking"
  // rules stopped external callers — nine of them, including
  // `device-passthrough` (hardware transcoding), `dangerous-capability`
  // (tailscale needs NET_ADMIN) and `bind-outside-base`. Now ONLY the
  // DELEGATION LOCK stops: the four semantic rules whose common statement is
  // "this container IS the host", plus `volume-unresolved` as a fail-closed
  // state as long as exactly this statement cannot be checked reliably for a
  // volume mount.
  //
  // Three restrictions, all of which remain:
  //
  // a) Only the delegation lock stops. Everything else is a hint or a
  //    warning — it is in the response (redact.ts) and in the UI, but a
  //    container you can no longer stop because of /dev/dri is worse off than
  //    one with /dev/dri.
  //
  // b) Only MUTATING actions are stopped. A violation means "do not run
  //    anything on this container", not "do not look at this container":
  //    whoever may not look cannot fix the violation either. Reading stays
  //    governed by the main API's scope gate, which is unaffected by this.
  //
  // c) Only EXTERNAL. That is the relaxation from 5d, and it is now the
  //    load-bearing rule instead of an exception: internally the operator
  //    operates traefik, tailscale and dozzle unchanged; externally a container
  //    with a delegation lock cannot be controlled, by no grant and no owner
  //    status (§19.7). This line is the second, independent instance of
  //    that — the first one sits in the main API.
  const inspected = await inspectedContainer(inspect);
  // Stage 5e: secured containers are checked against their own universe.
  const options5e = hardeningOptionsFor(containerId);
  const report = hardeningReport(inspected, options5e);
  if (options.mutating && options.tier !== "internal" && report.delegationLock.length > 0) {
    // Deduplicated names: two findings of the same rule are, in the reason
    // string without details, the same name twice — the translation in the
    // main API would then count it twice ("verletzt 3 Haertungsregeln" although
    // there are two different ones).
    return {
      ok: false,
      status: 403,
      reason: `hardening-violated: ${hardeningRuleNames(inspected, options5e).delegationLock.join(",")}`
    };
  }

  // Let through DESPITE the delegation lock — only possible internally (see c).
  //
  // This gets its own audit entry. A relaxation that cannot be seen afterwards
  // is no longer a conscious decision but a blind spot: without this line a
  // stop on a container with a docker.sock mount would look in the log exactly
  // like any other stop.
  if (options.mutating && report.delegationLock.length > 0) {
    audit.write({
      action: options.action,
      containerId,
      containerName: (inspect.Name ?? "").replace(/^\//, ""),
      actor: options.actor ?? null,
      networkTier: options.tier,
      outcome: "allowed",
      reason: `delegation-lock-allowed-internally: ${hardeningRuleNames(inspected, options5e).delegationLock.join(",")}`
    });
  }

  return { ok: true, inspect, delegationLocked: report.delegationLock.length > 0 };
}

// --- Project-wide stack control (S11) --------------------------------------
