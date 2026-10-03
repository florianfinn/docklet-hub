// Recreate a container (stage plan stage 5a).
//
// `recreate` is the most dangerous path of the whole project: it is remove +
// create, and if the create fails, the container is gone. That is why the
// reconstruction of the creation payload sits here as a pure function testable
// without Docker — and the choreography around it rolls back instead of
// hoping.
//
// What does NOT happen: "redefining" the container. A recreate takes over the
// existing definition unchanged and swaps exclusively the image. Changing
// anything else is stage 5b (structured data model) and needs its own
// validation there.

import type { RawInspect } from "./engine.js";

// Labels Docker Compose attaches to its containers. They are taken over
// VERBATIM: Dockge keeps running alongside until stage 9, and a container
// without its Compose labels would be a foreign body to Compose, which it
// creates a second time on the next `up`. The config hash stays valid because
// recreate does not touch the service definition — only the image.
const COMPOSE_LABEL_PREFIX = "com.docker.compose.";

export type CreatePayload = {
  name: string;
  config: Record<string, unknown>;
  // Networks beyond the primary one: on create the engine reliably connects
  // only one, the rest is attached afterwards.
  additionalNetworks: Array<{ name: string; endpoint: Record<string, unknown> }>;
};

// Endpoint fields the engine assigns at RUNTIME. Sending them along means
// wanting to force the old container's IP onto the new one — that either fails
// or collides. Only the fields someone can have set deliberately are kept.
const KEPT_ENDPOINT_FIELDS = ["Aliases", "IPAMConfig", "Links", "DriverOpts"] as const;

function cleanEndpoint(endpoint: Record<string, unknown>, containerId: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of KEPT_ENDPOINT_FIELDS) {
    const value = endpoint[field];
    if (value === undefined || value === null) continue;
    if (field === "Aliases" && Array.isArray(value)) {
      // The short container id is always in there as an alias — it belongs to
      // the old container and would simply be wrong on the new one.
      const shortId = containerId.slice(0, 12);
      const aliases = value.filter((alias) => alias !== shortId);
      if (aliases.length === 0) continue;
      result[field] = aliases;
      continue;
    }
    result[field] = value;
  }
  return result;
}

export type BuildOptions = {
  // The ref used for creation. Deliberately the ref and not the image id:
  // otherwise `docker ps` would show a sha256 instead of a readable name, and
  // Compose would consider the container foreign. The guarantee that exactly
  // the confirmed image runs comes instead from the check BEFORE and AFTER
  // (see src/routes/recreate-routes.ts and the final check in
  // recreateContainer below).
  imageRef: string;
};

