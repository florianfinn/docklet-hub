// Structured container data model (stage plan section 4, primary path;
// stage 5b).
//
// The core of the decision from section 4: containers do NOT come from free
// YAML but from validated fields. That leaves no path traversal, no sock mount
// and no privileged attack surface that would have to be caught again later
// via a blacklist — the attack surface does not arise in the first place,
// because there is no field for it.
//
// The hardening properties are therefore NOT configurable here but fixed:
// cap_drop ALL, no-new-privileges, no privileged, no devices, no host
// namespaces. This reverses the classes from stage 4: what could only be
// "advisory" for the existing setup (otherwise it would have become
// unmanageable) is binding for everything the dashboard creates itself.
//
// Pure, no imports apart from the hardening types and the shared schema
// (contract) — fully testable without Docker.

import {
  CONTAINER_NAME_PATTERN,
  containerSpecSchema,
  type SpecPort,
  type SpecVolume
} from "contract";

import { normalizePath, selfCheckViolations, type InspectedContainer } from "./hardening.js";

// Preset log rotation (S9/K4b, §21.6). Docker's default for json-file is NO
// rotation; without these values every newly created container would come into
// being with exactly the finding `logging-unbounded` reports. They live here
// and not in compose.ts, so that the self-check below uses the same source as
// the emitter — a second copy would be exactly the kind of deviation
// hardeningOfSpec is meant to uncover.
export const LOG_MAX_SIZE = "10m";
export const LOG_MAX_FILE = "3";

export type { SpecPort, SpecVolume };

export type ContainerSpec = {
  name: string;
  imageRef: string;
  env: Array<{ key: string; value: string }>;
  ports: SpecPort[];
  volumes: SpecVolume[];
  networks: string[];
  restartPolicy: "no" | "always" | "unless-stopped" | "on-failure";
  resources: SpecResources;
};

/**
 * The three operational limits. `null` EXPLICITLY means "no limit" — not
 * "unknown" and not "use the default".
 *
 * Until here they were required, with a preset of 512 MB / 1 CPU / 256 PIDs
 * in the form. That read like a recommendation but was a claim about a service
 * nobody knew: 512 MB breaks every database and every game server, 1 CPU turns
 * a build into an hour. Whoever does not know the number should not have to
 * guess it — Docker without a limit is a more honest starting point than an
 * invented number.
 *
 * ⚠️ Leaving it out stays VISIBLE: `resource-limit-missing` keeps reporting
 * the container as a hint (hardening.ts). It is deliberately not a violation
 * — a missing limit is an availability risk, not an escape risk, and that is
 * exactly why the rule is not in SELF_CHECK_RULES and does not block
 * creation.
 */
export type SpecResources = {
  memoryMb: number | null;
  cpus: number | null;
  pidsLimit: number | null;
};

export type SpecError = { field: string; message: string };

export type ValidateOptions = {
  // Allowlist for bind mounts. If it is missing, bind mounts are forbidden
  // entirely — fail closed: without a base path there is no allowed range,
  // hence no allowed bind either.
  bindBasePath?: string;
  // "Protected" class (stage 5e, section 6.2): are bind sources additionally
  // restricted to the own universe /home/docker/<name>? The universe path
  // follows from the name of the spec (bindBasePath/name) — it is deliberately
  // NOT passed in, so that there is no way here to pass off a foreign
  // directory as the "own" one.
  secured?: boolean;
};

export type SpecCheck = { ok: true; spec: ContainerSpec } | { ok: false; errors: SpecError[] };

// "volumes[0].source" from ["volumes", 0, "source"]: the form the form fields
// of the web use to mark a field.
function fieldOf(path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (field, key) => (typeof key === "number" ? `${field}[${key}]` : field ? `${field}.${String(key)}` : String(key)),
    ""
  );
}

