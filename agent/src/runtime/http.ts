import http from "node:http";
import { requestRejectionOf, type RequestRejection } from "contract";
import { CONTRACT_HEADERS } from "../contract.js";
import { bodyWithLegacyKeys } from "../request-keys.js";
import {
  EngineError,
  engineMessage
} from "../engine.js";
import { UnauthThrottle } from "../unauth-log.js";
import { audit, secretCheck } from "./state.js";

// What belongs in the audit from an unexpected error. Truncated, because an
// engine response can be several hundred bytes long and the audit log is
// subject to a growth threshold.
export function errorText(error: unknown): string {
  if (error instanceof EngineError) return `EngineError: ${engineMessage(error)}`.slice(0, 300);
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300);
  return "unknown";
}

export const SAFE_ACTIONS = new Set(["start", "stop", "restart"]);

// The audit names of the three exec sub-paths. English since contract 6
// (#278); archived audit lines before it carry the old German names.
export const EXEC_AUDIT_NAME: Record<string, string> = {
  input: "exec-input",
  size: "exec-resize",
  close: "exec-close"
};

export function isAuthorized(request: http.IncomingMessage): boolean {
  const header = request.headers[CONTRACT_HEADERS.secret];
  const value = Array.isArray(header) ? header[0] : header;
  return secretCheck.check(value) !== "wrong";
}

export function send(response: http.ServerResponse, status: number, body: unknown): void {
  // With a stream response already running (pull-stream) the headers went
  // out long ago. A writeHead on it would throw — in the error handler, of
  // all places, where the original error would then get lost.
  if (response.headersSent) {
    response.end();
    return;
  }
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(payload);
}

// A body that is not JSON. The dispatcher answers it with `400 invalid-json`
// (dispatch.ts); before #272 it ended as a 500.
export class InvalidJsonError extends Error {}

export async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    // The agent only accepts small control messages.
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InvalidJsonError();
  }
  // TRANSITION (#418, reasoning in request-keys.ts): every body comes here,
  // so the old German key names are moved over in one place for all routes.
  return bodyWithLegacyKeys(parsed as Record<string, unknown>);
}

// The check of every request (#272): the body or query against its schema in
// `contract/src/agent/`, the same schema the hub builds the request from.
//
// ⚠️ The rejection names the KEY and the FIELD, never the value: a value can
// be a secret or a host path, and the caller writes the rejection to the
// append-only audit log (`auditRejection`).
export type Parsed<Output> = { ok: true; value: Output } | { ok: false; rejection: RequestRejection };

export function parseRequest<Output>(
  schema: { safeParse(input: unknown): { success: true; data: Output } | { success: false; error: { issues: readonly { message: string; path: readonly PropertyKey[] }[] } } },
  input: unknown
): Parsed<Output> {
  const result = schema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, rejection: requestRejectionOf(result.error.issues) };
}

// The audit text of a rejected request: the key and where it failed.
export function rejectionReason(rejection: RequestRejection): string {
  return rejection.field ? `${rejection.error} (${rejection.field})` : rejection.error;
}

// Refuses a request that failed its schema: one audit line, then the
// rejection as the body. `status` is 400 except where a key had another one
// before #272 (`413 too-large`, `413 input-too-large`).
export function rejectRequest(
  ctx: RouteContext,
  target: { action: string; containerId: string | null; containerName: string | null },
  rejection: RequestRejection,
  status = 400
): void {
  audit.write({
    action: target.action,
    containerId: target.containerId,
    containerName: target.containerName,
    actor: ctx.actor,
    outcome: "denied",
    reason: rejectionReason(rejection)
  });
  send(ctx.response, status, rejection);
}

export class BodyTooLarge extends Error {}

// Raw bytes instead of JSON — an uploaded file is binary, and sending it as
// base64 would cost a third more memory at the very place where memory is
// scarce.
export async function readRawBody(request: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function firstHeader(request: http.IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}


// See unauth-log.ts: first attempt per window immediately, all further ones as
// a counter in the next entry.
export const unauthThrottle = new UnauthThrottle();

export function logUnauth(
  method: string,
  pathname: string,
  actor: string | null
): void {
  const decision = unauthThrottle.report(Date.now());
  if (!decision.write) return;
  audit.write({
    // The path comes raw from the request; audit.ts truncates every field, here
    // it is additionally limited to what makes sense as an endpoint at all —
    // an 8 KB long "path" is not information but filler.
    action: `unauth:${method} ${pathname.slice(0, 120)}`,
    containerId: null,
    containerName: null,
    actor,
    outcome: "denied",
    reason: decision.suppressed > 0
      ? `bad-secret (+${decision.suppressed} more in the previous window)`
      : "bad-secret"
  });
}

// What every route handler gets from the dispatcher in index.ts.
export type RouteContext = {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  url: URL;
  actor: string | null;
};

// A handler below `/containers/:id`, and one below `/containers/:id/:action`.
export type ContainerContext = RouteContext & { containerId: string };
export type ContainerRouteContext = ContainerContext & { action: string };