export function buildCreatePayload(raw: RawInspect, options: BuildOptions): CreatePayload {
  const config = (raw.Config ?? {}) as Record<string, unknown>;
  const hostConfig = { ...(raw.HostConfig ?? {}) } as Record<string, unknown>;
  const name = (raw.Name ?? "").replace(/^\//, "");
  const networks = (raw.NetworkSettings?.Networks ?? {}) as Record<string, Record<string, unknown>>;

  const payload: Record<string, unknown> = {
    // Take over everything from the existing definition …
    ...config,
    // … and set exactly two things.
    Image: options.imageRef,
    HostConfig: hostConfig
  };

  // Hostname: by default the engine sets it to the short container id. If
  // that is the case, it has to GO — otherwise the new container carries the
  // old one's id as its hostname. If it was set deliberately, it stays.
  if (typeof payload.Hostname === "string" && raw.Id.startsWith(payload.Hostname)) {
    delete payload.Hostname;
  }

  // ⚠️ With `network_mode: container:<id>` (in Compose `service:<name>`) the
  // container takes over the network identity of ANOTHER one. `inspect` then
  // reports that one's short id as hostname — not its own. The rule above
  // compares against its own id, so it does not apply, and the engine flatly
  // refuses a create with a hostname set in this mode:
  //
  //   400 conflicting options: hostname and the network mode
  //
  // Found live at the first self-update on remote-host (#36): there the agent hangs
  // in the netns of the WireGuard sidecar, and the hostname was the sidecar's
  // short id. This affects EVERY recreate of this design, not just the
  // self-update — on the proxy, api and web sit in tailscale's netns in the
  // same way.
  if (typeof hostConfig.NetworkMode === "string" && hostConfig.NetworkMode.startsWith("container:")) {
    delete payload.Hostname;
    // Docker forbids these options with a shared network namespace identity.
    // `inspect` can show inherited values; sending them as create options
    // leads to 400 even though the running definition is valid (#48).
    for (const field of ["MacAddress", "ExposedPorts"]) delete payload[field];
    for (const field of ["ExtraHosts", "Dns", "DnsSearch", "DnsOptions", "PortBindings", "PublishAllPorts"]) {
      delete hostConfig[field];
    }
    // The networks belong to the sidecar. This container must not be attached
    // to them itself, neither at create nor afterwards via connect.
    return { name, config: payload, additionalNetworks: [] };
  }

  const networkNames = Object.keys(networks);
  const primary = primaryNetworkOf(hostConfig, networkNames);
  if (primary) {
    payload.NetworkingConfig = {
      EndpointsConfig: { [primary]: cleanEndpoint(networks[primary] ?? {}, raw.Id) }
    };
  }

  const additionalNetworks = networkNames
    .filter((network) => network !== primary)
    .map((network) => ({ name: network, endpoint: cleanEndpoint(networks[network] ?? {}, raw.Id) }));

  return { name, config: payload, additionalNetworks };
}

// Which of the networks is the primary one? NetworkMode names it, except for
// the special values (default/bridge/host/none/container:…), where the engine
// decides itself.
function primaryNetworkOf(hostConfig: Record<string, unknown>, networkNames: string[]): string | null {
  const mode = typeof hostConfig.NetworkMode === "string" ? hostConfig.NetworkMode : "";
  if (mode && networkNames.includes(mode)) return mode;
  return networkNames[0] ?? null;
}

// Whether a container is managed by Compose. Not an exclusion criterion — the
// information goes into the response, so that it is visible that a second tool
// alongside holds the same definition.
export function isComposeManaged(raw: RawInspect): boolean {
  const labels = raw.Config?.Labels ?? {};
  return Object.keys(labels).some((label) => label.startsWith(COMPOSE_LABEL_PREFIX));
}

// The choreography. The order is the whole point:
//
//   stop -> RENAME OLD -> create new -> start -> remove old
//
// The old container is kept until the very end. If anything fails, the
// half-finished new one is removed and the old one renamed back. If it was
// running before, it is started again. The naive order (remove, then create)
// has no way back: a failed create leaves nothing from which the container
// could be restored.
export type RecreateEngine = {
  stop(containerId: string): Promise<void>;
  start(containerId: string): Promise<void>;
  rename(containerId: string, name: string): Promise<void>;
  remove(containerId: string, options?: { force?: boolean }): Promise<void>;
  create(name: string, payload: unknown): Promise<string>;
  connectNetwork(network: string, containerId: string, endpoint: unknown): Promise<void>;
  inspect(containerId: string): Promise<RawInspect>;
};

export type RecreateOptions = {
  imageRef: string;
  // The image id confirmed by the caller. After creation it is checked
  // whether the new container actually runs on it — otherwise roll back.
  expectedImageId: string;
  // For tests only: otherwise from the clock.
  nowSuffix?: string;
};

// Stage 5c: `payloadOverride` is gone. It existed for the structured editing
// from 5b, which sent its new definition through the same choreography.
// Editing now goes through the Compose file (compose-apply.ts), and this
// function has only ONE job left: recreating an existing container with an
// UNCHANGED definition on a new image. That is exactly the recreate path for
// the existing containers that (until stage 5d) continue to be managed by
// Dockge.

// The latch at the end of the choreography has its own type so that the route
// can name it. As a bare `Error` it fell into the global handler and became
// `500 {"error":"internal-error"}` there — i.e. exactly the response #48 is against.
export class ImageMismatchError extends Error {
  constructor(
    readonly actualImageId: string,
    readonly expectedImageId: string
  ) {
    super(`created container runs on ${actualImageId}, confirmed was ${expectedImageId}`);
    this.name = "ImageMismatchError";
  }
}

// The original engine reason is preserved, while the route can also name the
// outcome of the rollback. `rolledBack` attests the successful rollback calls,
// not the later health of the service.
export class RecreateFailure extends Error {
  constructor(
    readonly original: unknown,
    readonly rollbackAttempted: boolean,
    readonly rolledBack: boolean
  ) {
    super(original instanceof Error ? original.message : String(original), { cause: original });
    this.name = "RecreateFailure";
  }
}

export type RecreateResult = {
  newContainerId: string;
  imageRef: string;
  imageId: string;
  composeManaged: boolean;
};

export async function recreateContainer(
  engine: RecreateEngine,
  raw: RawInspect,
  options: RecreateOptions
): Promise<RecreateResult> {
  const payload = buildCreatePayload(raw, { imageRef: options.imageRef });
  const oldId = raw.Id;
  const name = payload.name;
  const suffix = options.nowSuffix ?? String(Date.now());
  // Docker names do not allow ":" — hence a plain suffix.
  const parkedName = `${name}-alt-${suffix}`;

  let renamed = false;
  let stopped = false;
  let wasRunning = raw.State?.Running !== false;
  let newId: string | null = null;

  try {
    try {
      await engine.stop(oldId);
      stopped = true;
    } catch (error) {
      // Already stopped is not an error; everything else is.
      if (!isNotModified(error)) throw error;
      wasRunning = false;
    }

    await engine.rename(oldId, parkedName);
    renamed = true;

    newId = await engine.create(name, payload.config);

    for (const network of payload.additionalNetworks) {
      await engine.connectNetwork(network.name, newId, network.endpoint);
    }

    await engine.start(newId);

    // Final check: is the confirmed image really running? Between
    // confirmation and create the ref could point to a different image —
    // then it is not "good enough", it is rolled back.
    const created = await engine.inspect(newId);
    if (created.Image && created.Image !== options.expectedImageId) {
      throw new ImageMismatchError(created.Image, options.expectedImageId);
    }

    // From here on the new container exists and runs — the old one may go.
    await engine.remove(oldId, { force: true });

    return {
      newContainerId: newId,
      imageRef: options.imageRef,
      imageId: created.Image ?? options.expectedImageId,
      composeManaged: isComposeManaged(raw)
    };
  } catch (error) {
    const outcome = await rollback(engine, { newId, renamed, stopped, wasRunning, oldId, name });
    throw new RecreateFailure(error, outcome.attempted, outcome.succeeded);
  }
}

async function rollback(
  engine: RecreateEngine,
  state: { newId: string | null; renamed: boolean; stopped: boolean; wasRunning: boolean; oldId: string; name: string }
): Promise<{ attempted: boolean; succeeded: boolean }> {
  const attempted = Boolean(state.newId || state.renamed || state.stopped);
  let succeeded = true;
  // Best effort, but in this order: first remove the half-finished new one,
  // otherwise the name is taken when renaming back.
  if (state.newId) {
    try {
      await engine.remove(state.newId, { force: true });
    } catch {
      // The rollback attempt must not mask the original error.
      succeeded = false;
    }
  }
  if (state.renamed) {
    try {
      await engine.rename(state.oldId, state.name);
    } catch {
      succeeded = false;
    }
  }
  if (state.stopped && state.wasRunning) {
    try {
      await engine.start(state.oldId);
    } catch {
      succeeded = false;
    }
  }
  return { attempted, succeeded: attempted && succeeded };
}

function isNotModified(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: number }).status === 304;
}
