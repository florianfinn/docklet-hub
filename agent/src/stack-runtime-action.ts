import type { RuntimeAction, RuntimeServiceResult, StackActionRequest, StackRuntimeResult } from "contract";
import { expectedStackMatches, StackEndpointError } from "./stack-control.js";
import { gracePeriodSeconds, serviceResult, stackActionTimeoutMs, runtimeOutcome } from "./runtime-actions.js";
import type { PreparedStack, StackContextResponse } from "./runtime/stack.js";

export type StackRuntimeOps = {
  prepare: () => Promise<PreparedStack>;
  checkRuntimeScope: (prepared: PreparedStack) => void;
  checkCreateScope: (prepared: PreparedStack) => void;
  imageId: (ref: string) => Promise<string | null>;
  up: (options: { applyDefinition: boolean; forceRecreate: boolean; timeoutMs: number }) => Promise<unknown>;
  start: (timeoutMs: number) => Promise<unknown>;
  stop: (timeoutMs: number) => Promise<unknown>;
  restart: (timeoutMs: number, startWithUp: boolean) => Promise<unknown>;
  refresh: (prepared: PreparedStack) => Promise<StackContextResponse>;
};

export function runtimeServices(action: RuntimeAction, context: StackContextResponse, external: boolean): RuntimeServiceResult[] {
  return context.services.map((service) => serviceResult(action, service.serviceName, {
    containerId: service.containerId, status: service.status, exitCode: service.exitCode,
    health: service.health, startedAt: service.startedAt
  }, external));
}

export async function executeStackRuntimeAction(
  ops: StackRuntimeOps,
  action: RuntimeAction,
  body: StackActionRequest,
  options: { signal?: AbortSignal; onStart?: (applyDefinition: boolean, prepared: PreparedStack) => void; onProgress?: (service: RuntimeServiceResult) => void } = {}
): Promise<{ status: number; body: StackRuntimeResult & { context: StackContextResponse } }> {
  const prepared = await ops.prepare();
  const applyDefinition = body.applyDefinition === true && !prepared.externallyManaged;
  const creating = !prepared.externallyManaged && (action === "start" || action === "restart");
  let errorCode: string | undefined;
  let errorStatus = 409;
  let after: StackContextResponse;
  try {
    if (!expectedStackMatches(body.expectedStack, {
      projectName: prepared.project.projectName, projectDir: prepared.project.projectDir,
      composeFileName: prepared.project.composeFileName,
      services: prepared.context.services.map(({ serviceName, containerId, status, startedAt }) => ({ serviceName, containerId, status, startedAt }))
    })) throw new StackEndpointError(409, "state-changed");
    if (creating) {
      ops.checkCreateScope(prepared);
      if (!prepared.definitionReadable) throw new StackEndpointError(409, "compose-config-failed");
      const services = (prepared.normalized as { services: Record<string, { image?: string }> }).services;
      for (const name of prepared.definition.services) {
        const image = services[name]?.image;
        if (!image || !await ops.imageId(image)) throw new StackEndpointError(409, "runtime-image-missing");
      }
    }
    if (options.signal?.aborted) throw new StackEndpointError(409, "action-caller-disconnected");
    options.onStart?.(applyDefinition, prepared);
    for (const service of runtimeServices(action, prepared.context, prepared.externallyManaged)) options.onProgress?.(service);
    const services = (prepared.normalized as { services?: Record<string, { stop_grace_period?: string }> } | null)?.services ?? {};
    const timeoutMs = stackActionTimeoutMs(action, [
      ...prepared.context.services.map((service) => service.stopTimeoutSeconds),
      ...Object.values(services).map((service) => gracePeriodSeconds(service.stop_grace_period))
    ]);
    if (options.signal?.aborted) throw new StackEndpointError(409, "action-caller-disconnected");
    ops.checkRuntimeScope(prepared);
    if (creating) {
      ops.checkCreateScope(prepared);
      if (action === "restart" && !applyDefinition) await ops.restart(timeoutMs, true);
      else await ops.up({ applyDefinition, forceRecreate: action === "restart", timeoutMs });
    }
    else if (action === "start") await ops.start(timeoutMs);
    else if (action === "stop") await ops.stop(timeoutMs);
    else await ops.restart(timeoutMs, false);
  } catch (error) {
    errorCode = error instanceof StackEndpointError ? error.code : "compose-stack-action-failed";
    errorStatus = error instanceof StackEndpointError ? error.status : 409;
  } finally {
    // Refresh ids even after a guard or CLI failure: another writer may have
    // replaced containers before the operation acquired its project lock.
    try {
      after = await ops.refresh(prepared);
    } catch {
      errorCode = "runtime-state-unreadable";
      after = { ...prepared.context, services: prepared.context.services.map((service) => ({
        ...service, containerId: null, status: "unknown", exitCode: null, health: null, startedAt: null
      })) };
    }
  }
  const services = runtimeServices(action, after, prepared.externallyManaged);
  for (const service of services) options.onProgress?.(service);
  const outcome = runtimeOutcome(services);
  const ok = outcome === "ok" && !errorCode;
  return {
    status: ok ? 200 : errorStatus,
    body: {
      ok, action, applyDefinition, outcome, services,
      containerIds: Object.fromEntries(services.flatMap((service) => service.containerId ? [[service.serviceName, service.containerId]] : [])),
      context: after, ...(errorCode ? { error: errorCode } : outcome !== "ok" ? { error: "runtime-target-not-reached" } : {})
    }
  };
}
