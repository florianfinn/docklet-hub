import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DockerEngine,
  EngineError,
  bindSourcesOf,
  engineMessage,
  findStreamError,
  monitorEventOf,
  parsePullProgress,
  pullQueryParams,
  resolveVolumeBinds,
  registryAuthHeader,
  volumeDeviceBinds,
  volumeNamesOf,
  type RawInspect
} from "./engine.js";
import { parseImageRef } from "./image-ref.js";

// Found live: a ref without a tag ("adguard/adguardhome") triggered, via
// /images/create, a pull of EVERY tag of the repo, because the engine API —
// unlike the `docker` CLI — does not read a missing `tag` parameter as
// ":latest" but as "all". `parsed.tag` is null for such a ref (image-ref.ts);
// pullQueryParams has to fill it in.
test("a ref without a tag explicitly pulls :latest, not all tags", () => {
  const parsed = parseImageRef("adguard/adguardhome");
  assert.ok(parsed);
  assert.deepEqual(pullQueryParams(parsed), { fromImage: "adguard/adguardhome", tag: "latest" });
});

test("a ref with a tag passes exactly that tag through", () => {
  const parsed = parseImageRef("postgres:16-alpine");
  assert.ok(parsed);
  assert.deepEqual(pullQueryParams(parsed), { fromImage: "postgres", tag: "16-alpine" });
});

test("a digest ref gets no additional tag parameter", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const parsed = parseImageRef(`nginx@${digest}`);
  assert.ok(parsed);
  assert.deepEqual(pullQueryParams(parsed), { fromImage: `nginx@${digest}` });
});

test("G8f.1 encapsulates the local GHCR secret solely in the Docker X-Registry-Auth value", () => {
  const password = `github_pat_${"r".repeat(48)}`;
  const header = registryAuthHeader({
    username: "dashboard-registry-reader",
    password,
    serverAddress: "ghcr.io"
  });
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString("utf8")), {
    username: "dashboard-registry-reader",
    password,
    serveraddress: "ghcr.io"
  });
  assert.match(header, /=+$/, "Docker Engine requires padded Base64URL");
  assert.doesNotMatch(header, /[+/]/, "the header stays URL-safe");
  assert.equal(header.includes(password), false);
});

// /images/create sends HTTP 200 and only then streams the progress. An error
// is only ever in the stream — without this evaluation a failed pull reported
// success, and the UI showed an update that never came.
test("an error in the pull stream is found although HTTP 200 came", () => {
  const body = [
    '{"status":"Pulling from library/postgres","id":"16-alpine"}',
    '{"status":"Pulling fs layer","progressDetail":{},"id":"a1b2c3"}',
    '{"errorDetail":{"message":"manifest for postgres:99 not found"},"error":"manifest unknown"}'
  ].join("\n");
  assert.equal(findStreamError(body), "manifest for postgres:99 not found");
});

test("a clean stream reports no error", () => {
  const body = [
    '{"status":"Pulling from library/postgres","id":"16-alpine"}',
    '{"status":"Status: Image is up to date for postgres:16-alpine"}',
    ""
  ].join("\n");
  assert.equal(findStreamError(body), null);
});

test("a truncated last line does not count as an error", () => {
  const body = '{"status":"Downloading"}\n{"status":"Extrac';
  assert.equal(findStreamError(body), null);
});

test("error without errorDetail is recognised as well", () => {
  assert.equal(findStreamError('{"error":"toomanyrequests"}'), "toomanyrequests");
});

test("an empty body is not an error", () => {
  assert.equal(findStreamError(""), null);
});

// --- Docker event stream (S13) --------------------------------------------

test("the monitor only takes over relevant container state changes", () => {
  assert.deepEqual(
    monitorEventOf({ Type: "container", Action: "health_status: unhealthy", Actor: { ID: "a".repeat(64) } }),
    { action: "health_status", containerId: "a".repeat(64) }
  );
  assert.deepEqual(
    monitorEventOf({ Type: "container", Action: "die", Actor: { ID: "b".repeat(64) } }),
    { action: "die", containerId: "b".repeat(64) }
  );
});

test("the monitor keeps the name for local recreate matching", () => {
  assert.deepEqual(
    monitorEventOf({
      Type: "container",
      Action: "start",
      Actor: { ID: "c".repeat(64), Attributes: { name: "/frps" } }
    }),
    { action: "start", containerId: "c".repeat(64), containerName: "frps" }
  );
});

test("the monitor stream discards foreign or incomplete Docker events", () => {
  assert.equal(monitorEventOf({ Type: "image", Action: "pull", Actor: { ID: "a".repeat(64) } }), null);
  assert.equal(monitorEventOf({ Type: "container", Action: "rename", Actor: { ID: "a".repeat(64) } }), null);
  assert.equal(monitorEventOf({ Type: "container", Action: "oom", Actor: { ID: "kurz" } }), null);
});

