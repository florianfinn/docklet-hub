import { projectLockKey } from "../project-lock.js";
import { RuntimeBudget, type RuntimeCallOptions } from "../runtime-budget.js";
import { RuntimeActionFailure } from "../action-failure.js";
import type { RawInspect } from "../engine.js";
import { EngineError } from "../engine.js";
import { actionFailureOf, type ActionFailure } from "../action-failure.js";
import type { RuntimeAction, StackActionRequest, RuntimeServiceResult } from "contract";
import {
  composeStart, composeStop, composeDependencySafeRestart, composeUp
} from "../compose-cli.js";
import { executeStackRuntimeAction, runtimeServices } from "../stack-runtime-action.js";
import { ACTION_QUEUE_WAIT_MS, runtimeStateOf } from "../runtime-actions.js";
import { config, engine, registry, stackLocks, stopIntents } from "./state.js";
import {
  StackEndpointError, prepareStack, currentStackContainers, reanchorStackRegistry,
  ensureCreateScopeAllowlisted, ensureCreateScopeNotExternallyManaged,
  registryEntriesByService, containerIdsOf, type StackResolvedProject, type PreparedStack
} from "./stack.js";

export async function runStackRuntimeAction(
  project: StackResolvedProject, anchor: string, action: RuntimeAction, body: StackActionRequest,
  actor: string | null, signal: AbortSignal,
  callbacks: { onQueued?: () => void; onStart?: (applyDefinition: boolean) => void; onProgress?: (service: RuntimeServiceResult) => void; onMutation?: () => void; onDelegation?: (reason: string) => void } = {},
  budget = new RuntimeBudget()
) {
  const lastStates = new Map<string, ReturnType<typeof runtimeStateOf>>();
  const onInspect = (serviceName: string, inspect: RawInspect) => { lastStates.set(serviceName, runtimeStateOf(inspect)); };
  try { return await stackLocks.runExclusive(projectLockKey({ projectName: project.projectName }), async () => {
    if (!registry.isAllowed(anchor) && ![...registryEntriesByService(project).values()].some((entry) => registry.isAllowed(entry.containerId))) {
      throw new StackEndpointError(409, "state-changed");
    }
    let timer: ReturnType<typeof setInterval> | undefined;
    let observing: Promise<void> | undefined;
    let stopped = false;
    let observationFailure: ActionFailure | undefined;
    let stopContainerIds: string[] = [];
    let restartContainers: RawInspect[] = [];
    const prepareRestartIntent = async () => {
      if (action !== "restart") return;
      const inspected = await Promise.all(stopContainerIds.map(async (id) => {
        try {
          const inspect = await budget.run((options) => engine.inspect(id, options));
          for (const [serviceName, state] of lastStates) if (state.containerId === id) onInspect(serviceName, inspect);
          return inspect;
        }
        catch (error) {
          if (error instanceof EngineError && error.status === 404) return null;
          throw error;
        }
      }));
      restartContainers = inspected.filter((container) => container !== null);
    };
    const mutate = async (operation: (options: Required<RuntimeCallOptions>) => Promise<unknown>, onMutation: () => void) => {
      budget.remaining();
      const finish = action === "restart" ? stopIntents.beginHubRestart(restartContainers)
        : action === "stop" ? stopIntents.beginHubStop(stopContainerIds, actor) : () => {};
      let mutationStarted = false;
      try {
        return await budget.run((options) => {
          mutationStarted = true;
          onMutation();
          return operation(options);
        });
      } finally { finish(mutationStarted); }
    };
    const seen = new Map<string, string>();
    const progress = (service: RuntimeServiceResult) => {
      const value = JSON.stringify(service);
      if (value === seen.get(service.serviceName)) return;
      seen.set(service.serviceName, value);
      callbacks.onProgress?.(service);
    };
    const observe = async (prepared: PreparedStack) => {
      const current = await currentStackContainers(project, budget);
      const services = [];
      for (const before of prepared.context.services) {
        const container = current.get(before.serviceName);
        // Poll only authorized containers; new ids are authorized after reanchor.
        if (container && !registry.isAllowed(container.containerId)) continue;
        const inspect = container ? await budget.run((options) => engine.inspect(container.containerId, options)) : null;
        lastStates.set(before.serviceName, runtimeStateOf(inspect));
        services.push({ ...before, ...runtimeStateOf(inspect) });
      }
      if (!stopped) for (const service of runtimeServices(action, { ...prepared.context, services }, prepared.externallyManaged)) progress(service);
    };
    try {
      return await executeStackRuntimeAction({
        prepare: () => prepareStack(project, { mutating: true, action, actor, runtimeAction: true, onDelegation: callbacks.onDelegation, budget, onInspect }),
        checkRuntimeScope: (prepared) => {
          if (config.readOnly) throw new StackEndpointError(503, "agent-read-only");
          for (const service of prepared.context.services) {
            if (!service.containerId) continue;
            const access = registry.checkAccess(service.containerId, true);
            if (access !== "allowed") throw new StackEndpointError(403, "stack-service-gate-denied");
          }
        },
        checkCreateScope: (prepared) => {
          if (config.readOnly) throw new StackEndpointError(503, "agent-read-only");
          ensureCreateScopeAllowlisted(prepared);
          ensureCreateScopeNotExternallyManaged(prepared);
        },
        imageId: (ref) => budget.run((options) => engine.imageId(ref, options)),
        beforeMutation: async () => { await prepareRestartIntent(); budget.remaining(); },
        lastKnownContext: (prepared) => ({ ...prepared.context, services: prepared.context.services.map((service) => ({
          ...service, ...lastStates.get(service.serviceName)
        })) }),
        up: ({ applyDefinition, forceRecreate, timeoutMs }, onMutation) => mutate((options) => composeUp(project, {
          removeOrphans: false, pullNever: true, wait: false,
          forceRecreate, noRecreate: !applyDefinition, timeoutMs: Math.min(timeoutMs, options.timeoutMs), signal: options.signal
        }), onMutation),
        start: (timeoutMs, onMutation) => mutate((options) => composeStart(project, Math.min(timeoutMs, options.timeoutMs), options.signal), onMutation),
        stop: (timeoutMs, onMutation) => mutate((options) => composeStop(project, Math.min(timeoutMs, options.timeoutMs), options.signal), onMutation),
        restart: (timeoutMs, startWithUp, onMutation) => mutate((options) => composeDependencySafeRestart(project, Math.min(timeoutMs, options.timeoutMs), undefined, startWithUp ? {
          removeOrphans: false, pullNever: true, wait: false, noRecreate: true, forceRecreate: false
        } : undefined, options.signal), onMutation),
        refresh: async (prepared) => {
          stopped = true;
          if (timer) clearInterval(timer);
          await observing;
          await reanchorStackRegistry(prepared, budget);
          return (await prepareStack(project, { mutating: false, action: "stack-context", actor, runtimeAction: true, budget, onInspect })).context;
        }
      }, action, body, {
        signal,
        onStart: (applyDefinition, prepared) => {
          stopContainerIds = Object.values(containerIdsOf(prepared.context));
          callbacks.onStart?.(applyDefinition);
          if (callbacks.onProgress) timer = setInterval(() => {
            if (!observing) {
              observing = observe(prepared).catch((error) => {
                observationFailure ??= actionFailureOf(error, true);
              }).finally(() => { observing = undefined; });
            }
          }, 1000);
        },
        observationFailure: () => observationFailure,
        onMutation: callbacks.onMutation,
        onProgress: progress
      });
    } finally {
      stopped = true;
      if (timer) clearInterval(timer);
      await observing;
    }
  }, { waitMs: budget.remaining(ACTION_QUEUE_WAIT_MS), signal, onQueued: callbacks.onQueued });
  } catch (error) {
    const failure = actionFailureOf(error, true);
    if (error instanceof RuntimeActionFailure) throw error;
    const services = [...lastStates].map(([serviceName, state]) => ({ serviceName, ...state, outcome: "failed" as const }));
    throw new RuntimeActionFailure({ ...failure, body: { ...failure.body, ok: false, action,
      applyDefinition: body.applyDefinition === true, outcome: "failed", services,
      containerIds: Object.fromEntries(services.flatMap((service) => service.containerId ? [[service.serviceName, service.containerId]] : []))
    } });
  }
}
