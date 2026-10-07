import * as z from "zod/mini";
import { stopIntentsResponseSchema, stopIntentSchema } from "../agent/stop-intents.js";
import { selfHealingStatusResponseSchema } from "../agent/self-healing-status.js";
import { expectedStackSchema } from "../agent/compose-requests.js";

export const lifecycleSnapshotSchema = z.object({
  stopIntents: z.nullable(z.extend(stopIntentsResponseSchema, {
    intents: z.array(z.extend(stopIntentSchema, { actorName: z.optional(z.nullable(z.string())) }))
  })),
  selfHealing: z.nullable(selfHealingStatusResponseSchema),
  applyDefinition: z.boolean(),
  maintenanceDurationSeconds: z.nullable(z.number())
});
export type LifecycleSnapshot = z.infer<typeof lifecycleSnapshotSchema>;
export const runtimeAccessSchema = z.object({
  blocker: z.nullable(z.enum(["not-allowlisted", "observe-only", "self-management-locked"]))
});
export const hubRuntimeContextSchema = z.object({
  expectedStack: expectedStackSchema,
  hubOwned: z.nullable(z.boolean()),
  applyDefinition: z.boolean(),
  readOnly: z.boolean(),
  services: z.array(z.object({
    serviceName: z.string(), containerId: z.nullable(z.string()), status: z.string(),
    startedAt: z.nullable(z.string()), exitCode: z.nullable(z.number()), allowed: z.boolean()
  }))
});
export type HubRuntimeContext = z.infer<typeof hubRuntimeContextSchema>;

export const lifecycleWriteResultSchema = z.object({ ok: z.literal(true) });