// --- parsePullProgress: what leaves the stream --------------------------
//
// The lines travel via the main API all the way into the browser. Hence a
// selection instead of a pass-through — a "pass everything on" would be the
// channel through which an unchecked field later rides along.

test("status, layer id and progress are taken over", () => {
  assert.deepEqual(
    parsePullProgress('{"status":"Downloading","id":"a1b2","progress":"[==>  ] 12MB/40MB"}'),
    { status: "Downloading", id: "a1b2", progress: "[==>  ] 12MB/40MB" }
  );
});

test("unknown fields are dropped", () => {
  const parsed = parsePullProgress(
    '{"status":"Extracting","id":"a1b2","progressDetail":{"current":1,"total":2},"auth":"geheim"}'
  );
  assert.deepEqual(parsed, { status: "Extracting", id: "a1b2", progress: null });
});

test("a line without status is no progress line", () => {
  // The stream's error line, for example — it is evaluated elsewhere
  // (findStreamError) and has no business in the display.
  assert.equal(parsePullProgress('{"errorDetail":{"message":"nope"},"error":"nope"}'), null);
});

test("unparsable lines yield null instead of an exception", () => {
  assert.equal(parsePullProgress('{"status":"Extrac'), null);
});

test("overlong values are clipped", () => {
  const long = "x".repeat(500);
  const parsed = parsePullProgress(JSON.stringify({ status: long, id: long, progress: long }));
  assert.equal(parsed?.status.length, 200);
  assert.equal(parsed?.id?.length, 80);
  assert.equal(parsed?.progress?.length, 120);
});

// --- bindSourcesOf: all three routes to a bind mount ----------------------
// Security review 2026-07-20: the hardening only read HostConfig.Binds. A
// docker.sock mount via the long syntax or via --volumes-from thus got
// through cleanly.

test("short syntax (-v) is found", () => {
  assert.deepEqual(
    bindSourcesOf({
      Id: "x",
      Name: "/c",
      HostConfig: { Binds: ["/home/docker/app/data:/data"] }
    } as RawInspect),
    ["/home/docker/app/data:/data"]
  );
});

test("long syntax (--mount / Compose long syntax) is found", () => {
  // Exactly the case that slipped through live on 2026-07-20.
  const found = bindSourcesOf({
    Id: "x",
    Name: "/c",
    HostConfig: {
      Binds: null,
      Mounts: [{ Type: "bind", Source: "/var/run/docker.sock", Target: "/var/run/docker.sock" }]
    }
  } as RawInspect);
  assert.deepEqual(found, ["/var/run/docker.sock:/var/run/docker.sock"]);
});

test("inherited mounts (--volumes-from) are found", () => {
  // They are in NEITHER of the two HostConfig lists, only in the resolved
  // Mounts list.
  const found = bindSourcesOf({
    Id: "x",
    Name: "/c",
    HostConfig: { Binds: null },
    Mounts: [{ Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: true }]
  } as RawInspect);
  assert.deepEqual(found, ["/var/run/docker.sock:/var/run/docker.sock"]);
});

test("named volumes do not count as bind mounts", () => {
  // Otherwise their source under /var/lib/docker would be a sensitive host
  // path and every container with a volume would be blocked.
  assert.deepEqual(
    bindSourcesOf({
      Id: "x",
      Name: "/c",
      Mounts: [
        { Type: "volume", Source: "/var/lib/docker/volumes/daten/_data", Destination: "/data", RW: true }
      ]
    } as RawInspect),
    []
  );
});

test("the same mount from two sources is not counted twice", () => {
  const found = bindSourcesOf({
    Id: "x",
    Name: "/c",
    HostConfig: { Binds: ["/home/docker/a:/a"] },
    Mounts: [{ Type: "bind", Source: "/home/docker/a", Destination: "/a", RW: true }]
  } as RawInspect);
  assert.deepEqual(found, ["/home/docker/a:/a"]);
});

// --- Named volumes that are really binds ------------------------------------
//
// Security review stage 7. bindSourcesOf only counts Type "bind" — on the
// grounds that named volumes live under /var/lib/docker/volumes and are
// harmless. For the local driver with bind options that is not true: the mount
// reports Type "volume" and a source under /var/lib/docker/volumes, but the
// container sees the host path from `device`.
//
// Exactly the same shape of bug as in the review of 4+5a: a rule is only as
// good as the field it reads from.

const WITH_VOLUME: RawInspect = {
  Id: "abc",
  Name: "/heimlich",
  Mounts: [
    { Type: "volume", Name: "proj_hostroot", Source: "/var/lib/docker/volumes/proj_hostroot/_data", Destination: "/host" },
    { Type: "volume", Name: "proj_daten", Source: "/var/lib/docker/volumes/proj_daten/_data", Destination: "/data" }
  ]
};

