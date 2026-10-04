import test from "node:test";
import assert from "node:assert/strict";
import type { Response } from "express";

import { HOST_NAME_MAX, hostNameProblem } from "contract";
import { HostError, normalizeBindBasePath } from "../../domain/hosts/index.js";
import { buildHostArchive, type HostArchiveInput } from "./bootstrap/host-archive.js";
import { generateWireGuardKeyPair } from "./bootstrap/wireguard-keys.js";
import { EnrollmentError } from "./enrollment.js";
import { handleHostError } from "./host-errors.js";
import { createHostsService } from "./service.js";

// Host name and base path end up in comment lines of generated files and in
// copyable commands. Control characters are refused where the input enters,
// not replaced. Synthetic values only; built from code points so that no
// invisible character sits in this source file.

const char = (code: number) => String.fromCharCode(code);

const REFUSED_NAMES: [string, string][] = [
  ["line feed", `arm${char(0x0a)}services:`],
  ["CR LF", `arm${char(0x0d)}${char(0x0a)}x`],
  ["tab", `arm${char(0x09)}x`],
  ["NUL", `arm${char(0x00)}x`],
  ["DEL", `arm${char(0x7f)}x`],
  ["NEL (C1)", `arm${char(0x85)}x`],
  ["line separator", `arm${char(0x2028)}x`],
  ["paragraph separator", `arm${char(0x2029)}x`]
];

const ACCEPTED_NAMES = ["Büro Server 2.OG", "Ärztehaus Süd", "nas.example.test", "x".repeat(HOST_NAME_MAX)];

test("the shared rule refuses control characters and overlong names", () => {
  for (const [label, name] of REFUSED_NAMES) assert.equal(hostNameProblem(name), "control-character", label);
  assert.equal(hostNameProblem("x".repeat(HOST_NAME_MAX + 1)), "too-long");
  assert.equal(hostNameProblem("   "), "empty");
  for (const name of ACCEPTED_NAMES) assert.equal(hostNameProblem(name), null, name);
});

test("the route input answers name-invalid, as a code of its own", () => {
  const service = createHostsService({} as never);
  for (const [label, name] of REFUSED_NAMES) {
    const parsed = service.parseNewHost({ name, kind: "external", dockerGid: 1, bindBasePath: "/mnt/a" });
    assert.equal(parsed.kind === "invalid-input" && parsed.error, "name-invalid", label);
  }
  const empty = service.parseNewHost({ name: " ", kind: "external", dockerGid: 1 });
  assert.equal(empty.kind === "invalid-input" && empty.error, "invalid-input");
  assert.equal(service.parseNewHost({ name: "Büro Server 2.OG", kind: "external", dockerGid: 1 }).kind, "ok");
});

test("a HostError name-invalid leaves as 400 with that code", () => {
  const sent: { status?: number; body?: unknown } = {};
  const response = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    }
  } as unknown as Response;
  assert.equal(handleHostError(new HostError("name-invalid", "x"), response), true);
  assert.equal(sent.status, 400);
  assert.equal((sent.body as { error?: string }).error, "name-invalid");
});

test("the base path refuses control characters that \\s does not cover", () => {
  for (const code of [0x00, 0x01, 0x1b, 0x7f, 0x85, 0x9f]) {
    assert.equal(normalizeBindBasePath(`/mnt/a${char(code)}b`), null, `U+${code.toString(16).padStart(4, "0")}`);
  }
  assert.equal(normalizeBindBasePath("/mnt/cache/docker"), "/mnt/cache/docker");
});

function archiveInput(name: string, bindBasePath: string): HostArchiveInput {
  const keys = generateWireGuardKeyPair();
  return {
    host: { id: "host-1", name, kind: "external", tunnelAddress: "10.254.0.2", dockerGid: 281, bindBasePath },
    hub: { endpoint: "hub.example.test:51821", publicKey: keys.publicKey, tunnelCidr: "10.254.0.0/24", hubAddress: "10.254.0.1" },
    agent: { image: "registry.example.test/agent:v1.0.0", port: 8099, secret: "a".repeat(48), privateKey: keys.privateKey },
    registration: { url: "http://10.254.0.1:8080/api/hosts/host-1/register", token: "b".repeat(43) }
  };
}

// A record stored before the rule existed must not ship an injected line.
test("the archive refuses a stored name or path with a control character", async () => {
  for (const [label, name] of REFUSED_NAMES) {
    await assert.rejects(() => buildHostArchive(archiveInput(name, "/mnt/a")), /Steuerzeichen/, label);
  }
  await assert.rejects(() => buildHostArchive(archiveInput("arm", `/mnt/a${char(0x0a)}b`)), /Steuerzeichen/);
  const archive = await buildHostArchive(archiveInput("Büro Server 2.OG", "/mnt/a"));
  assert.equal(archive.length > 0, true);
});

test("an endpoint override with a control character or whitespace is refused", () => {
  const service = createHostsService({} as never);
  const body = (endpointOverride: string) => ({ name: "arm", kind: "external", dockerGid: 1, endpointOverride });
  for (const endpoint of [`hub.example.test${char(0x0a)}AllowedIPs = 0.0.0.0/0`, `hub${char(0x00)}.example.test`, "hub example.test"]) {
    assert.equal(service.parseNewHost(body(endpoint)).kind, "invalid-input", JSON.stringify(endpoint));
  }
  const parsed = service.parseNewHost(body("  hub.example.test:51821  "));
  assert.equal(parsed.kind === "ok" && parsed.input.endpointOverride, "hub.example.test:51821");
  const empty = service.parseNewHost(body(""));
  assert.equal(empty.kind === "ok" && empty.input.endpointOverride, null);
});

test("the base path refuses $, backtick, quotes and backslash, which .env and compose would reinterpret", () => {
  for (const path of ["/mnt/a$b", "/mnt/a`b", "/mnt/it's", '/mnt/a"b', `/mnt/a${char(92)}b`]) {
    assert.equal(normalizeBindBasePath(path), null, path);
  }
  for (const path of ["/mnt/user/appdata", "/srv/docker-data_1", "/mnt/..data", "/mnt/a&b", "/mnt/a;b"]) {
    assert.equal(normalizeBindBasePath(path), path, path);
  }
  const service = createHostsService({} as never);
  assert.equal(service.parseNewHost({ name: "arm", kind: "external", dockerGid: 1, bindBasePath: "/mnt/a$b" }).kind, "invalid-input");
});

test("a refused stored record leaves as 409 host-record-invalid", () => {
  const sent: { status?: number; body?: unknown } = {};
  const response = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    }
  } as unknown as Response;
  assert.equal(handleHostError(new EnrollmentError("host-record-invalid", "x"), response), true);
  assert.equal(sent.status, 409);
  assert.equal((sent.body as { error?: string }).error, "host-record-invalid");
});
