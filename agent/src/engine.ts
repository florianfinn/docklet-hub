import { openArchiveStream } from "./archive-request.js";
import { containerActionTimeoutMs } from "./runtime-actions.js";
import http from "node:http";
import type { RuntimeCallOptions } from "./runtime-budget.js";
import type { Socket } from "node:net";
import type { ParsedImageRef } from "./image-ref.js";
import { LogDemuxer, renderDemuxedLines, type DemuxedLine } from "./log-demux.js";
import { resolveLogTail } from "./log-tail.js";
import { UNRAID_MANAGED_LABEL } from "./external-management.js";
import { EngineError, EnginePullError, EngineAbortError } from "./engine-errors.js";
import type { ResourcePath } from "./resources.js";
import {
  type EngineRegistryAuth,
  registryAuthHeader,
  pullQueryParams,
  findStreamError,
  type PullProgress,
  parsePullProgress,
  type RawStats,
  type EngineInfo,
  type EngineOptions,
  type DockerMonitorEvent,
  monitorEventOf,
  type RawInspect,
  type RawVolume
} from "./engine-model.js";

// Minimal client for the Docker Engine API over the Unix socket.
//
// Deliberately node:http with socketPath instead of dockerode: the agent is the
// only component with root-equivalent access, and pulling a dependency tree
// into exactly that place would be the wrong trade. And deliberately never
// child_process — string concatenation into a shell is a non-starter on this
// attack surface (stage plan 3.2).


// The socket's idle window has expired. Not a type of its own, but a `code` in
// the same form node attaches to its own socket failures (ECONNREFUSED,
// ECONNRESET, ENOENT for a missing docker.sock) — so that a caller can classify
// all transport errors by ONE trait and not this one by a second.
//
// ⚠️ The reason for the code: a caller that wants to tell "the connection to
// the engine broke" from "the engine refused" (#80) previously had to recognise
// this one case by the wording "Engine-Timeout". A text is not a contract — it
// silently drops out of the distinction at the first rewording.
function engineTimeoutError(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error("Engine-Timeout");
  error.code = "ETIMEDOUT";
  return error;
}

type RequestOptions = {
  method: "GET" | "HEAD" | "POST" | "DELETE" | "PUT";
  path: string;
  // The response is not JSON (e.g. log stream).
  raw?: boolean;
  // Overrides the default timeout. An image pull takes longer than any other
  // operation here and must not run into the 15s default.
  timeoutMs?: number;
  // JSON body (create only). The only way to hand structures to the engine —
  // never glued-together strings, let alone through a shell.
  body?: unknown;
  // Abort closes the request. It does not prove that Docker cancelled an
  // already accepted container mutation.
  signal?: AbortSignal;
  // Non-stream responses are collected in memory. Every caller gets a sane
  // ceiling; log snapshots use a tighter one because a container controls the
  // bytes returned by the daemon.
  maxResponseBytes?: number;
  // Additional fixed engine headers. Currently exclusively for the transient
  // X-Registry-Auth of a private image pull.
  headers?: Record<string, string>;
  onConnected?: () => void;
  // A body that is NOT JSON — so far only the tar stream of put-archive
  // (S19). Excludes `body`; at most one of the two is ever set.
  rawBody?: Buffer;
  rawContentType?: string;
};


const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_LOG_SNAPSHOT_BYTES = 4 * 1024 * 1024;

export class DockerEngine {
  constructor(private readonly options: EngineOptions) {}

