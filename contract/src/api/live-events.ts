import * as z from "zod/mini";

export const liveStatusSchema = z.enum(["connecting", "connected", "disconnected"]);
export type LiveStatus = z.infer<typeof liveStatusSchema>;
export const liveActionSchema = z.enum(["start", "stop", "restart", "recreate", "die", "health", "refresh"]);
export type LiveAction = z.infer<typeof liveActionSchema>;

/** Invalidation hints contain no raw Docker attributes or agent credentials. */
export const liveEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), hosts: z.array(z.object({ hostId: z.string(), status: liveStatusSchema })) }),
  z.object({ kind: z.literal("status"), hostId: z.string(), status: liveStatusSchema }),
  z.object({ kind: z.literal("changed"), hostId: z.string(), containerIds: z.array(z.string()), action: liveActionSchema }),
  z.object({ kind: z.literal("removed"), hostId: z.string() }),
  z.object({ kind: z.literal("heartbeat") }),
  z.object({ kind: z.literal("session-expired") })
]);
export type LiveEvent = z.infer<typeof liveEventSchema>;
