import * as z from "zod/mini";

// Compose explicitly marks containers created for one-off runs. Restart policy alone is insufficient.
export const COMPOSE_ONE_OFF_LABEL = "com.docker.compose.oneoff";
export const runtimeActionSchema = z.enum(["start", "stop", "restart"]);
export type RuntimeAction = z.infer<typeof runtimeActionSchema>;

export const expectedContainerSchema = z.object({
  containerId: z.string(),
  status: z.string(),
  startedAt: z.nullable(z.string())
});
export type ExpectedContainer = z.infer<typeof expectedContainerSchema>;
export const containerActionRequestSchema = z.object({ expectedContainer: expectedContainerSchema });
export type ContainerActionRequest = z.input<typeof containerActionRequestSchema>;

export const runtimeStateSchema = z.object({
  containerId: z.nullable(z.string()),
  status: z.string(),
  exitCode: z.nullable(z.number()),
  health: z.nullable(z.string()),
  startedAt: z.nullable(z.string())
});
export type RuntimeState = z.infer<typeof runtimeStateSchema>;

export const runtimeServiceResultSchema = z.object({
  serviceName: z.string(),
  ...runtimeStateSchema.shape,
  outcome: z.enum(["ok", "failed", "not-created-externally-managed"])
});
export type RuntimeServiceResult = z.infer<typeof runtimeServiceResultSchema>;
export const runtimeOutcomeSchema = z.enum(["ok", "partial", "failed"]);
export type RuntimeOutcome = z.infer<typeof runtimeOutcomeSchema>;

export const RUNTIME_ACTION_ERRORS = [
  "state-changed", "action-queue-timeout", "action-caller-disconnected",
  "runtime-deadline-exceeded", "runtime-image-missing", "runtime-state-unreadable", "runtime-target-not-reached",
  "compose-config-failed", "compose-services-missing", "compose-stack-action-failed",
  "engine-action-failed", "compose-action-failed", "internal-error", "registry-reanchor-failed", "container-anchor-mismatch"
] as const;
export const runtimeActionErrorSchema = z.enum(RUNTIME_ACTION_ERRORS);
export type RuntimeActionError = z.infer<typeof runtimeActionErrorSchema>;

export const stackRuntimeResultSchema = z.object({
  ok: z.boolean(),
  action: runtimeActionSchema,
  applyDefinition: z.boolean(),
  outcome: runtimeOutcomeSchema,
  services: z.array(runtimeServiceResultSchema),
  containerIds: z.record(z.string(), z.string()),
  error: z.optional(z.string())
});
export type StackRuntimeResult = z.infer<typeof stackRuntimeResultSchema>;

export const containerRuntimeResultSchema = z.object({
  ok: z.boolean(),
  action: runtimeActionSchema,
  outcome: runtimeOutcomeSchema,
  state: runtimeStateSchema,
  error: z.optional(z.string())
});
export type ContainerRuntimeResult = z.infer<typeof containerRuntimeResultSchema>;

export const stackActionStreamLineSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("queued") }),
  z.object({ kind: z.literal("start"), action: runtimeActionSchema, projectName: z.string(), applyDefinition: z.boolean() }),
  z.object({ kind: z.literal("progress"), service: runtimeServiceResultSchema }),
  z.object({ kind: z.literal("result"), status: z.number(), body: stackRuntimeResultSchema }),
  z.object({ kind: z.literal("error"), reason: z.string(), status: z.optional(z.number()),
    body: z.optional(z.record(z.string(), z.unknown())) })
]);
export type StackActionStreamLine = z.infer<typeof stackActionStreamLineSchema>;
