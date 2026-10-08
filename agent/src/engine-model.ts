import type { InspectedContainer } from "./hardening.js";
import type { ParsedImageRef } from "./image-ref.js";

export type EngineRegistryAuth = {
  username: string;
  password: string;
  serverAddress: string;
};

export function registryAuthHeader(auth: EngineRegistryAuth): string {
  const encoded = Buffer.from(JSON.stringify({
    username: auth.username,
    password: auth.password,
    serveraddress: auth.serverAddress
  }), "utf8").toString("base64");
  // Docker documents the value as base64url, but decodes it with the padded Go
  // variant. Node's `base64url` strips the trailing `=`, whereupon the daemon
  // silently discards the credentials and asks the registry anonymously. So
  // URL-safe characters are converted explicitly, but the padding is kept.
  return encoded.replaceAll("+", "-").replaceAll("/", "_");
}

// The query parameters for /images/create. Pulled out as a pure function
// because exactly here was the bug that let a pull without a tag stored in the
// ref run over EVERY tag of the repo: without a `tag` parameter the engine API
// does NOT pull ":latest" (unlike the `docker` CLI), but everything.
// `parsed.tag` is null exactly when the ref names neither tag nor digest
// (image-ref.ts) — and only then does ":latest" have to be added here; with a
// digest ref the reference is already complete in `fromImage`, an additional
// tag parameter would be out of place there.
export function pullQueryParams(parsed: ParsedImageRef): Record<string, string> {
  if (parsed.tag) return { fromImage: parsed.fromImage, tag: parsed.tag };
  if (parsed.digest) return { fromImage: parsed.fromImage };
  return { fromImage: parsed.fromImage, tag: "latest" };
}

// For /images/create the engine streams JSON objects, one per line. An error
// appears in it as {"error": "..."} with HTTP 200 already sent.
// Returns the error message, or null if the stream was clean.
export function findStreamError(body: string): string | null {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown; errorDetail?: { message?: unknown } };
      const message = parsed.errorDetail?.message ?? parsed.error;
      if (typeof message === "string" && message) return message;
    } catch {
      // An unparseable line is no evidence of an error — the stream
      // occasionally ends with a fragment.
      continue;
    }
  }
  return null;
}

// A line of the pull stream, reduced to what a display needs.
//
// ⚠️ Deliberately a SELECTION instead of a pass-through: what goes out here
// ends up in the browser via the main API. Passing on the raw object would be
// the kind of channel through which a field nobody checked rides along later.
// The three fields are layer id, state and byte progress — none of them names
// host paths or env values.
export type PullProgress = {
  status: string;
  // The short layer id ("a1b2c3d4"), or the tag for the first/last record.
  id: string | null;
  // The engine's progress line ("[====>   ]  12.4MB/40.1MB").
  progress: string | null;
};

export function parsePullProgress(line: string): PullProgress | null {
  let parsed: { status?: unknown; id?: unknown; progress?: unknown };
  try {
    parsed = JSON.parse(line) as typeof parsed;
  } catch {
    return null;
  }
  if (typeof parsed.status !== "string" || !parsed.status) return null;
  return {
    // Capped: the value comes from the registry, not from us.
    status: parsed.status.slice(0, 200),
    id: typeof parsed.id === "string" && parsed.id ? parsed.id.slice(0, 80) : null,
    progress:
      typeof parsed.progress === "string" && parsed.progress ? parsed.progress.slice(0, 120) : null
  };
}

// Only the fields the CPU/RAM calculation (stats.ts) actually needs.
export type RawStats = {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: { cache?: number; inactive_file?: number };
  };
};

export type EngineInfo = {
  NCPU?: number;
  MemTotal?: number;
};

export type DockerMonitorEvent = {
  action: "die" | "start" | "stop" | "restart" | "create" | "destroy" | "health_status" | "oom" | "kill";
  atMs?: number;
  signal?: string;
  exitCode?: number;
  composeProject?: string;
  composeService?: string;
  containerId: string;
  // Metadata stays local; monitor responses expose only action and ID.
  containerName?: string;
};

