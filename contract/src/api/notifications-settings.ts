import * as z from "zod/mini";
import { NOTIFICATION_LIMITS, notificationAdditionalTextSchema, notificationChannelSchema,
  notificationDeliveryOptionsSchema, notificationFormatSchema, notificationIdSchema,
  notificationScopeTargetSchema } from "./notifications.js";

const secretValue = z.string().check(z.minLength(1), z.maxLength(NOTIFICATION_LIMITS.maxSecretChars));
const endpoint = z.url().check(z.maxLength(NOTIFICATION_LIMITS.maxSecretChars),
  z.refine((value) => { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; }));
const secretUpdate = (value: typeof secretValue) => z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("keep") }),
  z.strictObject({ operation: z.literal("set"), value }),
  z.strictObject({ operation: z.literal("clear") })
]);
export const notificationSecretInputSchema = secretUpdate(secretValue);
const endpointUpdate = secretUpdate(endpoint);
const smtpConnection = z.strictObject({
  host: secretValue, port: z.number().check(z.int(), z.minimum(1), z.maximum(65535)),
  security: z.enum(["tls", "starttls"]), username: z.nullable(secretValue), password: z.nullable(secretValue),
  from: z.email().check(z.maxLength(320)), to: z.array(z.email().check(z.maxLength(320))).check(z.minLength(1), z.maxLength(20))
});
export const notificationChannelWriteSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("discord"), endpoint: endpointUpdate, defaults: notificationDeliveryOptionsSchema }),
  z.strictObject({ kind: z.literal("webhook"), endpoint: endpointUpdate, authorization: notificationSecretInputSchema,
    defaults: notificationDeliveryOptionsSchema }),
  z.strictObject({ kind: z.literal("gotify"), endpoint: endpointUpdate, token: notificationSecretInputSchema,
    defaults: notificationDeliveryOptionsSchema }),
  z.strictObject({ kind: z.literal("smtp"), connection: z.discriminatedUnion("operation", [
    z.strictObject({ operation: z.literal("keep") }), z.strictObject({ operation: z.literal("clear") }),
    z.strictObject({ operation: z.literal("set"), value: smtpConnection })
  ]), defaults: notificationDeliveryOptionsSchema })
]);
// Views disclose presence only, including private destinations and SMTP addressing.
export const notificationChannelViewSchema = z.strictObject({
  kind: notificationChannelSchema, configured: z.boolean(), destinationConfigured: z.boolean(),
  credentialConfigured: z.boolean(), defaults: notificationDeliveryOptionsSchema
});
const overrideFields = { includeLogs: z.optional(z.boolean()), recovery: z.optional(z.boolean()),
  additionalText: z.optional(notificationAdditionalTextSchema) };
const containerEvents = z.enum(["self-healing-exhausted", "update-failed", "container-update-available"]);
const hostEvents = z.enum(["connection-lost", "update-failed", "agent-update-available"]);
const uniqueEvents = <T extends z.core.$ZodType<string>>(schema: T) => z.array(schema).check(z.minLength(1), z.maxLength(3),
  z.refine((items) => new Set(items).size === items.length));
const selectionFields = { channel: notificationChannelSchema, events: uniqueEvents(containerEvents) };
export const notificationSelectionWriteSchema = z.strictObject({ ...selectionFields,
  overrides: z.strictObject({ ...overrideFields, destination: z.optional(endpointUpdate) })
}).check(z.refine((selection) => selection.overrides.destination === undefined || ["discord", "webhook"].includes(selection.channel)));
export const notificationSelectionViewSchema = z.strictObject({ ...selectionFields,
  overrides: z.strictObject({ ...overrideFields, destinationConfigured: z.boolean() })
}).check(z.refine((selection) => !selection.overrides.destinationConfigured || ["discord", "webhook"].includes(selection.channel)));
const selections = <T extends z.core.$ZodType<{ channel: string }>>(schema: T) => z.array(schema).check(z.maxLength(4),
  z.refine((items) => new Set(items.map((item) => item.channel)).size === items.length));
