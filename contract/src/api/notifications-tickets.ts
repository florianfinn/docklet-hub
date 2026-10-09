import * as z from "zod/mini";
import { NOTIFICATION_LIMITS, notificationChannelSchema, notificationEventSchema, notificationIdSchema,
  notificationInstantSchema, notificationLabelSchema, notificationTargetSchema } from "./notifications.js";

// Available evidence contains only sanitized text; unknown or unsafe sources fail closed.
export const notificationLogEvidenceSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("available"),
    text: z.string().check(z.minLength(1), z.maxLength(NOTIFICATION_LIMITS.maxLogChars)), truncated: z.boolean() }),
  z.strictObject({ state: z.literal("unavailable"), reason: z.enum(["not-collected", "source-unavailable", "redaction-unavailable"]) })
]);
export const notificationTicketEvidenceSchema = z.strictObject({ logs: notificationLogEvidenceSchema });
export const notificationTicketStateSchema = z.enum(["open", "acknowledged", "resolved"]);
export const notificationTicketViewSchema = z.strictObject({
  id: notificationIdSchema, episodeKey: notificationIdSchema, event: notificationEventSchema,
  target: notificationTargetSchema, targetLabel: notificationLabelSchema,
  cause: z.string().check(z.minLength(1), z.maxLength(1000)),
  evidence: notificationTicketEvidenceSchema,
  action: z.enum(["inspect-self-healing", "check-connection", "inspect-update", "review-update"]),
  state: notificationTicketStateSchema, openedAt: notificationInstantSchema,
  acknowledgedAt: z.nullable(notificationInstantSchema), resolvedAt: z.nullable(notificationInstantSchema),
  affectedContainers: z.array(z.strictObject({ containerId: notificationIdSchema, label: notificationLabelSchema }))
    .check(z.maxLength(NOTIFICATION_LIMITS.maxAffectedContainers),
      z.refine((items) => new Set(items.map((item) => item.containerId)).size === items.length)),
  affectedContainerCount: z.number().check(z.int(), z.minimum(0)),
  pendingDeliveryCount: z.number().check(z.int(), z.minimum(0), z.maximum(8))
}).check(z.refine((ticket) => {
  if (ticket.state === "open" && (ticket.acknowledgedAt !== null || ticket.resolvedAt !== null)) return false;
  if (ticket.state === "acknowledged" && (ticket.acknowledgedAt === null || ticket.resolvedAt !== null)) return false;
  if (ticket.state === "resolved" && ticket.resolvedAt === null) return false;
  if (ticket.acknowledgedAt !== null && Date.parse(ticket.acknowledgedAt) < Date.parse(ticket.openedAt)) return false;
  if (ticket.resolvedAt !== null && Date.parse(ticket.resolvedAt) < Date.parse(ticket.acknowledgedAt ?? ticket.openedAt)) return false;
  if (ticket.affectedContainerCount < ticket.affectedContainers.length) return false;
  if (ticket.event !== "connection-lost" && (ticket.affectedContainerCount !== 0 || ticket.affectedContainers.length !== 0)) return false;
  if (["connection-lost", "agent-update-available"].includes(ticket.event) && ticket.target.kind !== "host") return false;
  if (["self-healing-exhausted", "container-update-available"].includes(ticket.event) && ticket.target.kind === "host") return false;
  const action = ticket.event === "self-healing-exhausted" ? "inspect-self-healing" :
    ticket.event === "connection-lost" ? "check-connection" : ticket.event === "update-failed" ? "inspect-update" : "review-update";
  return ticket.action === action;
}));
export const notificationTicketResponseSchema = z.strictObject({ ticket: notificationTicketViewSchema });
const pageFields = { cursor: z.optional(notificationIdSchema), limit: z.optional(z.number().check(z.int(),
  z.minimum(1), z.maximum(NOTIFICATION_LIMITS.maxPageSize))) };
export const notificationTicketsQuerySchema = z.strictObject({ ...pageFields,
  state: z.optional(notificationTicketStateSchema), event: z.optional(notificationEventSchema),
  hostId: z.optional(notificationIdSchema), targetKind: z.optional(z.enum(["host", "stack", "container"])) });
