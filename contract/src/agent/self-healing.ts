import * as z from "zod/mini";

export const SELF_HEALING_ACTOR = "system:hub";
export const SELF_HEALING_LIMITS = {
  attempts: { min: 1, max: 10 },
  retryDelaySeconds: { min: 1, max: 86_400 },
  stabilityWindowSeconds: { min: 1, max: 86_400 },
  maintenanceDurationSeconds: { min: 60, max: 604_800 }
} as const;

const integer = (limits: { min: number; max: number }) =>
  z.number().check(z.int(), z.minimum(limits.min), z.maximum(limits.max));

export const selfHealingConfigSchema = z.strictObject({
  enabled: z.boolean(),
  attempts: integer(SELF_HEALING_LIMITS.attempts),
  retryDelaysSeconds: z.array(integer(SELF_HEALING_LIMITS.retryDelaySeconds)).check(z.minLength(1), z.maxLength(10)),
  stabilityWindowSeconds: integer(SELF_HEALING_LIMITS.stabilityWindowSeconds),
  maintenanceDurationSeconds: z.nullable(integer(SELF_HEALING_LIMITS.maintenanceDurationSeconds))
}).check(z.refine((value) => value.retryDelaysSeconds.length === value.attempts, {
  path: ["retryDelaysSeconds"], message: "Expected one delay per attempt"
}));
export type SelfHealingConfig = z.infer<typeof selfHealingConfigSchema>;

export const DEFAULT_SELF_HEALING_CONFIG: SelfHealingConfig = {
  enabled: true,
  attempts: 3,
  retryDelaysSeconds: [10, 60, 300],
  stabilityWindowSeconds: 600,
  maintenanceDurationSeconds: 3600
};
export const selfHealingConfigResponseSchema = z.object({ config: selfHealingConfigSchema });