  private request(options: RequestOptions): Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }> {
    const payload =
      options.rawBody !== undefined
        ? options.rawBody
        : options.body === undefined
          ? null
          : Buffer.from(JSON.stringify(options.body), "utf8");
    const contentType = options.rawBody !== undefined ? (options.rawContentType ?? "application/x-tar") : "application/json";
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.options.socketPath,
          path: options.path,
          method: options.method,
          // The engine accepts any Host header; a fixed value keeps the
          // requests reproducible.
          headers: {
            Host: "docker",
            Accept: "application/json",
            ...options.headers,
            ...(payload
              ? { "Content-Type": contentType, "Content-Length": String(payload.length) }
              : {})
          },
          signal: options.signal,
          timeout: options.timeoutMs ?? this.options.timeoutMs ?? 15_000
        },
        (response) => {
          const chunks: Buffer[] = [];
          const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
          let responseBytes = 0;
          response.on("data", (chunk: Buffer) => {
            responseBytes += chunk.length;
            if (responseBytes > maxResponseBytes) {
              response.destroy(new EngineError(`engine response larger than ${maxResponseBytes} bytes`, 502));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), headers: response.headers })
          );
          response.on("error", reject);
        }
      );
      request.on("timeout", () => {
        request.destroy(engineTimeoutError());
      });
      request.on("error", reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  // Like `request`, but the body is NOT collected: every chunk goes straight to
  // the caller. Needed for /images/create, whose progress is to be shown
  // during the pull — buffered, it would only arrive once nobody cares any more.
  //
  // On an error status the body is collected after all (bounded): that is where
  // the engine's reason is, and a caller that only gets the status could not
  // supply it afterwards.
  private stream(
    options: RequestOptions,
    onChunk: (chunk: Buffer) => void
  ): Promise<{ status: number; errorBody: Buffer }> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.options.socketPath,
          path: options.path,
          method: options.method,
          headers: { Host: "docker", Accept: "application/json", ...options.headers },
          timeout: options.timeoutMs ?? this.options.timeoutMs ?? 15_000,
          signal: options.signal
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const failed = status < 200 || status >= 300;
          if (!failed) options.onConnected?.();
          const errorChunks: Buffer[] = [];
          let errorSize = 0;
          response.on("data", (chunk: Buffer) => {
            if (!failed) {
              onChunk(chunk);
              return;
            }
            if (errorSize >= 8192) return;
            errorSize += chunk.length;
            errorChunks.push(chunk);
          });
          response.on("end", () => resolve({ status, errorBody: Buffer.concat(errorChunks) }));
          response.on("error", reject);
        }
      );
      request.on("timeout", () => {
        request.destroy(engineTimeoutError());
      });
      // A `signal` abort destroys the socket and makes this event fire with an
      // AbortError — that is not an engine failure but exactly the desired
      // behaviour. Without the distinction it would be filed under one of the
      // failure reasons of the pull stream (stream-failure-reasons.ts) instead
      // of counting as the deliberate cancellation it is.
      request.on("error", (error) => {
        if (options.signal?.aborted) {
          reject(new EngineAbortError());
          return;
        }
        reject(error);
      });
      request.end();
    });
  }

  private async json<T>(options: RequestOptions): Promise<T> {
    const { status, body } = await this.request(options);
    if (status < 200 || status >= 300) {
      // The engine error message can contain paths/names, but no env values —
      // it is still not passed on to the user, only logged (see the catch-all
      // in src/index.ts and `errorText` in src/runtime/http.ts).
      throw new EngineError(`engine responded ${status}: ${body.toString("utf8").slice(0, 500)}`, status);
    }
    return JSON.parse(body.toString("utf8")) as T;
  }

  async listContainerIds(): Promise<string[]> {
    const list = await this.json<Array<{ Id: string }>>({ method: "GET", path: "/containers/json?all=1" });
    return list.map((entry) => entry.Id);
  }

  async inspect(containerId: string, options: RuntimeCallOptions = {}): Promise<RawInspect> {
    return this.json<RawInspect>({
      method: "GET",
      path: `/containers/${encodeURIComponent(containerId)}/json`,
      ...options, timeoutMs: Math.min(options.timeoutMs ?? Infinity, this.options.timeoutMs ?? 15_000)
    });
  }

  // Look up a named volume (security review stage 7).
  //
  // A volume that cannot be found does not abort the whole container response.
  // `null` stays visible to the caller as NOT RESOLVED, though, and leads there
  // fail-closed to the delegation lock; as an empty bind list the same state
  // would be a bypass.
  async inspectVolume(name: string, options: RuntimeCallOptions = {}): Promise<RawVolume | null> {
    try {
      return await this.json<RawVolume>({
        method: "GET",
        path: `/volumes/${encodeURIComponent(name)}`,
        ...options, timeoutMs: Math.min(options.timeoutMs ?? Infinity, this.options.timeoutMs ?? 15_000)
      });
    } catch (error) {
      if (error instanceof EngineError && error.status === 404) return null;
      throw error;
    }
  }

  // Numeric tar owners are preserved; copyUIDGID must remain unset.
  async statArchive(containerId: string, target: string): Promise<import("./file-archive.js").ArchiveStat | null> {
    const query = new URLSearchParams({ path: target });
    const result = await this.request({ method: "HEAD", path: `/containers/${encodeURIComponent(containerId)}/archive?${query}` });
    if (result.status === 404) return null;
    if (result.status !== 200) throw new EngineError("archive-stat-failed", result.status);
    const header = result.headers["x-docker-container-path-stat"];
    if (typeof header !== "string") throw new EngineError("archive-stat-invalid", 502);
    let stat: import("./file-archive.js").ArchiveStat;
    try { stat = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as typeof stat; }
    catch { throw new EngineError("archive-stat-invalid", 502); }
    if (!stat || !Number.isSafeInteger(stat.mode) || stat.mode < 0 || stat.mode > 0xffffffff || !Number.isSafeInteger(stat.size) || stat.size < 0 || typeof stat.linkTarget !== "string") throw new EngineError("archive-stat-invalid", 502);
    return stat;
  }
  openArchiveStream(containerId: string, target: string, signal?: AbortSignal) {
    return openArchiveStream(this.options, containerId, target, signal);
  }
  async getArchive(containerId: string, target: string, maxResponseBytes: number): Promise<Buffer> {
    const query = new URLSearchParams({ path: target });
    const result = await this.request({ method: "GET", path: `/containers/${encodeURIComponent(containerId)}/archive?${query}`, maxResponseBytes });
    if (result.status !== 200) throw new EngineError("archive-read-failed", result.status);
    return result.body;
  }

  async putArchive(containerId: string, directory: string, archive: Buffer): Promise<void> {
    const query = new URLSearchParams({ path: directory, noOverwriteDirNonDir: "1" });
    const { status, body } = await this.request({
      method: "PUT",
      path: `/containers/${encodeURIComponent(containerId)}/archive?${query.toString()}`,
      rawBody: archive,
      // An upload may take longer than an inspect.
      timeoutMs: 120_000
    });
    if (status === 200) return;
    throw new EngineError(
      `put-archive failed (${status}): ${body.toString("utf8").slice(0, 300)}`,
      status
    );
  }

  async start(containerId: string, options: RuntimeCallOptions = {}): Promise<void> {
    await this.expectNoContent(`/containers/${encodeURIComponent(containerId)}/start`, Math.min(containerActionTimeoutMs("start", null), options.timeoutMs ?? Infinity), options.signal);
  }

  async stop(containerId: string, stopTimeout?: number | null, options: RuntimeCallOptions = {}): Promise<void> {
    const timeout = stopTimeout === undefined ? (await this.inspect(containerId)).Config?.StopTimeout : stopTimeout;
    await this.expectNoContent(`/containers/${encodeURIComponent(containerId)}/stop`, Math.min(containerActionTimeoutMs("stop", timeout), options.timeoutMs ?? Infinity), options.signal);
  }

  async restart(containerId: string, stopTimeout?: number | null, options: RuntimeCallOptions = {}): Promise<void> {
    const timeout = stopTimeout === undefined ? (await this.inspect(containerId)).Config?.StopTimeout : stopTimeout;
    // Docker owns both phases; the HTTP deadline includes a full start reserve.
    await this.expectNoContent(`/containers/${encodeURIComponent(containerId)}/restart`, Math.min(containerActionTimeoutMs("restart", timeout), options.timeoutMs ?? Infinity), options.signal);
  }

  private async expectNoContent(path: string, timeoutMs?: number, signal?: AbortSignal): Promise<void> {
    const { status, body } = await this.request({ method: "POST", path, timeoutMs, signal });
    // 304 = already in the target state; that is not an error.
    if (status === 204 || status === 304) return;
    throw new EngineError(`engine responded ${status}: ${body.toString("utf8").slice(0, 500)}`, status);
  }

  // --- Building blocks for recreate/remove (stage 5a) -----------------------

  async pause(containerId: string, paused: boolean, options: RuntimeCallOptions = {}): Promise<void> {
    const { status } = await this.request({ method: "POST",
      path: `/containers/${encodeURIComponent(containerId)}/${paused ? "pause" : "unpause"}`, ...options });
    if (status !== 204) throw new EngineError("pause state change failed", status);
  }

  async tagImage(imageId: string, repo: string, tag: string, options: RuntimeCallOptions = {}): Promise<void> {
    const query = new URLSearchParams({ repo, tag });
    const { status } = await this.request({ method: "POST", path: `/images/${encodeURIComponent(imageId)}/tag?${query}`, ...options });
    if (status !== 201) throw new EngineError("image tag failed", status);
  }

  async rename(containerId: string, name: string, options: RuntimeCallOptions = {}): Promise<void> {
    const { status, body } = await this.request({
      method: "POST",
      path: `/containers/${encodeURIComponent(containerId)}/rename?name=${encodeURIComponent(name)}`, ...options
    });
    if (status === 204) return;
    throw new EngineError(`rename failed (${status}): ${body.toString("utf8").slice(0, 300)}`, status);
  }

  // `v` removes anonymous volumes as well. Named volumes are ALWAYS kept —
  // they are the data, and a recreate must not touch them.
  async remove(containerId: string, options: { force?: boolean } & RuntimeCallOptions = {}): Promise<void> {
    const query = new URLSearchParams({ v: "0" });
    if (options.force) query.set("force", "1");
    const { status, body } = await this.request({
      method: "DELETE",
      path: `/containers/${encodeURIComponent(containerId)}?${query.toString()}`, timeoutMs: options.timeoutMs, signal: options.signal
    });
    if (status === 204 || status === 404) return;
    throw new EngineError(`remove failed (${status}): ${body.toString("utf8").slice(0, 300)}`, status);
  }

  // On create the engine reliably connects only ONE network; all further ones
  // are attached afterwards.
  async connectNetwork(network: string, containerId: string, endpoint: unknown, options: RuntimeCallOptions = {}): Promise<void> {
    const { status, body } = await this.request({
      method: "POST",
      path: `/networks/${encodeURIComponent(network)}/connect`,
      body: { Container: containerId, EndpointConfig: endpoint }, ...options
    });
    if (status === 200 || status === 204) return;
    throw new EngineError(
      `connecting network ${network} failed (${status}): ${body.toString("utf8").slice(0, 300)}`,
      status
    );
  }

  async disconnectNetwork(network: string, containerId: string): Promise<void> {
    const { status, body } = await this.request({
      method: "POST",
      path: `/networks/${encodeURIComponent(network)}/disconnect`,
      body: { Container: containerId, Force: false }
    });
    if (status === 200 || status === 204 || status === 404) return;
    throw new EngineError(
      `disconnecting network ${network} failed (${status}): ${body.toString("utf8").slice(0, 300)}`,
      status
    );
  }

  async create(name: string, payload: unknown, options: RuntimeCallOptions = {}): Promise<string> {
    const created = await this.json<{ Id?: string; Warnings?: string[] }>({
      method: "POST",
      path: `/containers/create?name=${encodeURIComponent(name)}`,
      body: payload,
      timeoutMs: 60_000, ...options
    });
    if (!created.Id) throw new EngineError("engine returned no container id", 502);
    return created.Id;
  }

  // Raw host list, ONLY for maintaining the allowlist (docker.registry.manage).
  // Deliberately reduced to Id/Name/Image: whoever maintains the allowlist has
  // to know which containers exist — not what is in their env variables.
  async listAll(): Promise<Array<{ id: string; name: string; image: string; status: string }>> {
    const list = await this.json<Array<{ Id: string; Names?: string[]; Image?: string; State?: string }>>({
      method: "GET",
      path: "/containers/json?all=1"
    });
    return list.map((entry) => ({
      id: entry.Id,
      name: (entry.Names?.[0] ?? "").replace(/^\//, ""),
      image: entry.Image ?? "",
      status: entry.State ?? "unknown"
    }));
  }

  // Host list for stack discovery (stage 5d).
  //
  // Like listAll, but with the four Compose labels and Unraid's manager label —
  // without them neither the project assignment nor the manager is known.
  //
  // ⚠️ EXPLICITLY only these five labels are passed through, not the whole
  // label map. Labels are set freely by the image author and in practice carry
  // descriptions, Traefik rules and occasionally credentials. The same
  // discipline as in toContainerSummary.
  async listWithComposeLabels(options: RuntimeCallOptions = {}): Promise<
    Array<{
      id: string;
      name: string;
      image: string;
      imageId: string;
      status: string;
      labels: Record<string, string>;
    }>
  > {
    const list = await this.json<
      Array<{
        Id: string;
        Names?: string[];
        Image?: string;
        ImageID?: string;
        State?: string;
        Labels?: Record<string, string>;
      }>
    >({ method: "GET", path: "/containers/json?all=1", ...options,
      timeoutMs: Math.min(options.timeoutMs ?? Infinity, this.options.timeoutMs ?? 15_000) });

    // The manager label feeds the registry's `externallyManaged` via host
    // discovery; without it every Unraid container would look hub-owned.
    const PASSED_THROUGH = [
      "com.docker.compose.project",
      "com.docker.compose.service",
      "com.docker.compose.project.working_dir",
      "com.docker.compose.project.config_files",
      UNRAID_MANAGED_LABEL
    ];

    return list.map((entry) => {
      const labels: Record<string, string> = {};
      for (const key of PASSED_THROUGH) {
        const value = entry.Labels?.[key];
        if (typeof value === "string") labels[key] = value;
      }
      return {
        id: entry.Id,
        name: (entry.Names?.[0] ?? "").replace(/^\//, ""),
        image: entry.Image ?? "",
        imageId: entry.ImageID ?? "",
        status: entry.State ?? "unknown",
        labels
      };
    });
  }

  // Resolved image id of a ref, or null if it does not exist locally.
  // This allows comparing before and after a pull whether anything actually
  // changed.
  async imageId(reference: string, options: RuntimeCallOptions = {}): Promise<string | null> {
    try {
      const image = await this.json<{ Id?: string }>({
        method: "GET",
        path: `/images/${encodeURIComponent(reference)}/json`, ...options,
        ...options, timeoutMs: Math.min(options.timeoutMs ?? Infinity, this.options.timeoutMs ?? 15_000)
      });
      return image.Id ?? null;
    } catch (error) {
      if (error instanceof EngineError && error.status === 404) return null;
      throw error;
    }
  }

  // Full inspect of a local image. Carries RepoDigests — the manifest digest the
  // image was pulled with (update check D2). Null if not present locally.
  //
  // `Config.Env` are the image author's defaults. They are needed to tell apart
  // in the "Umgebung" tab (S5b) what someone set and what was always there — a
  // `PATH` from the image is not configuration one wants to edit here.
  // `Labels` has been included since #36: the self-update reads
  // `org.opencontainers.image.version` from it — the identity cosign verifies
  // against. It deliberately lives on the IMAGE and not in the host's
  // configuration, because the signature confirms exactly this label.
  async inspectImage(
    reference: string, options: RuntimeCallOptions = {}
  ): Promise<{
    Id?: string;
    RepoDigests?: string[];
    Config?: { Env?: string[] | null; Labels?: Record<string, string> | null };
  } | null> {
    try {
      return await this.json<{
        Id?: string;
        RepoDigests?: string[];
        Config?: { Env?: string[] | null; Labels?: Record<string, string> | null };
      }>({
        method: "GET",
        path: `/images/${encodeURIComponent(reference)}/json`, ...options
      });
    } catch (error) {
      if (error instanceof EngineError && error.status === 404) return null;
      throw error;
    }
  }

  // The REMOTE manifest digest of a ref — fetched by the daemon over the
  // distribution API (update check D2). The daemon talks to the registry and
  // returns ONLY the descriptor, without pulling layers. That way the agent
  // itself stays without egress (L1) and the pull stays a separate, explicit
  // step.
  //
  // ⚠️ WITHOUT `auth` the daemon asks ANONYMOUSLY. It holds no credentials —
  // they live in the `config.json` of the user who otherwise runs the CLI. For
  // a private package the answer is then `unauthorized`, even for this
  // harmless question. Whoever wants to know the digest of a private image has
  // to pass the login along (registry-login.ts); in the agent nobody does, in
  // the watcher the periodic pre-check does.
  //
  // Null on every registry-side failure (401, 404, rate limit): "cannot
  // determine", not a thrown error — the update check must not knock over
  // monitoring.
  async remoteManifestDigest(
    reference: string,
    auth?: EngineRegistryAuth, options: RuntimeCallOptions = {}
  ): Promise<string | null> {
    try {
      const dist = await this.json<{ Descriptor?: { digest?: string } }>({
        method: "GET",
        path: `/distribution/${encodeURIComponent(reference)}/json`, ...options,
        ...(auth ? { headers: { "X-Registry-Auth": registryAuthHeader(auth) } } : {})
      });
      return dist.Descriptor?.digest ?? null;
    } catch (error) {
      if (error instanceof EngineError) return null;
      throw error;
    }
  }

  // Pulls exactly the ref passed in. The caller has already checked it against
  // the allowlist — here it is only handed over split into query parameters,
  // never glued together as a raw string.
  //
  // `onProgress` gets every stream line WHILE the pull is running (update with
  // progress display). Without the callback the call behaves as before: it
  // only returns once the stream has ended, and throws if an error was in it.
  async pull(
    parsed: ParsedImageRef,
    onProgress?: (event: PullProgress) => void,
    signal?: AbortSignal,
    registryAuth?: EngineRegistryAuth
  ): Promise<void> {
    const query = new URLSearchParams(pullQueryParams(parsed));

    // /images/create answers 200 and streams progress afterwards — an error
    // midway (ref does not exist, registry unreachable) is ONLY in the stream.
    // Without this check a failed pull reported success. That is why EVERY
    // line is evaluated, not just the last one, and the first error is kept
    // instead of aborting immediately when it occurs: the daemon keeps pulling
    // anyway, and a half-read stream swallows the rest.
    const state: { failure: string | null } = { failure: null };
    let rest = "";
    const process = (text: string) => {
      const lines = text.split("\n");
      // The last line of a chunk is almost always cut off and waits for the
      // next one — evaluating it here would mean parsing JSON fragments.
      rest = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const streamError = findStreamError(trimmed);
        if (streamError && !state.failure) state.failure = streamError;
        const progress = onProgress ? parsePullProgress(trimmed) : null;
        if (progress) onProgress?.(progress);
      }
    };

    const { status, errorBody } = await this.stream(
      {
        method: "POST",
        path: `/images/create?${query.toString()}`,
        raw: true,
        // A pull over a slow line must not fail on the timeout. The value is
        // an idle window of the socket, not a total budget: as long as layers
        // are flowing, the clock restarts.
        timeoutMs: 10 * 60_000,
        signal,
        ...(registryAuth ? { headers: { "X-Registry-Auth": registryAuthHeader(registryAuth) } } : {})
      },
      (chunk) => process(rest + chunk.toString("utf8"))
    );
    if (status < 200 || status >= 300) {
      throw new EngineError(`engine responded ${status}: ${errorBody.toString("utf8").slice(0, 500)}`, status);
    }
    // The tail after the last line break.
    if (rest.trim()) process(`${rest}\n`);

    if (state.failure) throw new EnginePullError(`pull failed: ${state.failure.slice(0, 300)}`);
  }

  // One-shot stats (stage 6b), for the CPU/RAM display of the container view.
  // `stream=false` returns ONE response with cpu_stats AND precpu_stats already
  // delimited against each other (the daemon takes the two measurements
  // internally) — no second call needed to compute a difference.
  //
  // Deliberately lenient on failure: stats are extra information, not a
  // security feature. A container that is just stopping, a Docker that refuses
  // stats instrumentation for a container that is not running, or a timeout
  // must not knock over the container list — they return null instead of an
  // exception the caller would only translate into "no data" anyway.
  async stats(containerId: string): Promise<RawStats | null> {
    try {
      return await this.json<RawStats>({
        method: "GET",
        path: `/containers/${encodeURIComponent(containerId)}/stats?stream=false`,
        timeoutMs: 10_000
      });
    } catch (error) {
      if (error instanceof EngineError) return null;
      throw error;
    }
  }

  // The fixed read paths of the storage overview (#10). `/system/df` sums the
  // volume sizes on disk and therefore gets a longer window.
  async readResource(path: ResourcePath): Promise<unknown> {
    return this.json<unknown>({ method: "GET", path, timeoutMs: path === "/system/df" ? 60_000 : undefined });
  }

  // The two host values the engine knows without a /proc or host mount.
  // The utilisation itself deliberately comes from the stats ring buffer: it is
  // the sum of the Docker containers and is never presented as host load.
  async info(): Promise<EngineInfo> {
    return this.json<EngineInfo>({ method: "GET", path: "/info" });
  }

  // One lifecycle stream, shared by local intent tracking and hub monitoring.
  // Container metadata stays inside the agent.
  async monitorEvents(
    onEvent: (event: DockerMonitorEvent) => void,
    signal?: AbortSignal,
    options: { since?: number; onConnected?: () => void } = {}
  ): Promise<void> {
    let rest = "";
    const consume = (text: string) => {
      const lines = text.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = monitorEventOf(JSON.parse(line) as unknown);
          if (event) onEvent(event);
        } catch {
          // An aborted or unknown event is no reason to lose the whole
          // stream. The next real change delivers a complete line again.
        }
      }
    };

    const { status, errorBody } = await this.stream(
      {
        method: "GET",
        path: options.since === undefined ? "/events" : `/events?since=${Math.floor(options.since)}`,
        onConnected: options.onConnected,
        raw: true,
        timeoutMs: 24 * 60 * 60_000,
        signal
      },
      (chunk) => consume(rest + chunk.toString("utf8"))
    );
    if (rest.trim()) consume(`${rest}\n`);
    if (status < 200 || status >= 300) {
      throw new EngineError(`engine responded ${status}: ${errorBody.toString("utf8").slice(0, 500)}`, status);
    }
  }

  // ⚠️ `tty` is mandatory, not optional (addendum to S6, §12.2 point 3): without
  // demuxing, the 8-byte frame headers of containers without a TTY would sit
  // raw between the lines, and stdout/stderr would not be separated. The same
  // demuxer as in `logsStream()`, just once instead of continuously: `push()`
  // on the whole buffer, `flush()` for the rest without a trailing line break,
  // then reassembled as readable text (timestamp + text) — the same shape the
  // callers (the plain text snapshot AND the 25-line attachment of the guided
  // update) already expected before, just without the control bytes.
  async logs(containerId: string, tail: number, tty: boolean): Promise<Buffer> {
    // ⚠️ `false` — and here this is the ONLY one of the four log paths that
    // calls it that way. The three streams read `tail=0` as "no history, only
    // from now on"; this snapshot lets a zero fall back to 200 like any other
    // unusable value. The reason is the missing `follow=1`: the snapshot is
    // done after the zero old lines, so a zero would give an EMPTY response
    // instead of a stream that only delivers what is new.
    //
    // The difference is existing behaviour: before issue #81 it sat unspoken
    // in the fourth copy of the calculation. It was DECIDED there and stays —
    // the snapshot does NOT get the zero case.
    //
    // What carried the decision was not the argument above but a measured
    // one: nobody can trigger the zero case here except by a manual call. The
    // hub does not call this route at all (it takes the stream, because that
    // separates `stdout` from `stderr`).
    //
    // Whoever newly uses this route has to know the jump: `tail=1` returns one
    // line, `tail=0` returns 200. That is the deliberately accepted price for
    // an accidentally sent `0` showing logs instead of an empty body one takes
    // for "the container is silent".
    //
    // Pinned by the test in `src/log-tail.test.ts` that checks the text
    // snapshot sends tail=200 to the engine for tail=0, via the generated
    // `?tail=` value, not via the helper alone. Whoever flips `false` turns it
    // red.
    const safeTail = resolveLogTail(tail, { zeroMeansNoHistory: false });
    const { status, body } = await this.request({
      method: "GET",
      path: `/containers/${encodeURIComponent(containerId)}/logs?stdout=1&stderr=1&timestamps=1&tail=${safeTail}`,
      raw: true,
      maxResponseBytes: MAX_LOG_SNAPSHOT_BYTES
    });
    if (status < 200 || status >= 300) {
      throw new EngineError(`engine responded ${status}`, status);
    }
    const demuxer = new LogDemuxer(tty);
    const lines = [...demuxer.push(body), ...demuxer.flush()];
    return Buffer.from(renderDemuxedLines(lines), "utf8");
  }

  // Live log stream (S6, §12.4): the same route as `logs()`, but with
  // `follow=1` — the engine first delivers the last `tail` lines and then
  // seamlessly attaches the running stream, until the caller aborts.
  //
  // `tty` decides whether demultiplexing is needed (see log-demux.ts) — it
  // comes from the caller, because it stems from `inspect().Config.Tty` and
  // this call purely holds the engine connection, it does no second inspect.
  //
  // `onLine` gets every demultiplexed line WHILE it arrives — the same design
  // as `onProgress` in `pull()`. No result value: a log stream has no "done",
  // only an abort or "the container is gone".
  async logsStream(
    containerId: string,
    options: { tail: number; tty: boolean },
    onLine: (line: DemuxedLine) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const safeTail = resolveLogTail(options.tail, { zeroMeansNoHistory: true });
    const demuxer = new LogDemuxer(options.tty);

    const { status, errorBody } = await this.stream(
      {
        method: "GET",
        path: `/containers/${encodeURIComponent(containerId)}/logs?follow=1&stdout=1&stderr=1&timestamps=1&tail=${safeTail}`,
        raw: true,
        // No total budget as with the pull — the caller
        // (src/routes/container-routes.ts) instead binds the lifetime to the
        // connection to the main API and to its own reconnect rhythm. An idle
        // timeout would be wrong here: a container that is silent for minutes
        // is not an error.
        timeoutMs: 24 * 60 * 60_000,
        signal
      },
      (chunk) => {
        for (const line of demuxer.push(chunk)) onLine(line);
      }
    );
    for (const line of demuxer.flush()) onLine(line);

    if (status < 200 || status >= 300) {
      throw new EngineError(`engine responded ${status}: ${errorBody.toString("utf8").slice(0, 500)}`, status);
    }
  }

  // --- Shell in the container (S16 — K1d, §20.1) ----------------------------
  //
  // ⚠️ Going through the engine API is NOT merely a matter of taste here: the
  // rule from 3.2 ("never child_process") weighs heaviest at this spot,
  // because a `docker exec` shell-out would be exactly the string
  // concatenation that could turn a session into host code execution. `Cmd` is
  // an array in the JSON body; there is no shell that interprets it.
  //
  // What is deliberately NOT set here:
  //   * `User` — without it the command runs as the container's user.
  //     Container root only if the container runs as root anyway; never an
  //     escalation through this path.
  //   * `Privileged` — default false, and it stays that way.
  //   * `WorkingDir` — the image's default is the expected starting point.
  //
  // `Env` carries exclusively TERM: without it the shell considers itself a
  // dumb terminal and the UI shows control characters instead of colours.
  async execCreate(
    containerId: string,
    cmd: string[],
    options: { tty: boolean; attach: boolean }
  ): Promise<string> {
    const created = await this.json<{ Id?: string }>({
      method: "POST",
      path: `/containers/${encodeURIComponent(containerId)}/exec`,
      body: {
        AttachStdin: options.attach,
        AttachStdout: options.attach,
        AttachStderr: options.attach,
        Tty: options.tty,
        Cmd: cmd,
        Env: options.tty ? ["TERM=xterm-256color"] : []
      }
    });
    if (!created.Id) throw new EngineError("engine returned no exec id", 502);
    return created.Id;
  }

  // Whether a program exists in the container at all — the shell detection
  // from §20.1 ("bash, otherwise sh; a container without either says so").
  //
  // ⚠️ This has to happen BEFORE the actual session and cannot be derived from
  // it. With `Detach: false` the daemon upgrades the connection FIRST (101)
  // and writes a start error afterwards as text INTO the stream — so an
  // "executable file not found" would not arrive as a status but as the first
  // terminal line, and falling back to `sh` would no longer be possible
  // without leaving an error message standing for the user. With
  // `Detach: true` the same error is a normal HTTP status.
  async execAvailable(containerId: string, program: string): Promise<boolean> {
    let execId: string;
    try {
      execId = await this.execCreate(containerId, [program, "-c", "exit 0"], {
        tty: false,
        attach: false
      });
    } catch (error) {
      if (error instanceof EngineError) return false;
      throw error;
    }
    const { status } = await this.request({
      method: "POST",
      path: `/exec/${encodeURIComponent(execId)}/start`,
      body: { Detach: true, Tty: false },
      timeoutMs: 10_000
    });
    return status >= 200 && status < 300;
  }

  // Starts the session and takes over the connection: from here on the socket
  // is a raw, bidirectional byte stream to the process in the container.
  //
  // The `Upgrade` path (101) instead of the 200 variant is intentional — only
  // with it does node deliver its own `upgrade` event with the bare socket,
  // instead of us having to bend an already parsed response back into a
  // duplex.
  async execStart(execId: string, options: { tty: boolean }): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify({ Detach: false, Tty: options.tty }), "utf8");
      const request = http.request({
        socketPath: this.options.socketPath,
        path: `/exec/${encodeURIComponent(execId)}/start`,
        method: "POST",
        headers: {
          Host: "docker",
          "Content-Type": "application/json",
          "Content-Length": String(payload.length),
          Connection: "Upgrade",
          Upgrade: "tcp"
        }
      });

      request.on("upgrade", (_response, socket: Socket, head: Buffer) => {
        // An interactive session must never die of an idle timeout — someone
        // keeping a shell open does not type non-stop. The caller
        // (src/routes/exec-routes.ts) deliberately limits the runtime itself.
        socket.setTimeout(0);
        socket.setNoDelay(true);
        // The first bytes may already have arrived with the upgrade. Without
        // pushing them back here, the start of the output would be missing.
        if (head && head.length > 0) socket.unshift(head);
        resolve(socket);
      });

      // No upgrade means: the daemon refused before upgrading (container
      // gone, exec id unknown). The body carries the reason.
      request.on("response", (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          if (size >= 8192) return;
          size += chunk.length;
          chunks.push(chunk);
        });
        response.on("end", () =>
          reject(
            new EngineError(
              `exec start responded ${response.statusCode}: ${Buffer.concat(chunks)
                .toString("utf8")
                .slice(0, 300)}`,
              response.statusCode ?? 502
            )
          )
        );
        response.on("error", reject);
      });
      request.on("error", reject);
      request.end(payload);
    });
  }

  // Pass the window size through. Only possible AFTER `execStart` — before
  // that the daemon knows no terminal it could adjust.
  async execResize(execId: string, cols: number, rows: number): Promise<void> {
    const query = new URLSearchParams({ h: String(rows), w: String(cols) });
    const { status, body } = await this.request({
      method: "POST",
      path: `/exec/${encodeURIComponent(execId)}/resize?${query.toString()}`,
      timeoutMs: 10_000
    });
    if (status >= 200 && status < 300) return;
    throw new EngineError(`resize failed (${status}): ${body.toString("utf8").slice(0, 200)}`, status);
  }

  // The exit code of the finished process, or null while it is running or
  // when it can no longer be queried. `null` means "unknown" and must never
  // look like a 0.
  async execExitCode(execId: string): Promise<number | null> {
    try {
      const info = await this.json<{ Running?: boolean; ExitCode?: number | null }>({
        method: "GET",
        path: `/exec/${encodeURIComponent(execId)}/json`,
        timeoutMs: 10_000
      });
      if (info.Running === true) return null;
      return typeof info.ExitCode === "number" ? info.ExitCode : null;
    } catch {
      return null;
    }
  }
}

// The errors and the data model of the engine API live in their own files
// (#277: this one was over 1,000 lines). Importers keep importing from here.
export { EngineError, engineMessage, EnginePullError, EngineAbortError } from "./engine-errors.js";
export {
  type EngineRegistryAuth,
  registryAuthHeader,
  pullQueryParams,
  findStreamError,
  type PullProgress,
  parsePullProgress,
  type RawStats,
  type EngineInfo,
  type EngineOptions,
  type DockerMonitorEvent,
  monitorEventOf,
  type RawInspect,
  bindSourcesOf,
  type RawVolume,
  volumeNamesOf,
  type VolumeBindResolution,
  resolveVolumeBinds,
  volumeDeviceBinds,
  toInspectedContainer
} from "./engine-model.js";
