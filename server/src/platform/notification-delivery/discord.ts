import { acceptedJson, delivered, endpointUrl, failed, postJson, transportText,
  type NotificationMessage, type NotificationRuntimeConfig, type NotificationTransportOutcome } from "./http.js";

export async function sendDiscord(config: Extract<NotificationRuntimeConfig, { kind: "discord" }>,
  message: NotificationMessage, signal: AbortSignal): Promise<NotificationTransportOutcome> {
  const url = endpointUrl(config.endpoint);
  if (!url) return failed("validation");
  url.searchParams.set("wait", "true");
  const escape = (text: string) => text.replace(/[\\`*_{}[\]()<>#+.!|~-]/gu, "\\$&");
  const content = transportText({ ...message, requiredText: `${message.title}\n${message.requiredText}` }, 2000, escape);
  if (content === null) return failed("validation");
  const outcome = await postJson(url, { content, allowed_mentions: { parse: [] } }, {}, signal);
  if (outcome.status === "failed") return outcome;
  return acceptedJson(outcome.body, "discord") ? delivered : failed("destination-rejected");
}