test("the names of the named volumes are collected", () => {
  assert.deepEqual(volumeNamesOf(WITH_VOLUME).sort(), ["proj_daten", "proj_hostroot"]);
});

test("a volume with device becomes a bind source, a normal one does not", () => {
  const volumes = new Map([
    ["proj_hostroot", { Name: "proj_hostroot", Driver: "local", Options: { type: "none", o: "bind", device: "/" } }],
    // An ordinary named volume has no device option and stays harmless —
    // otherwise every data volume would suddenly be a finding.
    ["proj_daten", { Name: "proj_daten", Driver: "local", Options: null }]
  ]);
  assert.deepEqual(volumeDeviceBinds(WITH_VOLUME, volumes), ["/:/host"]);
  assert.deepEqual(resolveVolumeBinds(WITH_VOLUME, volumes), {
    binds: ["/:/host"],
    unresolved: []
  });
});

test("the docker.sock via a volume becomes visible", () => {
  // The actual attack: Type "volume", i.e. invisible to bindSourcesOf.
  const raw: RawInspect = {
    Id: "abc",
    Name: "/heimlich",
    Mounts: [{ Type: "volume", Name: "sock", Source: "/var/lib/docker/volumes/sock/_data", Destination: "/var/run" }]
  };
  assert.deepEqual(bindSourcesOf(raw), []);
  const volumes = new Map([["sock", { Options: { device: "/var/run" } }]]);
  assert.deepEqual(volumeDeviceBinds(raw, volumes), ["/var/run:/var/run"]);
});

test("unresolvable volumes stay visible as a fail-closed state", () => {
  assert.deepEqual(resolveVolumeBinds(WITH_VOLUME, new Map()), {
    binds: [],
    unresolved: ["proj_hostroot", "proj_daten"]
  });
});

test("a volume mount without a name is not provably harmless either", () => {
  const raw: RawInspect = {
    Id: "abc",
    Name: "/unbekannt",
    Mounts: [{ Type: "volume", Destination: "/daten" }]
  };
  assert.deepEqual(resolveVolumeBinds(raw, new Map()), {
    binds: [],
    unresolved: ["<unbenannt>@/daten"]
  });
});

test("only absolute device paths count", () => {
  // A relative or empty value is no host source and should not fill the list
  // with nonsense.
  const volumes = new Map([["proj_hostroot", { Options: { device: "relativ" } }]]);
  assert.deepEqual(volumeDeviceBinds(WITH_VOLUME, volumes), []);
});

test("read-only is taken over", () => {
  const raw: RawInspect = {
    Id: "abc",
    Name: "/x",
    Mounts: [{ Type: "volume", Name: "v", Destination: "/host", RW: false }]
  };
  assert.deepEqual(volumeDeviceBinds(raw, new Map([["v", { Options: { device: "/etc" } }]])), [
    "/etc:/host:ro"
  ]);
});

// The message that never made it out of the agent's stderr during the outage
// of 2026-08-25: `restart` and `start` on sonarr both ended as "internal
// error", while the engine had long since said the actual sentence.
test("engineMessage peels the engine sentence out of prefix and JSON wrapper", () => {
  const error = new EngineError(
    'engine responded 409: {"message":"cannot join network of a non running container 90410adc"}',
    409
  );
  assert.equal(engineMessage(error), "cannot join network of a non running container 90410adc");
});

test("engineMessage passes plain text through instead of discarding it", () => {
  // Older daemons and errors beyond the JSON API answer in plain text.
  assert.equal(
    engineMessage(new EngineError("engine responded 500: server error", 500)),
    "server error"
  );
  // Without a prefix (e.g. the response size cap) the message stays whole.
  assert.equal(
    engineMessage(new EngineError("engine response larger than 100 bytes", 502)),
    "engine response larger than 100 bytes"
  );
});

// --- The X-Registry-Auth on the NON-stream path (#36, 2b) --------------------
//
// ⚠️ This test exists because of a failure during rollout, not because of a
// hunch. `remoteManifestDigest` was given credentials, the engine did not get
// them: `request()` built its headers itself and dropped `options.headers` —
// the stream path (which the pull uses) evaluated them, this one did not. The
// request succeeded and answered `unauthorized`, i.e. exactly as without
// credentials.
//
// What is checked is therefore what arrives at the DAEMON, not what the caller
// handed over. For that a tiny server runs on a socket or a named pipe — the
// same promise on both platforms.
function socketPath(name: string): string {
  return process.platform === "win32"
    ? path.join(String.raw`\\.\pipe`, `agent-engine-${process.pid}-${name}`)
    : path.join(os.tmpdir(), `agent-engine-${process.pid}-${name}.sock`);
}

