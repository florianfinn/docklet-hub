import type { RuntimeAction, StackActionRequest, RuntimeServiceResult } from "contract";
import {
  composeStart, composeStop, composeDependencySafeRestart, composeUp
} from "../compose-cli.js";
import { executeStackRuntimeAction, runtimeServices } from "../stack-runtime-action.js";
import { ActionQueueError } from "../concurrency.js";
import { ACTION_QUEUE_WAIT_MS, runtimeStateOf } from "../runtime-actions.js";
import { config, engine, registry, stackLocks } from "./state.js";
import {
  StackEndpointError, prepareStack, currentStackContainers, reanchorStackRegistry,
  ensureCreateScopeAllowlisted, ensureCreateScopeNotExternallyManaged,
  registryEntriesByService, type StackResolvedProject, type PreparedStack
} from "./stack.js";

export async function runStackRuntimeAction(
  project: StackResolvedProject, anchor: string, action: RuntimeAction, body: StackActionRequest,
  actor: string | null, signal: AbortSignal,
  callbacks: { onStart?: (applyDefinition: boolean) => void; onProgress?: (service: RuntimeServiceResult) => void } = {}
) {
  try {
    return await stackLocks.runExclusive(project.projectName, async () => {
      if (!registry.isAllowed(anchor) && ![...registryEntriesByService(project).values()].some((entry) => registry.isAllowed(entry.containerId))) {
        throw new StackEndpointError(409, "state-changed");
      }
      let timer: ReturnType<typeof setInterval> | undefined;
      let observing: Promise<void> | undefined;
      let stopped = false;
      const seen = new Map<string, string>();
      const progress = (service: RuntimeServiceResult) => {
        const value = JSON.stringify(service);
        if (value === seen.get(service.serviceName)) return;
        seen.set(service.serviceName, value);
        callbacks.onProgress?.(service);
      };
      const observe = async (prepared: PreparedStack) => {
        const current = await currentStackContainers(project);
        const services = [];
        for (const before of prepared.context.services) {
          const container = current.get(before.serviceName);
          // Poll only authorized containers; new ids are authorized after reanchor.
          if (container && !registry.isAllowed(container.containerId)) continue;
          const inspect = container ? await engine.inspect(container.containerId) : null;
          services.push({ ...before, ...runtimeStateOf(inspect) });
        }
        if (!stopped) for (const service of runtimeServices(action, { ...prepared.context, services }, prepared.externallyManaged)) progress(service);
      };
      try {
        return await executeStackRuntimeAction({
          prepare: () => prepareStack(project, { mutating: true, action, actor, tolerateUnreadableDefinition: true }),
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
          imageId: (ref) => engine.imageId(ref),
          up: ({ applyDefinition, forceRecreate, timeoutMs }) => composeUp(project, {
            removeOrphans: false, pullNever: true, wait: false,
            forceRecreate, noRecreate: !applyDefinition, timeoutMs
          }),
          start: (timeoutMs) => composeStart(project, timeoutMs),
          stop: (timeoutMs) => composeStop(project, timeoutMs),
          restart: (timeoutMs, startWithUp) => composeDependencySafeRestart(project, timeoutMs, undefined, startWithUp ? {
            removeOrphans: false, pullNever: true, wait: false, noRecreate: true, forceRecreate: false
          } : undefined),
          refresh: async (prepared) => {
            stopped = true;
            if (timer) clearInterval(timer);
            await observing;
            await reanchorStackRegistry(prepared);
            return (await prepareStack(project, { mutating: false, action: "stack-context", actor, tolerateUnreadableDefinition: true })).context;
          }
        }, action, body, {
          signal,
          onStart: (applyDefinition, prepared) => {
            callbacks.onStart?.(applyDefinition);
            if (callbacks.onProgress) timer = setInterval(() => {
              if (!observing) {
                observing = observe(prepared).catch(() => {}).finally(() => { observing = undefined; });
              }
            }, 1000);
          },
          onProgress: progress
        });
      } finally {
        stopped = true;
        if (timer) clearInterval(timer);
        await observing;
      }
    }, { waitMs: ACTION_QUEUE_WAIT_MS, signal });
  } catch (error) {
    if (error instanceof ActionQueueError) throw new StackEndpointError(409, error.code);
    throw error;
  }
}