// Keep container lifecycle evidence only; other Docker event types stay out.
export function monitorEventOf(value: unknown): DockerMonitorEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as {
    Type?: unknown;
    Action?: unknown;
    id?: unknown;
    time?: unknown;
    timeNano?: unknown;
    Actor?: { ID?: unknown; Attributes?: Record<string, unknown> };
  };
  if (raw.Type !== "container") return null;
  const containerId = typeof raw.Actor?.ID === "string" ? raw.Actor.ID : typeof raw.id === "string" ? raw.id : null;
  if (!containerId || !/^[a-f0-9]{12,64}$/i.test(containerId)) return null;
  const containerName =
    typeof raw.Actor?.Attributes?.name === "string" && raw.Actor.Attributes.name.trim()
      ? raw.Actor.Attributes.name.trim().replace(/^\/+/, "")
      : undefined;
  const nanos = typeof raw.timeNano === "number" ? raw.timeNano / 1_000_000 : undefined;
  const millis = nanos ?? (typeof raw.time === "number" ? raw.time * 1_000 : undefined);
  const project = raw.Actor?.Attributes?.["com.docker.compose.project"];
  const service = raw.Actor?.Attributes?.["com.docker.compose.service"];
  const exitValue = raw.Actor?.Attributes?.exitCode;
  const exitCode = typeof exitValue === "string" && /^-?\d+$/.test(exitValue) ? Number(exitValue) : undefined;
  const metadata = {
    ...(exitCode !== undefined && Number.isSafeInteger(exitCode) ? { exitCode } : {}),
    ...(containerName ? { containerName } : {}),
    ...(millis !== undefined && Number.isFinite(millis) ? { atMs: millis } : {}),
    ...(typeof project === "string" && project ? { composeProject: project } : {}),
    ...(typeof service === "string" && service ? { composeService: service } : {})
  };
  const signal = raw.Actor?.Attributes?.signal;
  const action = raw.Action;
  if (action === "die" || action === "start" || action === "stop" || action === "restart" || action === "create" || action === "destroy" || action === "oom" || action === "kill") {
    return { action, containerId, ...metadata,
      ...(action === "kill" && typeof signal === "string" ? { signal } : {}) };
  }
  if (typeof action === "string" && action.startsWith("health_status:")) {
    return { action: "health_status", containerId, ...(containerName ? { containerName } : {}) };
  }
  return null;
}

// Only the fields the agent actually evaluates.
export type RawInspect = {
  Id: string;
  Name: string;
  Config?: {
    Image?: string;
    StopTimeout?: number | null;
    StopSignal?: string;
    Env?: string[] | null;
    Labels?: Record<string, string> | null;
    // For the derived configuration information (S5b, §16.3): the container
    // side of the ports is here even for a STOPPED container, while
    // NetworkSettings.Ports is empty then.
    ExposedPorts?: Record<string, unknown> | null;
    // Only WHETHER a healthcheck is defined — the command itself would be
    // information about the container's makeup and stays out.
    Healthcheck?: { Test?: string[] | null } | null;
    // Whether the container runs with a pseudo terminal (S6, §12.4): with a
    // TTY Docker does NOT multiplex stdout/stderr into the log stream — the
    // demuxer has to know that, otherwise it takes a random byte for a stream
    // id.
    Tty?: boolean;
  };
  Image?: string;
  RestartCount?: number;
  State?: {
    Status?: string;
    Running?: boolean;
    // Stage 5c: a container can be "Running" and still be restarting in a
    // loop — the state changes constantly. Without this field a restart loop
    // looks like a successful start.
    Restarting?: boolean;
    Paused?: boolean;
    ExitCode?: number;
    Error?: string;
    StartedAt?: string;
    Health?: { Status?: string };
  };
  // The RESOLVED mount list — what the container actually sees. It is the
  // authoritative source for the bind rules of the hardening, because
  // HostConfig.Binds only reflects one of three notations (see
  // bindSourcesOf).
  // `Name` and `Driver` are part of it since the hardening also resolves named
  // volumes (security review stage 7, see volumeDeviceBinds).
  Mounts?: Array<{
    Type?: string;
    Name?: string;
    Driver?: string;
    Source?: string;
    Destination?: string;
    RW?: boolean;
  }> | null;
  // For recreate (stage 5a): the network assignment of the existing
  // container. Deliberately loosely typed — the payload is taken over
  // unchanged, not rebuilt field by field.
  NetworkSettings?: {
    Networks?: Record<string, Record<string, unknown>> | null;
    SandboxKey?: string;
    // ⚠️ Only the KEYS are evaluated (`8080/tcp`) — the values carry the host
    // binding (`HostIp`/`HostPort`) and stay unread.
    Ports?: Record<string, unknown> | null;
  };
  HostConfig?: {
    Privileged?: boolean;
    RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
    CapAdd?: string[] | null;
    CapDrop?: string[] | null;
    SecurityOpt?: string[] | null;
    PidMode?: string;
    IpcMode?: string;
    NetworkMode?: string;
    Binds?: string[] | null;
    // Long notation (`--mount`, Compose `volumes: - type: bind`). Does NOT end
    // up in Binds.
    Mounts?: Array<{ Type?: string; Source?: string; Target?: string; ReadOnly?: boolean }> | null;
    Devices?: Array<{ PathOnHost?: string; PathInContainer?: string }> | null;
    // Resource limits (stage plan 3.8). The engine returns 0 for "no limit";
    // PidsLimit can additionally be null.
    Memory?: number;
    NanoCpus?: number;
    CpuQuota?: number;
    PidsLimit?: number | null;
    // Log driver (K4b, §21.6). The engine resolves the daemon default into
    // this at creation — so the field describes the ACTUAL state of the
    // container, not what is in the Compose file.
    LogConfig?: { Type?: string; Config?: Record<string, string> | null };
  };
};