test("the credentials reach the daemon even without a stream", async (t) => {
  const seen: { pathname: string; auth: string | undefined }[] = [];
  const server = http.createServer((request, response) => {
    seen.push({
      pathname: request.url ?? "",
      auth: request.headers["x-registry-auth"] as string | undefined
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ Descriptor: { digest: `sha256:${"e".repeat(64)}` } }));
  });
  const pathname = socketPath("mit-auth");
  await new Promise<void>((done) => server.listen(pathname, done));
  t.after(() => new Promise<void>((done) => void server.close(() => done())));

  const engine = new DockerEngine({ socketPath: pathname });
  const digest = await engine.remoteManifestDigest("ghcr.io/wer/was:latest", {
    username: "wer",
    password: "geheim",
    serverAddress: "ghcr.io"
  });

  assert.equal(digest, `sha256:${"e".repeat(64)}`);
  assert.equal(seen.length, 1);
  assert.ok(seen[0]?.auth, "without this header the daemon asks anonymously");
  const unpacked = JSON.parse(Buffer.from(seen[0].auth, "base64").toString("utf8")) as {
    username: string;
    serveraddress: string;
  };
  assert.equal(unpacked.username, "wer");
  assert.equal(unpacked.serveraddress, "ghcr.io");
});

// The two engineMessage tests above build their error themselves — they stay
// green when the wording at the throw site changes and the prefix is no
// longer peeled off. That is what happened when the error texts were switched
// to English: regex and test inputs still carried `Engine antwortete`, while
// `engine responded` was already being thrown. This test therefore takes the
// error from a real engine response.
test("engineMessage peels the prefix the engine class really throws", async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "cannot join network of a non running container 90410adc" }));
  });
  const pathname = socketPath("praefix");
  await new Promise<void>((done) => server.listen(pathname, done));
  t.after(() => new Promise<void>((done) => void server.close(() => done())));

  const failure = await new DockerEngine({ socketPath: pathname }).inspect("abc").then(
    () => assert.fail("inspect should have thrown"),
    (error: unknown) => error
  );
  assert.ok(failure instanceof EngineError);
  assert.equal(engineMessage(failure), "cannot join network of a non running container 90410adc");
});

test("without credentials no empty header is sent either", async (t) => {
  // An empty X-Registry-Auth is not the same as none — Docker answers it with
  // an error instead of an anonymous attempt.
  const seen: (string | undefined)[] = [];
  const server = http.createServer((request, response) => {
    seen.push(request.headers["x-registry-auth"] as string | undefined);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ Descriptor: { digest: "sha256:egal" } }));
  });
  const pathname = socketPath("ohne-auth");
  await new Promise<void>((done) => server.listen(pathname, done));
  t.after(() => new Promise<void>((done) => void server.close(() => done())));

  await new DockerEngine({ socketPath: pathname }).remoteManifestDigest("ghcr.io/wer/was:latest");
  assert.deepEqual(seen, [undefined]);
});

test("304 runtime actions remain successful and stop reads the configured deadline", async (t) => {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    seen.push(request.url ?? "");
    if (request.url?.endsWith("/json")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ Id: "id", Name: "/app", Config: { StopTimeout: 90 } }));
    } else {
      response.writeHead(304);
      response.end();
    }
  });
  const pathname = socketPath("runtime-304");
  await new Promise<void>((done) => server.listen(pathname, done));
  t.after(() => new Promise<void>((done) => void server.close(() => done())));
  const engine = new DockerEngine({ socketPath: pathname });
  await engine.start("id");
  await engine.stop("id");
  await engine.restart("id");
  assert.deepEqual(seen, ["/containers/id/start", "/containers/id/json", "/containers/id/stop", "/containers/id/json", "/containers/id/restart"]);
});

test("runtime requests pass the calculated stop deadline to HTTP instead of the default", async (t) => {
  const deadlines: number[] = [];
  t.mock.method(http, "request", (options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    deadlines.push(Number(options.timeout));
    const request = new EventEmitter() as http.ClientRequest;
    request.end = (() => {
      const response = Object.assign(new EventEmitter(), { statusCode: 304 }) as http.IncomingMessage;
      callback(response);
      response.emit("end");
      return request;
    }) as typeof request.end;
    return request;
  });
  const engine = new DockerEngine({ socketPath: "/unused.sock", timeoutMs: 1 });
  t.mock.method(engine, "inspect", async () => ({ Id: "id", Name: "/app", Config: { StopTimeout: 90 } }));
  await engine.stop("id");
  await engine.restart("id");
  await engine.stop("id", null);
  await engine.start("id");
  assert.deepEqual(deadlines, [100_000, 100_000, 20_000, 30_000]);
});
