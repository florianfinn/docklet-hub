import * as z from "zod/mini";
import { updateProgressSchema } from "./updates.js";
import { restoreProgressSchema } from "./backups.js";

export const agentJobProgressSchema = z.discriminatedUnion("kind", [updateProgressSchema, restoreProgressSchema]);
export const agentJobResponseSchema = z.object({ progress: agentJobProgressSchema });
export const agentJobsResponseSchema = z.object({
  active: z.array(agentJobProgressSchema), recent: z.array(agentJobProgressSchema)
}).check(z.refine((jobs) => jobs.active.every((job) => job.phase !== "completed")
  && jobs.recent.every((job) => job.phase === "completed")
  && new Set([...jobs.active, ...jobs.recent].map((job) => job.jobId)).size === jobs.active.length + jobs.recent.length));
export type AgentJobProgress = z.infer<typeof agentJobProgressSchema>;
export type AgentJobResponse = z.infer<typeof agentJobResponseSchema>;
export type AgentJobsResponse = z.infer<typeof agentJobsResponseSchema>;
