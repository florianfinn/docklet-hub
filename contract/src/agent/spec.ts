import * as z from "zod/mini";

// The definition of a container the agent creates or rewrites (stage 5c):
// `POST /containers` and `POST /containers/:id/apply-spec` carry it as `spec`.
//
// ⚠️ THE SCHEMA CHECKS EVERY FIELD THAT NEEDS NO HOST. Whether a bind source
// lies below the agent's base path, or below the container's own directory
// for the class "secured", depends on the agent's configuration and stays in
// `validateSpec` (`agent/src/spec.ts`), which runs this schema first.
//
// ⚠️ THE MESSAGES ARE THE AGENT'S ANSWER TEXTS, NOT KEYS. The agent answers
// `400 invalid-spec` with every failing field and its message at once, so
// that a form can mark them all; the messages name the rule, never the value.
//
// Unknown fields are stripped (`z.object`): the request once carried
// `privileged`, `capAdd` and `devices`, for which the model deliberately has
// no field. A field nobody checked must not take effect later.

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,62}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const NETWORK_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const VOLUME_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;

const MEMORY_MIN_MB = 16;
const MEMORY_MAX_MB = 64 * 1024;
const CPUS_MIN = 0.1;
const CPUS_MAX = 32;
const PIDS_MIN = 16;
const PIDS_MAX = 16384;

/** The name of a container, which is also its directory and compose project. */
export const CONTAINER_NAME_PATTERN = NAME_PATTERN;

export function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const portNumber = (message: string) =>
  z.int({ error: message }).check(z.minimum(1, { error: message }), z.maximum(65535, { error: message }));

export const specPortSchema = z.object({
  containerPort: portNumber("port must be 1-65535"),
  hostPort: portNumber("port must be 1-65535"),
  protocol: z.enum(["tcp", "udp"], { error: "protocol must be tcp or udp" }),
  // The default is deliberately 127.0.0.1 and not 0.0.0.0: services should be
  // reachable via the Docker network (Traefik), not via all host interfaces.
  // Dockge's own 0.0.0.0:5001 is documented in the stage plan as the weakest
  // point of the chain — this default is the lesson from it. A different value
  // is possible, but a deliberate choice.
  hostIp: z.string({ error: "hostIp must be an IPv4 address" }).check(
    z.regex(IPV4_PATTERN, { error: "hostIp must be an IPv4 address" })
  )
});
export type SpecPort = z.infer<typeof specPortSchema>;

export type SpecVolume =
  | { type: "named"; source: string; target: string; readOnly: boolean }
  | { type: "bind"; source: string; target: string; readOnly: boolean };

/**
 * One volume. Its rules depend on `type`, and a volume of an unknown type gets
 * exactly one finding, on the volume itself: its other fields mean nothing yet.
 *
 * ⚠️ Colons are not cosmetic: a bind is assembled as `source:target:mode`, and
 * a colon in either shifts the field boundaries. Control characters are
 * refused for the same reason as in env values: a line break in a path yields
 * a multi-line scalar in the generated compose file.
 */
export const specVolumeSchema = z.pipe(
  z.unknown().check(
    z.superRefine((value, context) => {
      const volume = (value ?? {}) as Record<string, unknown>;
      const issue = (message: string, path: PropertyKey[]) =>
        context.issues.push({ code: "custom", message, input: value, path });
      if (typeof value !== "object" || value === null || (volume.type !== "named" && volume.type !== "bind")) {
        issue("type must be named or bind", []);
        return;
      }
      const target = volume.target;
      if (
        typeof target !== "string" ||
        !target.startsWith("/") ||
        target.includes("..") ||
        target.includes(":") ||
        hasControlCharacter(target)
      ) {
        issue("target must be an absolute path without .., without : and without control characters", ["target"]);
      }
      const source = volume.source;
      if (typeof source === "string" && (source.includes(":") || hasControlCharacter(source))) {
        issue("source must not contain : or control characters", ["source"]);
      }
      if (volume.type === "named") {
        if (typeof source !== "string" || !VOLUME_NAME_PATTERN.test(source)) issue("volume name is invalid", ["source"]);
        return;
      }
      if (typeof source !== "string" || !source.startsWith("/")) {
        issue("bind source must be an absolute path", ["source"]);
      }
      if (volume.readOnly !== undefined && typeof volume.readOnly !== "boolean") {
        issue("readOnly must be true or false", ["readOnly"]);
      }
    })
  ),
  z.transform((value) => value as SpecVolume)
);

/**
 * An operational limit. `null` or a missing key EXPLICITLY means "no limit";
 * a given limit must be in range. `0`, `""` or `"unlimited"` is a typo, not
 * an intention.
 */
const limit = (min: number, max: number, message: string) =>
  z.optional(
    z.nullable(
      z.number({ error: message }).check(
        z.refine(Number.isFinite, { error: message }),
        z.minimum(min, { error: message }),
        z.maximum(max, { error: message })
      )
    )
  );

export const specResourcesSchema = z.object({
  memoryMb: limit(MEMORY_MIN_MB, MEMORY_MAX_MB, `memory limit must be ${MEMORY_MIN_MB}-${MEMORY_MAX_MB} MB or left empty`),
  cpus: limit(CPUS_MIN, CPUS_MAX, `CPU limit must be ${CPUS_MIN}-${CPUS_MAX} or left empty`),
  pidsLimit: limit(PIDS_MIN, PIDS_MAX, `PIDs limit must be ${PIDS_MIN}-${PIDS_MAX} or left empty`)
});

export const restartPolicySchema = z.enum(["no", "always", "unless-stopped", "on-failure"], {
  error: "restartPolicy must be no, always, unless-stopped or on-failure"
});

export const containerSpecSchema = z.object({
  name: z.string({ error: "name must have 2-63 characters: letters, digits, _ . -" }).check(
    z.regex(NAME_PATTERN, { error: "name must have 2-63 characters: letters, digits, _ . -" })
  ),
  imageRef: z.string({ error: "image ref is required" }).check(
    z.refine((value) => value.trim().length > 0, { error: "image ref is required" })
  ),
  env: z._default(
    z.array(
      z.object({
        key: z.string({ error: "env name is invalid" }).check(z.regex(ENV_KEY_PATTERN, { error: "env name is invalid" })),
        value: z
          .string({ error: "env value missing, too long or contains control characters" })
          .check(
            z.maxLength(4096, { error: "env value missing, too long or contains control characters" }),
            z.refine((value) => !hasControlCharacter(value), {
              error: "env value missing, too long or contains control characters"
            })
          )
      })
    ),
    []
  ),
  ports: z._default(z.array(specPortSchema), []),
  volumes: z._default(z.array(specVolumeSchema), []),
  networks: z._default(
    z.array(z.string({ error: "network name is invalid" }).check(z.regex(NETWORK_PATTERN, { error: "network name is invalid" }))),
    []
  ),
  restartPolicy: restartPolicySchema,
  resources: z._default(specResourcesSchema, { memoryMb: null, cpus: null, pidsLimit: null })
});
export type ContainerSpecInput = z.input<typeof containerSpecSchema>;