// Since #272 the shape of a spec is `containerSpecSchema` (contract), shared
// with the hub. What stays here is what depends on the agent's configuration:
// the bind base path and the universe of the class "secured".
export function checkSpec(input: unknown, options: ValidateOptions = {}): SpecCheck {
  // A missing spec reads as an empty one, so that every missing field is
  // named and not only "the spec".
  const candidate = typeof input === "object" && input !== null ? input : {};
  const parsed = containerSpecSchema.safeParse(candidate);
  const errors: SpecError[] = parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({ field: fieldOf(issue.path), message: issue.message }));

  const raw = candidate as { name?: unknown; volumes?: unknown };
  const volumes = Array.isArray(raw.volumes) ? (raw.volumes as unknown[]) : [];
  for (const [index, entry] of volumes.entries()) {
    const volume = (entry ?? {}) as Record<string, unknown>;
    if (volume.type !== "bind" || typeof volume.source !== "string" || !volume.source.startsWith("/")) continue;
    const field = `volumes[${index}].source`;
    // Bind: the allowlist from 3.8, here already at creation instead of only
    // in the hardening check — so that the error message says what is wrong.
    if (!options.bindBasePath) {
      errors.push({ field, message: "bind mounts are not configured (no base path set)" });
    } else if (!isInsideBase(volume.source, options.bindBasePath)) {
      errors.push({
        field,
        message:
          `bind source must lie in a subdirectory of a container directory ` +
          `(${options.bindBasePath}/<name>/<...>, e.g. ${options.bindBasePath}/myname/data). ` +
          `The container directory itself cannot be mounted — it holds the ` +
          `compose.yaml, i.e. the definition of the container.`
      });
    } else if (
      // Protected class (stage 5e): additionally restricted to its OWN
      // universe. The path lies within the base path, but in a neighbour's
      // directory — for a protected container that is the escape the class
      // rules out. The universe follows from the name of the spec, never from
      // a value in the request.
      options.secured &&
      typeof raw.name === "string" &&
      CONTAINER_NAME_PATTERN.test(raw.name) &&
      !isInsideUniverse(volume.source, `${options.bindBasePath}/${raw.name}`)
    ) {
      errors.push({
        field,
        message:
          `Protected container: bind sources are restricted to its own directory ` +
          `${options.bindBasePath}/${raw.name}/<...> (e.g. ` +
          `${options.bindBasePath}/${raw.name}/data). Mounting a neighbouring directory ` +
          `is not possible in this class — set the class to "normal" for that.`
      });
    }
  }

  if (!parsed.success || errors.length > 0) return { ok: false, errors };
  // Only the known fields, with "no limit" as `null` (normalizeSpec).
  return { ok: true, spec: normalizeSpec(parsed.data as ContainerSpec) };
}

export function validateSpec(input: unknown, options: ValidateOptions = {}): SpecError[] {
  const checked = checkSpec(input, options);
  return checked.ok ? [] : checked.errors;
}

