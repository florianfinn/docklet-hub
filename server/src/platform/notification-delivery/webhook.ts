import { NOTIFICATION_LIMITS } from "contract";
import { delivered, endpointUrl, failed, postJson, safeHeader, transportText,
  type NotificationMessage, type NotificationRuntimeConfig, type NotificationTransportOutcome } from "./http.js";

export async function sendWebhook(config: Extract<NotificationRuntimeConfig, { kind: "webhook" }>,
  message: NotificationMessage, signal: AbortSignal): Promise<NotificationTransportOutcome> {
  const url = endpointUrl(config.endpoint);
  if (!url || (config.authorization !== null && !safeHeader(config.authorization))) return failed("validation");
  const text = transportText(message, NOTIFICATION_LIMITS.maxMessageChars - message.title.length - 2);
  if (text === null) return failed("validation");
  const outcome = await postJson(url, { title: message.title, text, idempotencyKey: message.idempotencyKey },
    { "Idempotency-Key": message.idempotencyKey, ...(config.authorization === null ? {} : { Authorization: config.authorization }) }, signal);
  if (outcome.status === "failed") return outcome;
  return outcome.body.trim() === "false" ? failed("destination-rejected") : delivered;
}
