import type { ExpectedContainer, RuntimeAction } from "contract";
import { EngineError, type RawInspect } from "./engine.js";
import { composeContextOf } from "./compose.js";
import { StackEndpointError } from "./stack-control.js";
import { executeContainerRuntimeAction } from "./container-runtime-action.js";
import { actionFailureOf } from "./action-failure.js";
import { ACTION_QUEUE_WAIT_MS, runtimeStateOf } from "./runtime-actions.js";
import { config, engine, registry, audit, stackLocks, stopIntents } from "./runtime/state.js";
import { composeBasePath } from "./runtime/containers.js";
import { gate } from "./runtime/gate.js";

// Shared mutation boundary for human actions and autonomous healing.
export async function runContainerAction(
  containerId: string, action: RuntimeAction, expected: ExpectedContainer, actor: string | null,
  signal?: AbortSignal, beforeMutation?: (inspect: RawInspect) => void
) {
  let mutationStarted = false;
  let containerName: string | null = null;
  const delegation = new Set<string>();
  const onDelegation = (reason: string) => { delegation.add(reason); };
  const auditReason = (reason?: string) => [...delegation, reason].filter(Boolean).join("; ") || undefined;
  try {
    const initial = await gate(containerId, { mutating: true, action, actor, onDelegation });
    if (!initial.ok) throw new StackEndpointError(initial.status, initial.reason);
    containerName = initial.inspect.Name.replace(/^\//, "");
    const context = composeContextOf(initial.inspect.Config?.Labels ?? undefined, composeBasePath);
    const projectName = initial.inspect.Config?.Labels?.["com.docker.compose.project"] ?? registry.get(containerId)?.compose?.projectName;
    const lockKey = projectName ?? `container:${containerId}`;
    const result = await stackLocks.runExclusive(lockKey, async () => {
      const fresh = await gate(containerId, { mutating: true, action, actor, onDelegation });
      if (!fresh.ok && fresh.reason !== "container-gone" && fresh.reason !== "not-allowlisted") return { status: fresh.status, body: { error: fresh.reason } };
      if (!fresh.ok && registry.get(containerId) && !registry.isAllowed(containerId)) return { status: fresh.status, body: { error: fresh.reason } };
      const readState = async () => {
        // Resolve through the checked project anchor after external replacement,
        // and return the new id even when this action never reached the engine.
        let id = containerId;
        if (context) {
          const matches = (await engine.listWithComposeLabels()).filter((container) => {
            const current = composeContextOf(container.labels, composeBasePath);
            return current?.project === context.project && current.projectDir === context.projectDir &&
              current.composeFileName === context.composeFileName && current.serviceName === context.serviceName;
          });
          if (matches.length > 1) throw new StackEndpointError(409, "scaled-service-unsupported");
          if (matches.length === 0) return null;
          id = matches[0].id;
        }
        if (!id) return null;
        if (!registry.isAllowed(id) && !registry.isAllowed(containerId)) throw new StackEndpointError(404, "not-allowlisted");
        let inspect;
        try { inspect = await engine.inspect(id); }
        catch (error) { if (error instanceof EngineError && error.status === 404) return null; throw error; }
        if (id !== containerId) {
          if (inspect.Name !== initial.inspect.Name ||
              inspect.Config?.Labels?.["com.docker.compose.project"] !== context?.project) throw new StackEndpointError(409, "container-anchor-mismatch");
          if (!registry.isAllowed(id) && !registry.replaceContainerId(containerId, id)) throw new StackEndpointError(409, "registry-reanchor-failed");
        }
        return inspect;
      };
      if (fresh.ok) {
        const access = registry.checkAccess(fresh.inspect.Id, true);
        if (access !== "allowed") return { status: 403, body: { error: access } };
      }
      const before = context || !fresh.ok ? await readState() : fresh.inspect;
      if (!before || !fresh.ok) return { status: 409, body: {
        ok: false, action: action, outcome: "failed" as const, error: "state-changed", state: runtimeStateOf(before)
      } };
      return executeContainerRuntimeAction({
        inspect: readState,
        execute: async (inspect) => {
          if (config.readOnly) throw new StackEndpointError(503, "agent-read-only");
          const access = registry.checkAccess(inspect.Id, true);
          if (access !== "allowed") throw new StackEndpointError(403, access);
          beforeMutation?.(inspect);
          mutationStarted = true;
          if (action === "start") await engine.start(inspect.Id);
          else if (action === "stop") {
            const finish = stopIntents.beginHubStop([inspect.Id], actor);
            try { await engine.stop(inspect.Id, inspect.Config?.StopTimeout ?? null); }
            finally { finish(); }
          }
          else await engine.restart(inspect.Id, inspect.Config?.StopTimeout ?? null);
        }
      }, action, expected, before, signal);
    }, { waitMs: ACTION_QUEUE_WAIT_MS, signal });
    audit.write({ action, containerId, containerName, actor,
      outcome: result.status === 200 ? "allowed" : mutationStarted ? "error" : "denied",
      reason: auditReason("error" in result.body ? String(result.body.error) : undefined) });
    return { ...result, mutationStarted };
  } catch (error) {
    const failure = actionFailureOf(error, true);
    audit.write({ action, containerId, containerName, actor,
      outcome: mutationStarted ? "error" : "denied", reason: auditReason(failure.auditReason) });
    return { status: failure.status, body: failure.body, mutationStarted };
  }
}