// All host paths that are actually in the container — in the form
// "source:target" the hardening rules expect.
//
// ⚠️ Security-relevant. A bind mount can come about in THREE ways, and only
// the first ends up in HostConfig.Binds:
//
//   1. `-v /host:/container`            -> HostConfig.Binds
//   2. `--mount type=bind,source=…`     -> HostConfig.Mounts
//      (also Compose `volumes: - type: bind, source: …` — long notation)
//   3. `--volumes-from other`           -> neither; inherited
//
// Until 2026-07-20 the hardening only read Binds. A container with docker.sock
// via path 2 or 3 thus got through cleanly — `blocking: []`, mutating action
// 200. That would have defeated the basic rule of the whole model (stage plan
// 3.8: docker.sock never in a managed container).
//
// Authoritative is therefore the RESOLVED top-level list `Mounts`: it contains
// all three paths. Named volumes appear there with Type "volume" and a Source
// under /var/lib/docker/volumes — those are harmless and would otherwise wrongly
// count as a sensitive host path, so only Type "bind" counts. HostConfig.Binds
// is added on top: better one source too many than one too few.
export function bindSourcesOf(raw: RawInspect): string[] {
  const host = raw.HostConfig ?? {};
  const entries = new Set<string>(host.Binds ?? []);

  for (const mount of host.Mounts ?? []) {
    if (mount.Type !== "bind") continue;
    entries.add(`${mount.Source ?? ""}:${mount.Target ?? ""}${mount.ReadOnly ? ":ro" : ""}`);
  }

  for (const mount of raw.Mounts ?? []) {
    if (mount.Type !== "bind") continue;
    entries.add(`${mount.Source ?? ""}:${mount.Destination ?? ""}${mount.RW === false ? ":ro" : ""}`);
  }

  return [...entries];
}

// --- Named volumes that are really binds ----------------------------------
//
// ⚠️ Finding from the security review of stage 7.
//
// bindSourcesOf() above deliberately counts only Type "bind" — with the
// reasoning that named volumes live under /var/lib/docker/volumes and are
// therefore harmless. That reasoning holds for the normal case and was right
// as long as every managed file came from the checked emitter.
//
// It does NOT hold for the local driver with bind options:
//
//   volumes:
//     hostroot:
//       driver: local
//       driver_opts: { type: none, o: bind, device: / }
//
// Docker then reports the mount as Type "volume" with a Source under
// /var/lib/docker/volumes — but the container sees the host path from
// `device`. That would make `docker-socket-mount`, `sensitive-host-path` and
// `bind-outside-base` all blind, and of all things for the path the raw editor
// is the first to make reachable at all.
//
// This is VERBATIM the lesson from the review of 4+5a: *a rule is only as good
// as the field it reads from.* There it was `--mount` and `--volumes-from`,
// here it is the volume driver.
//
// The resolution needs a second engine call per volume and therefore cannot
// sit in the pure function. Separated as everywhere: FETCHING is asynchronous
// (inspectVolume), EVALUATING stays pure and testable.
export type RawVolume = {
  Name?: string;
  Driver?: string;
  Mountpoint?: string;
  Options?: Record<string, string> | null;
};

