import { createHash } from "node:crypto";
import { NOTIFICATION_LIMITS, notificationFormatSchema, notificationTicketViewSchema,
  type NotificationChannel } from "contract";
import type { NotificationMessage } from "../../platform/notification-delivery/index.js";
import type { NotificationDeliverySnapshot } from "./delivery-types.js";

export class NotificationMessageError extends Error {
  constructor() { super("validation"); }
}
const marker = "\n[…]";
const actions = {
  "inspect-self-healing": "Selbstheilung prüfen und bei Bedarf bewusst wieder freigeben.",
  "check-connection": "Verbindung zum Host prüfen.",
  "inspect-update": "Update-Ergebnis und Fehlerursache prüfen.",
  "review-update": "Verfügbares Update prüfen."
};
function safeText(value: string): boolean {
  return Array.from(value).every((character) => {
    const code = character.codePointAt(0)!;
    return (code === 9 || code === 10 || code === 13 || code >= 32) &&
      !(code >= 127 && code <= 159) && !(code >= 0xd800 && code <= 0xdfff);
  });
}
function expand(template: string, values: Record<string, string>, limit: number, optional = false): string {
  // Measure expansion first and allocate at most the output budget.
  let size = template.length;
  const tokens = /\{(target|cause|time|action)\}/gu;
  for (const match of template.matchAll(tokens)) size += values[match[1]].length - match[0].length;
  if (size > limit && (!optional || limit < marker.length)) throw new NotificationMessageError();
  const budget = size > limit ? Math.max(0, limit - marker.length) : limit;
  const parts: string[] = [];
  let used = 0; let offset = 0;
  const append = (text: string) => {
    const part = text.slice(0, Math.max(0, budget - used));
    parts.push(part); used += part.length;
  };
  for (const match of template.matchAll(tokens)) {
    append(template.slice(offset, match.index)); append(values[match[1]]);
    offset = match.index + match[0].length;
    if (used >= budget) break;
  }
  if (used < budget) append(template.slice(offset));
  let result = parts.join("");
  if (size > limit) {
    if (/[\uD800-\uDBFF]$/u.test(result)) result = result.slice(0, -1);
    return result + marker;
  }
  return result;
}
function truncate(value: string, budget: number): string {
  if (value.length <= budget) return value;
  if (budget < marker.length) return "";
  let prefix = value.slice(0, budget - marker.length);
  if (/[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
  return prefix + marker;
}
function optionalParts(parts: string[], budget: number): string {
  const nonempty = parts.filter(Boolean);
  const size = nonempty.reduce((sum, part) => sum + part.length, 0) + Math.max(0, nonempty.length - 1);
  if (size <= budget) return nonempty.join("\n");
  if (budget < marker.length) throw new NotificationMessageError();
  let prefix = "";
  for (const part of nonempty) {
    if (prefix) prefix += "\n";
    prefix += part.slice(0, Math.max(0, budget - marker.length - prefix.length));
    if (prefix.length >= budget - marker.length) break;
  }
  if (/[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
  return prefix + marker;
}
function escapedLength(value: string): number {
  return value.length + (value.match(/[\\`*_{}[\]()<>#+.!|~-]/gu)?.length ?? 0);
}
export function renderNotificationMessage(snapshot: NotificationDeliverySnapshot, identity: {
  id: string; generation: number; channel: NotificationChannel; phase: "initial" | "recovery" | "test"
}): NotificationMessage {
  const checked = notificationTicketViewSchema.safeParse(snapshot.ticket);
  if (!checked.success || !notificationFormatSchema.safeParse(snapshot.format).success ||
    snapshot.options.additionalText.length > 2001 || !safeText(snapshot.options.additionalText) || /[{}]/u.test(snapshot.options.additionalText.replace(/\{(target|cause|time|action)\}/gu, "")) ||
    !Number.isSafeInteger(identity.generation) || identity.generation < 0) throw new NotificationMessageError();
  const ticket = checked.data;
  const title = identity.phase === "recovery" ? "docklet hub: Erholung" : identity.phase === "test" ? "docklet hub: Testnachricht" : "docklet hub: Ereignis";
  const values = { target: ticket.targetLabel, cause: identity.phase === "recovery" ? `Erholung: ${ticket.cause}` : ticket.cause,
    time: new Date(identity.phase === "recovery" ? ticket.resolvedAt ?? ticket.openedAt : ticket.openedAt).toISOString(),
    action: identity.phase === "test" ? "Testnachricht am gespeicherten Kanal prüfen." : actions[ticket.action] };
  const requiredText = expand(snapshot.format, values, NOTIFICATION_LIMITS.maxMessageChars - title.length - 2);
  if (!safeText(title) || title.length > 200 || !safeText(requiredText)) throw new NotificationMessageError();
  if (identity.channel === "discord" && escapedLength(`${title}\n${requiredText}`) > 2000) throw new NotificationMessageError();
  let budget = NOTIFICATION_LIMITS.maxMessageChars - title.length - requiredText.length - 2;
  const addition = expand(snapshot.options.additionalText, values, budget, true);
  const logs = identity.phase !== "test" && snapshot.options.includeLogs && ticket.evidence.logs.state === "available"
    ? `Logs:\n${ticket.evidence.logs.text}${ticket.evidence.logs.truncated ? marker : ""}` : "";
  const optional = optionalParts([addition, logs], budget);
  if (!safeText(optional)) throw new NotificationMessageError();
  if (identity.channel === "discord") {
    const escapedBudget = 2000 - escapedLength(`${title}\n${requiredText}`) - 1;
    // Binary search the original text; T1 performs the actual Discord escaping.
    let low = 0; let high = Math.min(optional.length, budget);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (escapedLength(truncate(optional, middle)) <= escapedBudget) low = middle; else high = middle - 1;
    }
    budget = low;
  }
  const optionalText = truncate(optional, budget);
  if (optional && !optionalText) throw new NotificationMessageError();
  return { title, requiredText, ...(optionalText ? { optionalText } : {}),
    idempotencyKey: `notification:${createHash("sha256").update(identity.id).digest("hex")}:${identity.generation}` };
}
