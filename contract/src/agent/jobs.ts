import * as z from "zod/mini";
import { stopIntentTargetSchema } from "./stop-intents.js";

export const AGENT_JOB_RESULT_RETENTION_MS = 24 * 60 * 60_000;
export const agentJobKindSchema = z.enum(["update", "restore"]);
export const agentJobScopeSchema = z.union([
  stopIntentTargetSchema,
  z.object({ kind: z.literal("stack"), projectName: z.string().check(z.minLength(1)) })
]);
export const agentJobRequestSchema = z.object({ jobId: z.string().check(z.minLength(1)) });
export const agentJobStartResponseSchema = z.strictObject(agentJobRequestSchema.shape);
export const agentJobCancelResponseSchema = z.object({ ...agentJobRequestSchema.shape, accepted: z.boolean() });
export const agentJobProgressFieldsSchema = z.object({
  ...agentJobRequestSchema.shape,
  phaseStartedAt: z.iso.datetime(), phaseDeadlineAt: z.iso.datetime(),
  completedAt: z.nullable(z.iso.datetime()), cancelAllowed: z.boolean()
});
export const agentJobsQuerySchema = z.object({
  target: z.optional(agentJobScopeSchema), kind: z.optional(agentJobKindSchema)
});

// Only completed jobs carry an end time and result; active jobs remain resumable by polling.
export function agentJobProgressIsConsistent(progress: {
  phase: string; completedAt: string | null; result: unknown; cancelAllowed: boolean
}): boolean {
  return progress.phase === "completed"
    ? progress.completedAt !== null && progress.result !== null && !progress.cancelAllowed
    : progress.completedAt === null && progress.result === null;
}
export type AgentJobKind = z.infer<typeof agentJobKindSchema>;
export type AgentJobScope = z.infer<typeof agentJobScopeSchema>;
export type AgentJobRequest = z.infer<typeof agentJobRequestSchema>;
export type AgentJobStartResponse = z.infer<typeof agentJobStartResponseSchema>;
export type AgentJobCancelResponse = z.infer<typeof agentJobCancelResponseSchema>;
export type AgentJobsQuery = z.infer<typeof agentJobsQuerySchema>;
