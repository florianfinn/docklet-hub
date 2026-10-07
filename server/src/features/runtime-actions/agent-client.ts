import { containerRuntimeResultSchema, stackRuntimeResultSchema, stackActionStreamLineSchema,
  hubContainerRuntimeResultSchema, hubStackRuntimeResultSchema, readNdjson,
  type RuntimeAction } from "contract";
import { AgentError, agentStreamPost, streamBodyOf, type AgentTarget, type RequestOptions }
  from "../../platform/agent-transport/protocol.js";
import { watchStreamRejection, agentFailureReason } from "../../platform/agent-transport/stream-rejection.js";
import type { AgentStreamRelay } from "../../platform/streams/agent-stream-relay.js";
import { runtimeErrorKey, runtimeRejection } from "./rejections.js";
import { RUNTIME_TIMEOUT_MS, runtimePost, runtimeFetch, runtimeJson } from "./transport.js";

function invalidResponse(): AgentError {
  return new AgentError("Ungültiges Laufzeitergebnis.", 502, { detail: { error: "runtime-invalid-response" } });
}

export function containerResult(raw: unknown) {
  const parsed = containerRuntimeResultSchema.safeParse(raw);
  if (!parsed.success) throw invalidResponse();
  return hubContainerRuntimeResultSchema.parse({ ...parsed.data,
    ...(parsed.data.error === undefined ? {} : { error: runtimeErrorKey(parsed.data.error) }) });
}
export function stackResult(raw: unknown) {
  const parsed = stackRuntimeResultSchema.safeParse(raw);
  if (!parsed.success) throw invalidResponse();
  return hubStackRuntimeResultSchema.parse({ ...parsed.data,
    ...(parsed.data.error === undefined ? {} : { error: runtimeErrorKey(parsed.data.error) }) });
}

export async function runContainer(target: AgentTarget, id: string, action: RuntimeAction, body: unknown,
  options: RequestOptions) {
  return containerResult(await runtimePost(target, `/containers/${encodeURIComponent(id)}/${action}`, body, options));
}

export async function runStack(target: AgentTarget, id: string, action: RuntimeAction, body: unknown,
  options: RequestOptions, relay: AgentStreamRelay) {
  const path = `/stacks/${encodeURIComponent(id)}/actions/${action}`;
  const watch = watchStreamRejection(runtimeFetch(options.fetchImpl));
  let response: Response;
  try {
    response = await agentStreamPost(target, `${path}-stream`, body,
      { ...options, fetchImpl: watch.fetchImpl, signal: relay.signal, timeoutMs: RUNTIME_TIMEOUT_MS });
  } catch (caught) {
    const error = await watch.withDetail(caught);
    const reason = agentFailureReason(error);
    // A named target refusal must never execute a second request.
    if (!(error instanceof AgentError) || error.status !== 404 ||
      (reason !== null && reason !== "not-found" && reason !== "unknown-route")) throw error;
    relay.signal.throwIfAborted();
    const result = stackResult(await runtimePost(target, path, body, { ...options, signal: relay.signal }));
    await relay.write({ kind: "result", status: 200, body: result });
    return;
  }
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) {
    const result = stackResult(await runtimeJson(response));
    await relay.write({ kind: "result", status: response.status, body: result });
    return;
  }
  relay.open();
  let terminal = false;
  try {
    await readNdjson(streamBodyOf(response, path), { signal: relay.signal }, async (raw) => {
      const parsed = stackActionStreamLineSchema.safeParse(raw);
      if (!parsed.success) return;
      if (terminal) throw invalidResponse();
      const line = parsed.data;
      if (line.kind === "result") {
        terminal = true;
        await relay.write({ ...line, body: stackResult(line.body) });
      } else if (line.kind === "error") {
        terminal = true;
        const error = runtimeRejection(new AgentError("Laufzeitaktion abgelehnt.", line.status ?? 502,
          { detail: { ...line.body, error: line.reason } }), true);
        await relay.write({ kind: "error", reason: error.body.error, status: error.status, body: error.body });
      } else await relay.write(line);
    });
    if (!terminal && !relay.signal.aborted) throw invalidResponse();
  } finally {
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
  }
}
