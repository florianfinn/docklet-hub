import { NOTIFICATION_LIMITS } from "contract";
import { acceptedJson, delivered, endpointUrl, failed, postJson, safeHeader, transportText,
  type NotificationMessage, type NotificationRuntimeConfig, type NotificationTransportOutcome } from "./http.js";

export async function sendGotify(config: Extract<NotificationRuntimeConfig, { kind: "gotify" }>,
  message: NotificationMessage, signal: AbortSignal): Promise<NotificationTransportOutcome> {
  const url = endpointUrl(config.endpoint);
  if (!url || !safeHeader(config.token) || url.search) return failed("validation");
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/message`;
  const text = transportText(message, NOTIFICATION_LIMITS.maxMessageChars - message.title.length - 2);
  if (text === null) return failed("validation");
  const outcome = await postJson(url, { title: message.title, message: text, priority: message.priority ?? 5 },
    { "X-Gotify-Key": config.token }, signal);
  if (outcome.status === "failed") return outcome;
  return acceptedJson(outcome.body, "gotify") ? delivered : failed("destination-rejected");
}
