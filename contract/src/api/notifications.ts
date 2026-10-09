import * as z from "zod/mini";

export const NOTIFICATION_API_VERSION = 1;
export const NOTIFICATION_CHANNELS = ["discord", "smtp", "gotify", "webhook"] as const;
export const NOTIFICATION_EVENTS = ["self-healing-exhausted", "connection-lost", "update-failed",
  "agent-update-available", "container-update-available"] as const;
export const NOTIFICATION_PLACEHOLDERS = ["target", "cause", "time", "action"] as const;
export const NOTIFICATION_LIMITS = {
  connectionGraceMs: 300_000,
  retryDelaysMs: [30_000, 120_000, 600_000],
  maxAttempts: 4,
  deliveryTimeoutMs: 15_000,
  resolvedRetentionMs: 30 * 24 * 60 * 60 * 1000,
  terminalDeliveryRetentionMs: 30 * 24 * 60 * 60 * 1000,
  maxTerminalDeliveries: 10_000,
  maxQueuedDeliveries: 10_000,
  maxHistoryEntriesPerTicket: 100,
  maxPageSize: 100,
  maxBulkTargets: 200,
  maxAffectedContainers: 200,
  maxTemplateChars: 2000,
  maxAdditionalTextChars: 1000,
  maxMessageChars: 8000,
  maxLogChars: 4000,
  maxSecretChars: 4096,
  maxIdChars: 200,
  maxLabelChars: 200
} as const;
export const DEFAULT_NOTIFICATION_FORMAT = "{target}\n{cause}\n{time}\n{action}";
export const DEFAULT_NOTIFICATION_DELIVERY_OPTIONS = { includeLogs: false, recovery: false, additionalText: "" } as const;
export const notificationIdSchema = z.string().check(z.minLength(1), z.maxLength(NOTIFICATION_LIMITS.maxIdChars));
export const notificationLabelSchema = z.string().check(z.minLength(1), z.maxLength(NOTIFICATION_LIMITS.maxLabelChars));
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export const notificationEventSchema = z.enum(NOTIFICATION_EVENTS);
export const notificationInstantSchema = z.iso.datetime();

// Braces are reserved for the four literal tokens; no expressions or template execution.
export function notificationTemplateIsValid(value: string): boolean {
  if (value.length > NOTIFICATION_LIMITS.maxTemplateChars) return false;
  return !/[{}]/u.test(value.replace(/\{(target|cause|time|action)\}/gu, ""));
}
export const notificationTemplateSchema = z.string().check(z.maxLength(NOTIFICATION_LIMITS.maxTemplateChars),
  z.refine(notificationTemplateIsValid));
export const notificationFormatSchema = notificationTemplateSchema.check(z.minLength(1),
  z.refine((value) => NOTIFICATION_PLACEHOLDERS.every((key) => value.includes(`{${key}}`))));
export const notificationAdditionalTextSchema = notificationTemplateSchema.check(z.maxLength(NOTIFICATION_LIMITS.maxAdditionalTextChars));
export const notificationDeliveryOptionsSchema = z.strictObject({
  includeLogs: z.boolean(), recovery: z.boolean(), additionalText: notificationAdditionalTextSchema
});
export const notificationTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("host"), hostId: notificationIdSchema }),
  z.strictObject({ kind: z.literal("stack"), hostId: notificationIdSchema, stackName: notificationIdSchema }),
  z.strictObject({ kind: z.literal("container"), hostId: notificationIdSchema, containerId: notificationIdSchema })
]);
export const notificationScopeTargetSchema = z.union([notificationTargetSchema.options[1], notificationTargetSchema.options[2]]);
export const notificationFailureSchema = z.strictObject({ error: z.enum([
  "invalid-input", "unauthenticated", "admin-required", "forbidden-origin", "target-unknown", "ticket-unknown",
  "channel-unconfigured", "delivery-unknown", "conflict", "queue-full", "configuration-incomplete"
]) });
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;
export type NotificationEvent = z.infer<typeof notificationEventSchema>;
export type NotificationTarget = z.infer<typeof notificationTargetSchema>;
export type NotificationDeliveryOptions = z.infer<typeof notificationDeliveryOptionsSchema>;