export const notificationTicketsResponseSchema = z.strictObject({
  tickets: z.array(notificationTicketViewSchema).check(z.maxLength(NOTIFICATION_LIMITS.maxPageSize)),
  nextCursor: z.nullable(notificationIdSchema)
});
export const notificationCountsResponseSchema = z.strictObject({
  open: z.number().check(z.int(), z.minimum(0)), acknowledged: z.number().check(z.int(), z.minimum(0)),
  active: z.number().check(z.int(), z.minimum(0))
}).check(z.refine((counts) => counts.active === counts.open + counts.acknowledged));
export const notificationAckRequestSchema = z.strictObject({});
export const notificationDeliveryStateSchema = z.enum(["queued", "sending", "retrying", "delivered", "failed", "cancelled"]);
export const notificationDeliveryViewSchema = z.strictObject({
  id: notificationIdSchema, ticketId: z.nullable(notificationIdSchema),
  phase: z.enum(["initial", "recovery", "test"]), channel: notificationChannelSchema,
  generation: z.number().check(z.int(), z.minimum(0)),
  state: notificationDeliveryStateSchema, attempts: z.number().check(z.int(), z.minimum(0), z.maximum(NOTIFICATION_LIMITS.maxAttempts)),
  createdAt: notificationInstantSchema, updatedAt: notificationInstantSchema,
  nextAttemptAt: z.nullable(notificationInstantSchema), finishedAt: z.nullable(notificationInstantSchema),
  failure: z.nullable(z.enum(["transient", "timeout", "authentication", "validation", "destination-rejected", "configuration-missing"])),
  includeLogs: z.boolean()
}).check(z.refine((delivery) => {
  if ((delivery.phase === "test") !== (delivery.ticketId === null)) return false;
  if (Date.parse(delivery.updatedAt) < Date.parse(delivery.createdAt)) return false;
  const terminal = ["delivered", "failed", "cancelled"].includes(delivery.state);
  if (terminal !== (delivery.finishedAt !== null)) return false;
  if (delivery.finishedAt !== null && (Date.parse(delivery.finishedAt) < Date.parse(delivery.createdAt) ||
    Date.parse(delivery.finishedAt) > Date.parse(delivery.updatedAt))) return false;
  if (delivery.state === "retrying" && delivery.nextAttemptAt !== null &&
    Date.parse(delivery.nextAttemptAt) <= Date.parse(delivery.updatedAt)) return false;
  if (["queued", "retrying"].includes(delivery.state) !== (delivery.nextAttemptAt !== null)) return false;
  if (delivery.state === "queued" && (delivery.attempts !== 0 || delivery.failure !== null)) return false;
  if (delivery.state === "retrying" && (delivery.attempts < 1 || delivery.attempts >= NOTIFICATION_LIMITS.maxAttempts ||
    !["transient", "timeout"].includes(delivery.failure ?? ""))) return false;
  if (["sending", "delivered"].includes(delivery.state) && delivery.attempts < 1) return false;
  if (delivery.state === "delivered" && delivery.failure !== null) return false;
  if (delivery.state === "failed" && delivery.failure === null) return false;
  if (delivery.state === "failed" && ["transient", "timeout"].includes(delivery.failure ?? "") &&
    delivery.attempts !== NOTIFICATION_LIMITS.maxAttempts) return false;
  return true;
}));
export const notificationDeliveryResponseSchema = z.strictObject({ delivery: notificationDeliveryViewSchema });
export const notificationDeliveriesQuerySchema = z.strictObject({ ...pageFields,
  ticketId: z.optional(notificationIdSchema), state: z.optional(notificationDeliveryStateSchema),
  channel: z.optional(notificationChannelSchema) });
export const notificationDeliveriesResponseSchema = z.strictObject({
  deliveries: z.array(notificationDeliveryViewSchema).check(z.maxLength(NOTIFICATION_LIMITS.maxPageSize)),
  nextCursor: z.nullable(notificationIdSchema)
});
export const notificationRetryRequestSchema = z.strictObject({ expectedGeneration: z.number().check(z.int(), z.minimum(0)) });
export type NotificationTicketView = z.infer<typeof notificationTicketViewSchema>;
export type NotificationTicketState = z.infer<typeof notificationTicketStateSchema>;
export type NotificationDeliveryView = z.infer<typeof notificationDeliveryViewSchema>;
export type NotificationDeliveryState = z.infer<typeof notificationDeliveryStateSchema>;
export type NotificationTicketsQuery = z.infer<typeof notificationTicketsQuerySchema>;
export type NotificationDeliveriesQuery = z.infer<typeof notificationDeliveriesQuerySchema>;

export type NotificationLogEvidence = z.infer<typeof notificationLogEvidenceSchema>;
export type NotificationTicketEvidence = z.infer<typeof notificationTicketEvidenceSchema>;
