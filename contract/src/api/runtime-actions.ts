import * as z from "zod/mini";
import { expectedStackSchema } from "../agent/compose-requests.js";
import { COMPOSE_RAW_GATE_FAILURE_REASONS } from "../agent/compose-reasons.js";
import { SHARED_HTTP_ERRORS } from "../agent/reasons.js";
import { containerRuntimeResultSchema, expectedContainerSchema, RUNTIME_ACTION_ERRORS,
  runtimeActionSchema, runtimeServiceResultSchema, stackRuntimeResultSchema } from "../agent/runtime-actions.js";

// Only stable keys cross the hub boundary; free agent diagnostics stay on the host.
export const HUB_RUNTIME_ERRORS = [
  ...RUNTIME_ACTION_ERRORS, ...COMPOSE_RAW_GATE_FAILURE_REASONS,
  ...SHARED_HTTP_ERRORS.map((entry) => entry.code),
  "scaled-service-unsupported", "ambiguous-registry-service", "stack-service-gate-denied", "container-gone",
  "compose-project-name-missing", "invalid-compose-project-name", "compose-anchor-missing",
  "compose-project-name-collision", "hardening-violated",
  "runtime-host-offline", "runtime-agent-unreachable", "runtime-outcome-unknown", "runtime-agent-failed",
  "runtime-invalid-response", "runtime-stream-broken", "invalid-input", "host-unknown",
  "container-unknown", "agent-outdated", "forbidden-origin", "admin-required", "unauthenticated"
] as const;
export const hubRuntimeErrorSchema = z.enum(HUB_RUNTIME_ERRORS);
export type HubRuntimeError = z.infer<typeof hubRuntimeErrorSchema>;
export const hubRuntimeFailureSchema = z.object({ error: hubRuntimeErrorSchema });
export const hubContainerActionRequestSchema = z.object({ expectedContainer: expectedContainerSchema });
export const hubStackActionRequestSchema = z.object({ expectedStack: expectedStackSchema });
export const hubContainerRuntimeResultSchema = z.object({
  ...containerRuntimeResultSchema.shape, error: z.optional(hubRuntimeErrorSchema)
});
export const hubStackRuntimeResultSchema = z.object({
  ...stackRuntimeResultSchema.shape, error: z.optional(hubRuntimeErrorSchema)
});
export type HubContainerRuntimeResult = z.infer<typeof hubContainerRuntimeResultSchema>;
export type HubStackRuntimeResult = z.infer<typeof hubStackRuntimeResultSchema>;
export const hubStackActionStreamLineSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("queued") }),
  z.object({ kind: z.literal("start"), action: runtimeActionSchema, projectName: z.string(), applyDefinition: z.boolean() }),
  z.object({ kind: z.literal("progress"), service: runtimeServiceResultSchema }),
  z.object({ kind: z.literal("result"), status: z.number(), body: hubStackRuntimeResultSchema }),
  z.object({ kind: z.literal("error"), reason: hubRuntimeErrorSchema, status: z.optional(z.number()),
    body: z.optional(z.union([hubStackRuntimeResultSchema, hubRuntimeFailureSchema])) })
]);
export type HubStackActionStreamLine = z.infer<typeof hubStackActionStreamLineSchema>;
