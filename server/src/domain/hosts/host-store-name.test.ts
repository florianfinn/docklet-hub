import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";

import { HOST_NAME_MAX } from "contract";
import type { TunnelNetwork } from "../../platform/config/config.js";
import { HostError, createHost } from "./host-store.js";

// createHost refuses a host name with a control character before any query
// runs, and stores an ordinary one trimmed (the shared rule is
// `contract/src/host-input.ts`; its full list of cases is in
// `features/hosts/host-input.test.ts`). Synthetic names, built from code points.

const char = (code: number) => String.fromCharCode(code);

const REFUSED_NAMES: [string, string][] = [
  ["line feed", `arm${char(0x0a)}services:`],
  ["CR LF", `arm${char(0x0d)}${char(0x0a)}x`],
  ["tab", `arm${char(0x09)}x`],
  ["NUL", `arm${char(0x00)}x`],
  ["line separator", `arm${char(0x2028)}x`],
  ["too long", "x".repeat(HOST_NAME_MAX + 1)]
];

const ACCEPTED_NAMES = ["Büro Server 2.OG", "Ärztehaus Süd", "nas.example.test", "x".repeat(HOST_NAME_MAX)];

const NETWORK: TunnelNetwork = {
  cidr: "10.254.0.0/24",
  networkAddress: "10.254.0.0",
  prefixLength: 24,
  hubAddress: "10.254.0.1",
  firstArmOffset: 2,
  lastArmOffset: 254
};

function createInput(name: string) {
  return {
    name,
    kind: "internal" as const,
    wireguardPublicKey: "pub",
    agentSecret: "s".repeat(40),
    registrationToken: "t".repeat(40),
    dockerGid: 996,
    bindBasePath: "/home/docker"
  };
}

function recordingPool(): { pool: Pool; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const pool = {
    query(text: string, values: unknown[] = []) {
      calls.push(values);
      if (text.includes("generate_series")) return Promise.resolve({ rows: [{ address: "10.254.0.2" }] });
      return Promise.resolve({
        rows: [
          {
            id: "host-1",
            name: values[1],
            agent_url: "http://10.254.0.2:8099",
            kind: "internal",
            state: "pending",
            tunnel_address: "10.254.0.2",
            wireguard_public_key: "pub",
            endpoint_override: null,
            failed_attempts: 0,
            docker_gid: 996,
            bind_base_path: "/home/docker",
            hue: "neutral",
            ink: "head",
            created_at: new Date("2026-10-04T10:00:00Z"),
            registered_at: null,
            last_seen_at: null
          }
        ]
      });
    }
  } as unknown as Pool;
  return { pool, calls };
}

test("createHost refuses such a name before the database sees it", async () => {
  for (const [label, name] of REFUSED_NAMES) {
    const { pool, calls } = recordingPool();
    await assert.rejects(
      () => createHost(pool, NETWORK, createInput(name)),
      (error: unknown) => error instanceof HostError && error.reason === "name-invalid",
      label
    );
    assert.equal(calls.length, 0, `${label}: no query ran`);
  }
});

test("createHost keeps umlauts, spaces and dots in the name", async () => {
  for (const name of ACCEPTED_NAMES) {
    const { pool, calls } = recordingPool();
    const record = await createHost(pool, NETWORK, createInput(`  ${name}  `));
    assert.equal(record.name, name);
    assert.equal(calls.at(-1)?.[1], name, "the trimmed name goes into the INSERT");
  }
});
