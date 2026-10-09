import { createHash } from "node:crypto";
import { NOTIFICATION_LIMITS, notificationFormatSchema, notificationTemplateIsValid, notificationTicketViewSchema,
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
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) && !/[\uD800-\uDFFF]/u.test(value);
}
function expand(template: string, values: Record<string, string>, limit: number): string {
  // Measure literal expansion before allocating the expanded string.
  let size = template.length;
  for (const match of template.matchAll(/\{(target|cause|time|action)\}/gu)) {
    size += values[match[1]].length - match[0].length;
    if (size > limit) throw new NotificationMessageError();
  }
  return template.replace(/\{(target|cause|time|action)\}/gu, (_token, key: string) => values[key]);
}
function truncate(value: string, budget: number): string {
  if (value.length <= budget) return value;
  if (budget < marker.length) return "";
  let prefix = value.slice(0, budget - marker.length);
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
    snapshot.options.additionalText.length > 2001 || !notificationTemplateIsValid(snapshot.options.additionalText) ||
    !Number.isSafeInteger(identity.generation) || identity.generation < 0) throw new NotificationMessageError();
  const ticket = checked.data;
  const title = identity.phase === "recovery" ? "docklet hub: Erholung" : identity.phase === "test" ? "docklet hub: Testnachricht" : "docklet hub: Ereignis";
  const values = { target: ticket.targetLabel, cause: identity.phase === "recovery" ? `Erholung: ${ticket.cause}` : ticket.cause,
    time: new Date(identity.phase === "recovery" ? ticket.resolvedAt ?? ticket.openedAt : ticket.openedAt).toISOString(),
    action: identity.phase === "test" ? "Testnachricht am gespeicherten Kanal prüfen." : actions[ticket.action] };
  const requiredText = expand(snapshot.format, values, NOTIFICATION_LIMITS.maxMessageChars - title.length - 2);
  if (!safeText(title) || title.length > 200 || !safeText(requiredText)) throw new NotificationMessageError();
  if (identity.channel === "discord" && escapedLength(`${title}\n${requiredText}`) > 2000) throw new NotificationMessageError();
  const addition = expand(snapshot.options.additionalText, values, 400_000);
  const logs = snapshot.options.includeLogs && ticket.evidence.logs.state === "available"
    ? `Logs:\n${ticket.evidence.logs.text}${ticket.evidence.logs.truncated ? marker : ""}` : "";
  const optional = [addition, logs].filter(Boolean).join("\n");
  if (!safeText(optional)) throw new NotificationMessageError();
  let budget = NOTIFICATION_LIMITS.maxMessageChars - title.length - requiredText.length - 2;
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
