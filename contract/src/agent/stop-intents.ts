import * as z from "zod/mini";

export const stopIntentTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("compose"), projectName: z.string().check(z.minLength(1)), serviceName: z.string().check(z.minLength(1)) }),
  z.object({ kind: z.literal("container"), containerName: z.string().check(z.minLength(1)) })
]);
export type StopIntentTarget = z.infer<typeof stopIntentTargetSchema>;

export const stopIntentSchema = z.object({
  target: stopIntentTargetSchema,
  containerId: z.string().check(z.minLength(1)),
  stoppedAt: z.iso.datetime(),
  actor: z.nullable(z.string())
});
export type StopIntent = z.infer<typeof stopIntentSchema>;

export const containerExitSchema = z.object({
  target: stopIntentTargetSchema,
  containerId: z.string().check(z.minLength(1)),
  occurredAt: z.iso.datetime(),
  kind: z.enum(["manual-stop", "unexpected"])
});
export type ContainerExit = z.infer<typeof containerExitSchema>;

/** GET /stop-intents; recent exits are bounded and kept only in memory. */
export const stopIntentsResponseSchema = z.object({
  observing: z.boolean(),
  intents: z.array(stopIntentSchema),
  recentExits: z.array(containerExitSchema)
});
export type StopIntentsResponse = z.infer<typeof stopIntentsResponseSchema>;
