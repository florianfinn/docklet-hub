import type { ActionFailure } from "./action-failure.js";
import { runtimeReadback } from "./runtime-readback.js";
import type { RuntimeAction, RuntimeServiceResult, StackActionRequest } from "contract";
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
  options: { signal?: AbortSignal; onStart?: (applyDefinition: boolean, prepared: PreparedStack) => void; onProgress?: (service: RuntimeServiceResult) => void; onMutation?: () => void; observationFailure?: () => ActionFailure | undefined } = {}
) {
  const prepared = await ops.prepare();
  const applyDefinition = body.applyDefinition === true && !prepared.externallyManaged;
  const creating = !prepared.externallyManaged && (action === "start" || action === "restart");
  let mutationStarted = false;
  const result = await runtimeReadback(async () => {
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
    if (creating) ops.checkCreateScope(prepared);
    mutationStarted = true;
    options.onMutation?.();
    if (creating) {
      if (action === "restart" && !applyDefinition) await ops.restart(timeoutMs, true);
      else await ops.up({ applyDefinition, forceRecreate: action === "restart", timeoutMs });
    }
    else if (action === "start") await ops.start(timeoutMs);
    else if (action === "stop") await ops.stop(timeoutMs);
    else await ops.restart(timeoutMs, false);
  }, () => ops.refresh(prepared), () => ({
    ...prepared.context, services: prepared.context.services.map((service) => ({
      ...service, containerId: null, status: "unknown", exitCode: null, health: null, startedAt: null
    }))
  }), (after) => {
    const services = runtimeServices(action, after, prepared.externallyManaged);
    for (const service of services) options.onProgress?.(service);
    const outcome = runtimeOutcome(services);
    const ok = outcome === "ok";
    return {
      ok, action, applyDefinition, outcome, services,
      containerIds: Object.fromEntries(services.flatMap((service) => service.containerId ? [[service.serviceName, service.containerId]] : [])),
      context: after, ...(ok ? {} : { error: "runtime-target-not-reached" })
    };
  }, options.observationFailure);
  return { ...result, mutationStarted };
}