export const notificationScopeWriteSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("inherit") }),
  z.strictObject({ mode: z.literal("explicit"), selections: selections(notificationSelectionWriteSchema) })
]);
export const notificationScopeViewSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("inherit") }),
  z.strictObject({ mode: z.literal("explicit"), selections: selections(notificationSelectionViewSchema) })
]);
export const notificationHostRuleSchema = z.strictObject({ channel: notificationChannelSchema, events: uniqueEvents(hostEvents),
  overrides: z.strictObject(overrideFields) });
const settingsFields = { revision: z.number().check(z.int(), z.minimum(0)), format: notificationFormatSchema,
  hostRules: selections(notificationHostRuleSchema) };
export const notificationSettingsViewSchema = z.strictObject({ ...settingsFields,
  channels: z.array(notificationChannelViewSchema).check(z.length(4),
    z.refine((items) => new Set(items.map((item) => item.kind)).size === items.length)),
  defaults: selections(notificationSelectionViewSchema)
});
export const notificationSettingsWriteSchema = z.strictObject({ expectedRevision: settingsFields.revision,
  format: notificationFormatSchema, hostRules: settingsFields.hostRules,
  channels: z.array(notificationChannelWriteSchema).check(z.length(4),
    z.refine((items) => new Set(items.map((item) => item.kind)).size === items.length)),
  defaults: selections(notificationSelectionWriteSchema)
});
export const notificationSettingsResponseSchema = z.strictObject({ notifications: notificationSettingsViewSchema });
export const notificationScopeResponseSchema = z.strictObject({ target: notificationScopeTargetSchema,
  revision: settingsFields.revision, configuration: notificationScopeViewSchema,
  inheritedFrom: z.enum(["global", "stack", "container"]), effective: selections(notificationSelectionViewSchema) });
export const notificationScopeRequestSchema = z.strictObject({ expectedRevision: settingsFields.revision,
  configuration: notificationScopeWriteSchema });
export const notificationBulkRequestSchema = z.strictObject({ expectedRevision: settingsFields.revision,
  targets: z.array(notificationScopeTargetSchema).check(z.minLength(1), z.maxLength(NOTIFICATION_LIMITS.maxBulkTargets),
    z.refine((items) => new Set(items.map((item) => JSON.stringify(item))).size === items.length)),
  configuration: notificationScopeWriteSchema });
export const notificationBulkResponseSchema = z.strictObject({ revision: settingsFields.revision,
  targets: z.array(notificationScopeResponseSchema).check(z.minLength(1), z.maxLength(NOTIFICATION_LIMITS.maxBulkTargets)) });
export const notificationTestRequestSchema = z.strictObject({ channel: notificationChannelSchema });

export type NotificationSelectionView = z.infer<typeof notificationSelectionViewSchema>;
export type NotificationScopeView = z.infer<typeof notificationScopeViewSchema>;
export type NotificationSettingsView = z.infer<typeof notificationSettingsViewSchema>;
export type NotificationSettingsWrite = z.infer<typeof notificationSettingsWriteSchema>;
export type NotificationScopeWrite = z.infer<typeof notificationScopeWriteSchema>;
export type NotificationBulkRequest = z.infer<typeof notificationBulkRequestSchema>;
export type NotificationChannelWrite = z.infer<typeof notificationChannelWriteSchema>;
export type NotificationChannelView = z.infer<typeof notificationChannelViewSchema>;

// Explicit container settings replace the complete stack selection, including empty disablement.
export function resolveNotificationSelection(defaults: NotificationSelectionView[], stack: NotificationScopeView,
  container?: NotificationScopeView): { inheritedFrom: "global" | "stack" | "container"; effective: NotificationSelectionView[] } {
  if (container?.mode === "explicit") return { inheritedFrom: "container", effective: container.selections };
  if (stack.mode === "explicit") return { inheritedFrom: "stack", effective: stack.selections };
  return { inheritedFrom: "global", effective: defaults };
}
