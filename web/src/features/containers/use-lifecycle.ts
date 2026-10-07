import { useState, useSyncExternalStore, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { hubContainerRuntimeResultSchema, hubStackRuntimeResultSchema,
  type HostOverview, type HubRuntimeContext, type RuntimeAction } from "contract";
import { retainHostOverview, type LiveState } from "../../domain/hosts";
import { queryKeys } from "../../platform/query/query-keys";
import { ApiError, errorCode } from "../../platform/http/transport";
import { useLifecycleSession } from "./LifecycleProvider";
import { fetchLifecycleHost, fetchRuntimeContext, runContainerAction, runStackAction } from "./api";
import { targetKey, targetContainers, requiresConfirmation, type LifecycleTarget } from "./lifecycle-state";
import type { OperationResult } from "./lifecycle-operations";

export type LifecycleQuestion = { action: RuntimeAction; target: LifecycleTarget; context?: HubRuntimeContext; changed: boolean };
export const LIFECYCLE_TIMEOUT_MS = 700_000;
export function useLifecycleState(target: LifecycleTarget) {
  const session = useLifecycleSession();
  const client = useQueryClient();
  const cache = client.getQueryCache();
  const overview = useSyncExternalStore(cache.subscribe.bind(cache),
    () => client.getQueryData<HostOverview[]>(queryKeys.containers.overview()));
  const live = useSyncExternalStore(cache.subscribe.bind(cache),
    () => client.getQueryData<LiveState>(queryKeys.hosts.live()));
  const host = overview?.find((entry) => entry.host.id === target.hostId);
  const staleHost = host && live?.hosts[target.hostId] === "disconnected"
    ? { ...host, host: { ...host.host, status: "offline" as const } } : host;
  const state = useSyncExternalStore(session.operations.subscribe, session.operations.snapshot, session.operations.snapshot);
  return { ...session, host: staleHost, operation: state.get(targetKey(target)), busy: session.operations.busy(target) };
}
export function useLifecycleAction(target: LifecycleTarget) {
  const client = useQueryClient();
  const { operations, signal: sessionSignal } = useLifecycleSession();
  const [question, setQuestion] = useState<LifecycleQuestion | null>(null);
  const sending = useRef(false);
  const context = (next: LifecycleTarget, signal?: AbortSignal) => client.fetchQuery({
    queryKey: queryKeys.containers.runtimeContext(next.hostId, targetContainers(next)[0].id),
    queryFn: () => fetchRuntimeContext(next.hostId, targetContainers(next)[0].id, signal), staleTime: 0
  });
  const reload = async (signal?: AbortSignal) => {
    const full = client.getQueryCache().find({ queryKey: queryKeys.containers.overview(), exact: true });
    if (full?.state.fetchStatus === "fetching") await full.promise?.catch(() => undefined);
    signal?.throwIfAborted(); sessionSignal?.throwIfAborted();
    const host = await fetchLifecycleHost(target.hostId, signal ?? sessionSignal);
    signal?.throwIfAborted(); sessionSignal?.throwIfAborted();
    client.setQueryData<HostOverview[]>(queryKeys.containers.overview(), (current) => current?.map((old) =>
      old.host.id === host.host.id ? retainHostOverview(host, old) : old));
    if (target.kind === "stack") {
      const stack = host.stacks.find((entry) => entry.project === target.stack.project);
      return stack ? { ...target, stack } : null;
    }
    const container = [...host.loose, ...host.stacks.flatMap((stack) => stack.containers)].find((entry) => entry.name === target.container.name);
    return container ? { ...target, container } : null;
  };
  const finish = (next: LifecycleTarget, result: OperationResult) => operations.update(next,
    { result, progress: "services" in result ? result.services : [], message: result.ok ? result.outcome : result.outcome === "ok" ? "failed" : result.outcome,
      phase: "done", busy: true, error: result.error });
  const failure = (next: LifecycleTarget, error: unknown, timedOut = false) => {
    const code = errorCode(error);
    operations.update(next, { phase: "done", error: code ?? undefined,
      message: timedOut || code === "runtime-action-timeout" ? "timeout" : !code || ["runtime-agent-unreachable", "runtime-stream-broken", "action-caller-disconnected"].includes(code) ? "unknown" : "failed" });
  };
  async function execute(request: LifecycleQuestion) {
    if (sending.current) return;
    sending.current = true; setQuestion(null);
    const next = request.target;
    const controller = new AbortController();
    const signal = sessionSignal ? AbortSignal.any([controller.signal, sessionSignal]) : controller.signal;
    let timedOut = false;
    let reconfirm = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, LIFECYCLE_TIMEOUT_MS);
    operations.update(next, { phase: "waiting" });
    try {
      signal.throwIfAborted();
      if (next.kind === "container") {
        finish(next, await runContainerAction(next.hostId, next.container.id, request.action,
          { containerId: next.container.id, status: next.container.status, startedAt: next.container.startedAt }, signal));
      } else {
        const value = request.context!;
        await runStackAction(next.hostId, next.stack.containers[0].id, request.action, value.expectedStack, (event) => {
          if (event.kind === "start") operations.update(next, { phase: "running" });
          if (event.kind === "progress") {
            const previous = operations.snapshot().get(targetKey(next))?.progress ?? [];
            operations.update(next, { phase: "running", progress: [...previous.filter((entry) => entry.serviceName !== event.service.serviceName), event.service] });
          }
          if (event.kind === "result") finish(next, event.body);
          if (event.kind === "error") {
            if (event.body && "services" in event.body && event.reason !== "state-changed") finish(next, event.body);
            throw new ApiError(event.status ?? 502, JSON.stringify({ error: event.reason }));
          }
        }, signal, value.applyDefinition);
      }
    } catch (error) {
      if (sessionSignal?.aborted) return;
      if (errorCode(error) === "state-changed") {
        operations.update(next, { message: "state-changed", phase: "preparing" });
        try {
          const fresh = await reload(signal);
          if (!fresh) throw new Error("target-gone", { cause: error });
          const value = fresh.kind === "stack" ? await context(fresh, signal) : undefined;
          setQuestion({ action: request.action, target: fresh, context: value, changed: true });
          operations.update(next, { busy: true }); reconfirm = true;
        } catch (readError) { failure(next, readError); }
      } else {
        let parsed: OperationResult | null = null;
        if (error instanceof ApiError) {
          try {
            const body: unknown = JSON.parse(error.message);
            const result = (next.kind === "stack" ? hubStackRuntimeResultSchema : hubContainerRuntimeResultSchema).safeParse(body);
            if (result.success) parsed = result.data;
          } catch { parsed = null; }
        }
        if (parsed) finish(next, parsed);
        else if (!operations.snapshot().get(targetKey(next))?.result) failure(next, error, timedOut);
      }
    } finally {
      clearTimeout(timer); sending.current = false;
      if (!reconfirm && !sessionSignal?.aborted) {
        await reload().catch(() => undefined);
        operations.update(next, { busy: false, phase: "done" });
      }
    }
  }
  const prepare = async (action: RuntimeAction) => {
    if (!operations.reserve(target)) return;
    try {
      const value = target.kind === "stack" ? await context(target, sessionSignal) : undefined;
      if (sessionSignal?.aborted) return;
      if (value?.readOnly) { failure(target, new ApiError(503, JSON.stringify({ error: "agent-read-only" }))); operations.update(target, { busy: false }); return; }
      const changed = value !== undefined && (value.hubOwned !== (target.kind === "stack" ? target.stack.hubOwned : false) ||
        value.applyDefinition !== client.getQueryData<HostOverview[]>(queryKeys.containers.overview())?.find((host) => host.host.id === target.hostId)?.lifecycle?.applyDefinition ||
        value.services.some((service) => {
          const seen = targetContainers(target).find((entry) => entry.compose?.service === service.serviceName);
          return seen !== undefined && (seen.id !== service.containerId || seen.status !== service.status || seen.startedAt !== service.startedAt);
        }));
      const request: LifecycleQuestion = { action, target, context: value, changed };
      if (changed || requiresConfirmation(target, action)) setQuestion(request);
      else await execute(request);
    } catch (error) { if (!sessionSignal?.aborted) { failure(target, error); operations.update(target, { busy: false }); } }
  };
  const cancel = () => {
    if (sending.current) return;
    setQuestion(null); operations.update(target, { busy: false, phase: "done" }); operations.clear(target);
  };
  return { question, prepare, confirm: () => question ? execute(question) : undefined, cancel, reload };
}