// Bring a limit from foreign hands into its canonical form: a number stays a
// number, everything else becomes `null`. After checkSpec only these two can
// arrive here — the function stays anyway, because normalizeSpec also runs on
// the way back from a compose file, and that has never seen a validation.
function limit(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Congruent with isInsideBasePath in hardening.ts — deliberately the same rule
// in two places: here as input validation with a usable error message, there
// as a continuous check against the running container. A container can also
// get a mount by another route (Dockge, manual work), and then only the second
// one applies.
//
// The second level ("at least <project>/<something>") is the lesson from the
// security review of 5c: the directory that holds the compose.yaml must not be
// mountable by the container it defines.
function isInsideBase(source: string, basePath: string): boolean {
  const normalized = normalizePath(source);
  const base = normalizePath(basePath);
  if (normalized === base || !normalized.startsWith(base + "/")) return false;
  return normalized.slice(base.length + 1).includes("/");
}

// Congruent with isInsideUniverse in hardening.ts (stage 5e): strictly below
// the own directory. The directory itself is excluded — the compose.yaml lives
// there.
function isInsideUniverse(source: string, universe: string): boolean {
  const normalized = normalizePath(source);
  const base = normalizePath(universe);
  return normalized !== base && normalized.startsWith(base + "/");
}

// Reduces a spec to the known fields.
//
// Found live 2026-07-20: the API stored the RAW request body as the spec.
// Unknown fields (in the test `privileged`, `capAdd`, `devices`) were thereby
// kept and returned by `GET /spec` — it looked as if the container had these
// rights, although the payload never contained them.
//
// Two reasons to clean that up: it is misleading, and it is a dormant
// escalation. As soon as a later version evaluates another field, stored
// values would suddenly take effect without ever having passed a validation.
export function normalizeSpec(spec: ContainerSpec): ContainerSpec {
  return {
    name: spec.name,
    imageRef: spec.imageRef,
    env: spec.env.map((entry) => ({ key: entry.key, value: entry.value })),
    ports: spec.ports.map((port) => ({
      containerPort: port.containerPort,
      hostPort: port.hostPort,
      protocol: port.protocol,
      hostIp: port.hostIp
    })),
    volumes: spec.volumes.map((volume) => ({
      type: volume.type,
      source: volume.source,
      target: volume.target,
      readOnly: volume.readOnly
    })) as SpecVolume[],
    networks: [...spec.networks],
    restartPolicy: spec.restartPolicy,
    resources: {
      memoryMb: limit(spec.resources?.memoryMb),
      cpus: limit(spec.resources?.cpus),
      pidsLimit: limit(spec.resources?.pidsLimit)
    }
  };
}

// Self-check: what we are about to create must pass our OWN hardening rules.
//
// Strictly speaking redundant — the generated compose file (compose.ts,
// emitComposeYaml) sets the values itself. That is exactly why the check is
// here: as soon as someone later adds a field that violates a hardening rule,
// it shows up here and not only in operation. The rules and their application
// thus stay one source instead of two.
//
// Stage 5c: the engine payload (buildSpecPayload) has gone, because containers
// are no longer created via a create call but via `docker compose up`. This
// self-check stays valid unchanged — it describes the spec, not the route by
// which it is executed.
export function hardeningOfSpec(spec: ContainerSpec): InspectedContainer {
  return {
    id: "",
    name: spec.name,
    image: spec.imageRef,
    privileged: false,
    capAdd: [],
    capDrop: ["ALL"],
    securityOpt: ["no-new-privileges:true"],
    pidMode: "",
    ipcMode: "",
    networkMode: spec.networks[0] ?? "bridge",
    binds: spec.volumes.map(
      (volume) => `${volume.source}:${volume.target}${volume.readOnly ? ":ro" : ""}`
    ),
    devices: [],
    // Without a limit exactly what `inspect` returns for a container without a
    // limit: 0 bytes, `null` PIDs, no CPU binding. That way the self-check
    // sees the same state as the continuous check later on the running
    // container — and `resource-limit-missing` reports it here as there, as a
    // hint.
    memoryLimitBytes: spec.resources.memoryMb === null ? 0 : Math.round(spec.resources.memoryMb * 1024 * 1024),
    pidsLimit: spec.resources.pidsLimit === null ? null : Math.round(spec.resources.pidsLimit),
    cpuLimited: spec.resources.cpus !== null && spec.resources.cpus > 0,
    // Word for word what emitComposeYaml writes (K4b).
    logDriver: "json-file",
    logOptions: { "max-size": LOG_MAX_SIZE, "max-file": LOG_MAX_FILE }
  };
}

// ⚠️ S9: the measure is `selfCheckViolations` (SELF_CHECK_RULES in
// hardening.ts), not the operational rule. The relaxation from §4 applies to
// the EXISTING SETUP — a container the dashboard is only just creating from a
// form has no reason to start with a socket mount or a host namespace. The
// bind allowlist is moreover preceded by the validation in validateSpec; that
// `bind-outside-base` is only a hint here therefore opens no gap, it only
// shifts which message the user sees.
export function specViolatesHardening(
  spec: ContainerSpec,
  bindBasePath?: string,
  secured = false
): string[] {
  // For a protected container the self-check checks against its own universe
  // (bindBasePath/<name>), otherwise only against the global base path.
  const secureUniverse =
    secured && bindBasePath && CONTAINER_NAME_PATTERN.test(spec.name)
      ? `${bindBasePath}/${spec.name}`
      : undefined;
  return selfCheckViolations(hardeningOfSpec(spec), { bindBasePath, secureUniverse }).map(
    (violation) => violation.rule
  );
}
