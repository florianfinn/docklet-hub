import assert from "node:assert/strict";
import test from "node:test";

import { fetchHosts } from "../src/domain/hosts/index.js";
import { ResponseShapeError } from "../src/platform/http/transport.js";

// The host list against its schema from `contract` (#247).
//
// Until #247 `fetchHosts` cast the response blindly (`request<T>`): a host
// without `status` reached the host card as `undefined`, and nothing turned
// red. These cases hold the transport boundary instead — a broken response
// is an error there, a newer hub with an extra field is not.

function host(overrides = {}) {
  return {
    id: "host-1",
    name: "local-host",
    agentUrl: "http://10.0.0.2:8080",
    kind: "internal",
    state: "registered",
    status: "online",
    agentVersion: "0.31.0",
    tunnelAddress: "10.0.0.2",
    display: { hue: "teal", ink: "head" },
    agentUpdate: { targetVersion: "0.31.0", targetImageRef: "ghcr.io/example/agent:v0.31.0", state: "current" },
    lastSeenAt: "2026-09-30T12:34:56.789Z",
    ...overrides
  };
}

/**
 * A hub that answers every request with `payload`. `run` receives what
 * `console.error` got meanwhile: `parseResponse` logs every shape error, and
 * a test that does not look at it would only clutter the run.
 */
async function withHub(payload, run) {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const logged = [];
  globalThis.fetch = () =>
    Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }));
  console.error = (...args) => {
    logged.push(args);
  };
  try {
    await run(logged);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
}

test("eine vollständige Antwort kommt unverändert an", async () => {
  const payload = { hosts: [host(), host({ id: "host-2", kind: "local", agentUpdate: null, lastSeenAt: null })] };
  await withHub(payload, async (logged) => {
    assert.deepEqual(await fetchHosts(), payload);
    assert.equal(logged.length, 0, "a valid response logs nothing");
  });
});

test("eine Antwort mit fehlendem Pflichtfeld wird als Fehler erkannt, nicht still durchgereicht", async () => {
  const broken = host();
  delete broken.status;
  await withHub({ hosts: [broken] }, async (logged) => {
    let thrown = null;
    await assert.rejects(fetchHosts(), (error) => {
      thrown = error;
      assert.ok(error instanceof ResponseShapeError, `expected ResponseShapeError, got ${String(error)}`);
      assert.match(error.message, /hosts\.0\.status/);
      assert.equal(error.path, "/api/hosts");
      return true;
    });
    // The screens catch every failure alike; the console is where the field
    // name reaches a human.
    assert.equal(logged.length, 1, "the shape error is logged once");
    assert.ok(logged[0][0] === thrown, "the logged value is the thrown error");
  });
});

test("ein fehlendes Feld ist nicht dasselbe wie null", async () => {
  // `lastSeenAt: null` is the answer "never"; a response without the field is
  // a broken one. The route sends the field on every host.
  const missing = host();
  delete missing.lastSeenAt;
  await withHub({ hosts: [missing] }, async () => {
    await assert.rejects(fetchHosts(), ResponseShapeError);
  });
});

test("ein Zeitpunkt, der kein ISO-Zeitpunkt ist, wird als Fehler erkannt", async () => {
  await withHub({ hosts: [host({ lastSeenAt: "gestern" })] }, async () => {
    await assert.rejects(fetchHosts(), ResponseShapeError);
  });
});

test("ein unbekanntes Zusatzfeld bricht die Liste nicht", async () => {
  // Hub and bundle may briefly run different versions — a cached bundle
  // against a newer hub. The field is dropped, the list still loads.
  await withHub({ hosts: [host({ futureField: 42 })] }, async () => {
    const { hosts } = await fetchHosts();
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].status, "online");
    assert.ok(!("futureField" in hosts[0]), "the unknown field is not passed on");
  });
});

test("ein unbekannter Farbton eines neueren Hubs fällt auf die Vorgabe zurück", async () => {
  await withHub({ hosts: [host({ display: { hue: "crimson", ink: "glow" } })] }, async (logged) => {
    const { hosts } = await fetchHosts();
    assert.deepEqual(hosts[0].display, { hue: "neutral", ink: "head" });
    assert.equal(logged.length, 0, "a fallback is not an error");
  });
});

test("ein unlesbares Update-Angebot wird zu keinem Angebot", async () => {
  const offer = { targetVersion: "0.40.0", targetImageRef: "ghcr.io/example/agent:v0.40.0", state: "staged" };
  await withHub({ hosts: [host({ agentUpdate: offer })] }, async () => {
    const { hosts } = await fetchHosts();
    assert.equal(hosts[0].agentUpdate, null);
  });
});

test("ein unbekannter Status bleibt ein Fehler", async () => {
  // No truthful stand-in exists: showing a new status as "offline" would say
  // something the hub never said (`hostStatusSchema`).
  await withHub({ hosts: [host({ status: "degraded" })] }, async () => {
    await assert.rejects(fetchHosts(), ResponseShapeError);
  });
});