// The names of a container's named volumes — what has to be looked up.
export function volumeNamesOf(raw: RawInspect): string[] {
  const names = new Set<string>();
  for (const mount of raw.Mounts ?? []) {
    if (mount.Type !== "volume") continue;
    if (typeof mount.Name === "string" && mount.Name) names.add(mount.Name);
  }
  return [...names];
}

// Build, from the looked-up volumes, the bind entries the hardening
// understands. Format identical to bindSourcesOf, so that the same rules apply
// and there is no second, slightly different interpretation.
//
// Only `Options.device` is evaluated: without it, it is a normal named volume
// and stays harmless. `o: bind`/`type: none` are NOT additionally required — a
// `device` pointing to a host path is, with other options as well (such as an
// overlay- or nfs-like setup), a source that is meant to be seen. Better one
// source too many than one too few, just as with HostConfig.Binds.
export type VolumeBindResolution = {
  binds: string[];
  unresolved: string[];
};

// A missing volume inspect is no proof that the volume is harmless. Precisely
// then it is unknown whether `Options.device` points to an arbitrary host path.
// That is why the pure evaluation returns, alongside the found binds, the names
// for which no reliable statement is possible. The hardening turns them into a
// delegation lock (fail closed).
export function resolveVolumeBinds(
  raw: RawInspect,
  volumes: ReadonlyMap<string, RawVolume>
): VolumeBindResolution {
  const entries = new Set<string>();
  const unresolved = new Set<string>();
  for (const mount of raw.Mounts ?? []) {
    if (mount.Type !== "volume") continue;
    const name = mount.Name?.trim();
    if (!name) {
      unresolved.add(`<unbenannt>@${mount.Destination ?? "?"}`);
      continue;
    }
    const volume = volumes.get(name);
    if (!volume) {
      unresolved.add(name);
      continue;
    }
    const device = volume.Options?.device;
    if (typeof device !== "string" || !device.startsWith("/")) continue;
    entries.add(`${device}:${mount.Destination ?? ""}${mount.RW === false ? ":ro" : ""}`);
  }
  return { binds: [...entries], unresolved: [...unresolved] };
}

// Compatibility helper for callers that only need the successfully resolved
// bind sources. The hardening itself must always use resolveVolumeBinds(), so
// that `unresolved` is not lost.
export function volumeDeviceBinds(
  raw: RawInspect,
  volumes: ReadonlyMap<string, RawVolume>
): string[] {
  return resolveVolumeBinds(raw, volumes).binds;
}

// Translates the engine response into the form the hardening check expects.
// Kept separate so that the check stays testable without Docker.
//
// ⚠️ Do not call directly for the hardening, but through the path that also
// resolves the volumes (src/runtime/containers.ts/inspectedContainer) —
// otherwise the finding above applies again.
export function toInspectedContainer(raw: RawInspect): InspectedContainer {
  const host = raw.HostConfig ?? {};
  return {
    id: raw.Id,
    // The engine returns the name with a leading "/".
    name: (raw.Name ?? "").replace(/^\//, ""),
    image: raw.Config?.Image ?? raw.Image ?? "",
    privileged: host.Privileged === true,
    capAdd: host.CapAdd ?? [],
    capDrop: host.CapDrop ?? [],
    securityOpt: host.SecurityOpt ?? [],
    pidMode: host.PidMode ?? "",
    ipcMode: host.IpcMode ?? "",
    networkMode: host.NetworkMode ?? "",
    binds: bindSourcesOf(raw),
    devices: (host.Devices ?? []).map((device) =>
      [device.PathOnHost, device.PathInContainer].filter(Boolean).join(":")
    ),
    memoryLimitBytes: host.Memory ?? 0,
    pidsLimit: host.PidsLimit ?? null,
    // Both ways are valid: NanoCpus corresponds to `--cpus`, CpuQuota to the
    // older notation. Either one is enough as a limit.
    cpuLimited: (host.NanoCpus ?? 0) > 0 || (host.CpuQuota ?? 0) > 0,
    logDriver: host.LogConfig?.Type ?? "",
    logOptions: host.LogConfig?.Config ?? {}
  };
}
