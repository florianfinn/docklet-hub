import * as z from "zod/mini";
import { stopIntentTargetSchema } from "./stop-intents.js";
import { SELF_HEALING_LIMITS } from "./self-healing.js";

export const SELF_HEALING_SYSTEM_ACTOR = "system:self-healing";
export const SELF_HEALING_RECOMMENDATION = "inspect-container-logs-and-configuration";
export const selfHealingMaintenanceTargetSchema = z.union([
  stopIntentTargetSchema,
  z.object({ kind: z.literal("stack"), projectName: z.string().check(z.minLength(1)) })
]);
export type SelfHealingMaintenanceTarget = z.infer<typeof selfHealingMaintenanceTargetSchema>;
export const selfHealingMaintenanceRequestSchema = z.strictObject({
  target: selfHealingMaintenanceTargetSchema,
  durationSeconds: z.optional(z.nullable(z.number().check(z.int(),
    z.minimum(SELF_HEALING_LIMITS.maintenanceDurationSeconds.min),
    z.maximum(SELF_HEALING_LIMITS.maintenanceDurationSeconds.max))))
});
export const selfHealingTargetRequestSchema = z.strictObject({ target: stopIntentTargetSchema });
export const selfHealingMaintenanceDeleteSchema = z.strictObject({ target: selfHealingMaintenanceTargetSchema });
export const selfHealingMaintenanceSchema = z.object({
  target: selfHealingMaintenanceTargetSchema,
  startedAt: z.iso.datetime(), expiresAt: z.nullable(z.iso.datetime()), actor: z.nullable(z.string())
});
export type SelfHealingMaintenance = z.infer<typeof selfHealingMaintenanceSchema>;
export const selfHealingAttemptSchema = z.object({
  attempt: z.number().check(z.int(), z.minimum(1)),
  startedAt: z.iso.datetime(), finishedAt: z.nullable(z.iso.datetime()),
  result: z.enum(["pending", "ok", "failed", "interrupted"]), error: z.nullable(z.string())
});
export type SelfHealingAttempt = z.infer<typeof selfHealingAttemptSchema>;
export const selfHealingCauseSchema = z.object({ exitCode: z.number().check(z.int()), engineError: z.nullable(z.string()) });
export type SelfHealingCause = z.infer<typeof selfHealingCauseSchema>;
export const selfHealingLogSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(true), lines: z.array(z.string()).check(z.maxLength(50)) }),
  z.object({ available: z.literal(false), reason: z.enum(["redaction-unavailable", "logs-unavailable"]) })
]);
export type SelfHealingLog = z.infer<typeof selfHealingLogSchema>;
export const selfHealingIncidentSchema = z.object({
  id: z.string().check(z.minLength(1)), target: stopIntentTargetSchema, containerId: z.string().check(z.minLength(1)),
  openedAt: z.iso.datetime(), closedAt: z.nullable(z.iso.datetime()),
  closedReason: z.nullable(z.enum(["manual-start", "acknowledged"])),
  cause: selfHealingCauseSchema, attempts: z.array(selfHealingAttemptSchema),
  recommendation: z.literal(SELF_HEALING_RECOMMENDATION), logs: selfHealingLogSchema
});
export type SelfHealingIncident = z.infer<typeof selfHealingIncidentSchema>;
export const selfHealingBudgetSchema = z.object({
  target: stopIntentTargetSchema, containerId: z.string(), usedAttempts: z.number().check(z.int(), z.minimum(0)),
  remainingAttempts: z.number().check(z.int(), z.minimum(0)), attempts: z.array(selfHealingAttemptSchema),
  nextAttemptAt: z.nullable(z.iso.datetime()), runningSince: z.nullable(z.iso.datetime())
});
export const selfHealingStatusResponseSchema = z.object({
  observing: z.boolean(), budgets: z.array(selfHealingBudgetSchema),
  maintenance: z.array(selfHealingMaintenanceSchema), incidents: z.array(selfHealingIncidentSchema)
});
export type SelfHealingStatusResponse = z.infer<typeof selfHealingStatusResponseSchema>;
