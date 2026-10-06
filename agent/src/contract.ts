import {
  SELF_HEALING_LIMITS,
  selfHealingConfigSchema,
  ACTOR_HEADER,
  stackActionStreamLineSchema,
  RUNTIME_ACTION_ERRORS,
  COMPOSE_RAW_FAILURE_REASONS,
  composeApplyStreamLineSchema,
  CONTRACT_VERSION,
  execStreamLineSchema,
  LOG_FILE_FAILURE_REASONS,
  logFileStreamLineSchema,
  LOGS_STREAM_FAILURE_REASONS,
  logsStreamLineSchema,
  PULL_STREAM_FAILURE_REASONS,
  pullStreamLineSchema,
  registryComposeSchema,
  registryEntrySchema,
  registryOriginSchema,
  SECRET_HEADER,
  SHARED_HTTP_ERRORS
} from "contract";

import { ROUTES } from "./route-policy.js";

// What `GET /contract` reports. Since #272 every value here comes from the
// shared schemas in `contract/src/agent/`; this file only arranges them in
// the form the route has had since v0.28.0.

export { CONTRACT_VERSION };

// "required" or "optional", read off the schema of today's entry of
// `PUT /registry`, so that the report cannot disagree with the check.
function fieldPresence<Shape extends Record<string, { _zod: { optin?: string } }>>(
  shape: Shape
): { [Key in keyof Shape]: "required" | "optional" } {
  return Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [key, schema._zod.optin === "optional" ? "optional" : "required"])
  ) as { [Key in keyof Shape]: "required" | "optional" };
}

export const CONTRACT_HEADERS = {
  secret: SECRET_HEADER,
  actor: ACTOR_HEADER
} as const;

// The `kind` values a stream schema allows, in its order.
type KindOption = { _zod: { def: { shape: { kind: { _zod: { def: { values: readonly unknown[] } } } } } } };

function kindsOf(schema: { _zod: { def: { options: readonly unknown[] } } }): string[] {
  return schema._zod.def.options.map((option) => String((option as KindOption)._zod.def.shape.kind._zod.def.values[0]));
}

// A stream kind is only promised for the route named. In particular, "output"/"end"
// belong to the exec session and "step" to the raw editor, not to the log.
const NDJSON_KINDS = {
  logsStream: kindsOf(logsStreamLineSchema),
  logFile: kindsOf(logFileStreamLineSchema),
  pullStream: kindsOf(pullStreamLineSchema),
  composeRawStream: kindsOf(composeApplyStreamLineSchema),
  exec: kindsOf(execStreamLineSchema),
  stackActions: kindsOf(stackActionStreamLineSchema)
};

export const AGENT_CONTRACT = {
  contractVersion: CONTRACT_VERSION,
  headers: CONTRACT_HEADERS,
  routes: ROUTES.map((route) => ({ ...route })),
  registry: {
    entryFields: fieldPresence(registryEntrySchema.shape),
    composeFields: fieldPresence(registryComposeSchema.shape),
    composeOrigins: registryOriginSchema.options
  },
  selfHealing: { fields: fieldPresence(selfHealingConfigSchema.shape), limits: SELF_HEALING_LIMITS },
  ndjsonKinds: NDJSON_KINDS,
  errors: {
    sharedHttp: SHARED_HTTP_ERRORS,
    runtimeActions: RUNTIME_ACTION_ERRORS,
    logsStream: LOGS_STREAM_FAILURE_REASONS,
    logFile: LOG_FILE_FAILURE_REASONS,
    pullStream: PULL_STREAM_FAILURE_REASONS,
    composeRaw: [...new Set(COMPOSE_RAW_FAILURE_REASONS)]
  }
} as const;
