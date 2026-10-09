import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { NOTIFICATION_LIMITS, type NotificationDeliveryView } from "contract";

export type NotificationRuntimeConfig =
  | { kind: "discord"; endpoint: string }
  | { kind: "gotify"; endpoint: string; token: string }
  | { kind: "webhook"; endpoint: string; authorization: string | null }
  | { kind: "smtp"; host: string; port: number; security: "tls" | "starttls";
      username: string | null; password: string | null; from: string; to: string[] };
export interface NotificationMessage {
  title: string;
  requiredText: string;
  optionalText?: string;
  idempotencyKey: string;
  priority?: number;
}
export type NotificationTransportFailure = NonNullable<NotificationDeliveryView["failure"]>;
export type NotificationTransportOutcome = { status: "delivered" } |
  { status: "failed"; failure: NotificationTransportFailure };
export const delivered = { status: "delivered" } as const;
export const failed = (failure: NotificationTransportFailure): NotificationTransportOutcome => ({ status: "failed", failure });
export const MAX_RESPONSE_BYTES = 16_384;
export const TRUNCATION_MARKER = "\n[…]";
export function safeHeader(value: string): boolean {
  return value.length > 0 && value.length <= NOTIFICATION_LIMITS.maxSecretChars &&
    !Array.from(value).some((character) => {
      const code = character.codePointAt(0)!;
      return code < 0x20 || code >= 0x7f && code <= 0x9f;
    });
}
export function endpointUrl(endpoint: string): URL | null {
  if (!safeHeader(endpoint) || /\s/u.test(endpoint)) return null;
  try {
    const url = new URL(endpoint);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash ? url : null;
  } catch { return null; }
}
export function validMessage(message: NotificationMessage): boolean {
  return typeof message.title === "string" && safeHeader(message.title) && message.title.length <= NOTIFICATION_LIMITS.maxLabelChars &&
    typeof message.requiredText === "string" && message.requiredText.trim().length > 0 &&
    (message.optionalText === undefined || typeof message.optionalText === "string") &&
    message.title.length + message.requiredText.length + (message.optionalText?.length ?? 0) + 2 <= NOTIFICATION_LIMITS.maxMessageChars &&
    /^[A-Za-z0-9._:-]{1,200}$/u.test(message.idempotencyKey) &&
    (message.priority === undefined || (Number.isInteger(message.priority) && message.priority >= 0 && message.priority <= 10));
}
// Preserve every required character; optional truncation is marked and code points stay intact.
export function transportText(message: NotificationMessage, limit: number, escape = (text: string) => text): string | null {
  const required = escape(message.requiredText);
  const optional = escape(message.optionalText ?? "");
  if (required.length > limit) return null;
  if (!optional) return required;
  if (required.length + 1 + optional.length <= limit) return `${required}\n${optional}`;
  const budget = limit - required.length - 1 - TRUNCATION_MARKER.length;
  if (budget < 0) return null;
  let prefix = optional.slice(0, budget);
  if (/[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
  // An escaped Discord punctuation character must not consume the truncation marker.
  if (prefix.endsWith("\\")) prefix = prefix.replace(/\\+$/u, "");
  return `${required}\n${prefix}${TRUNCATION_MARKER}`;
}
function statusFailure(status: number): NotificationTransportFailure {
  if (status === 408) return "timeout";
  if (status === 429 || status >= 500) return "transient";
  if (status === 401 || status === 403) return "authentication";
  if (status === 400 || status === 413 || status === 422) return "validation";
  return "destination-rejected";
}
type HttpOutcome = { status: "delivered"; body: string } | Extract<NotificationTransportOutcome, { status: "failed" }>;
export function postJson(url: URL, payload: unknown, headers: Record<string, string>, signal: AbortSignal): Promise<HttpOutcome> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve({ status: "failed", failure: "timeout" }); return; }
    const body = JSON.stringify(payload);
    let settled = false;
    const finish = (outcome: HttpOutcome) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(outcome);
    };
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "POST", agent: false, maxHeaderSize: MAX_RESPONSE_BYTES,
      ...(url.protocol === "https:" ? { rejectUnauthorized: true } : {}),
      headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), ...headers }
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        finish({ status: "failed", failure: statusFailure(status) });
        response.destroy(); request.destroy(); return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          finish({ status: "failed", failure: "destination-rejected" });
          response.destroy(); request.destroy();
        } else chunks.push(chunk);
      });
      response.on("end", () => finish({ status: "delivered", body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", () => finish({ status: "failed", failure: signal.aborted ? "timeout" : "transient" }));
      response.on("aborted", () => finish({ status: "failed", failure: signal.aborted ? "timeout" : "transient" }));
    });
    const abort = () => { finish({ status: "failed", failure: "timeout" }); request.destroy(); };
    request.on("error", () => finish({ status: "failed", failure: signal.aborted ? "timeout" : "transient" }));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort(); else request.end(body);
  });
}
export function acceptedJson(body: string, kind: "discord" | "gotify"): boolean {
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object" || !("id" in value)) return false;
    return kind === "discord" ? typeof value.id === "string" && /^\d{1,30}$/u.test(value.id) :
      typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id > 0;
  } catch { return false; }
}
