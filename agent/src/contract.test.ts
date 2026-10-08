import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AGENT_CONTRACT, CONTRACT_VERSION } from "./contract.js";
import { REGISTRY_COMPOSE_ORIGINS } from "./registry.js";
import { ROUTES } from "./route-policy.js";
import { emittedNdjsonKinds } from "./ndjson-kind-test-support.js";
import { handlerSources } from "./handler-source-test-support.js";

test("die Vertragsauskunft liest die aktive Routen- und Registry-Politik", () => {
  assert.deepEqual(AGENT_CONTRACT.routes, ROUTES);
  assert.deepEqual(AGENT_CONTRACT.registry.composeOrigins, REGISTRY_COMPOSE_ORIGINS);
  assert.equal(AGENT_CONTRACT.registry.entryFields.observeOnly, "optional");
  assert.equal(AGENT_CONTRACT.registry.entryFields.externallyManaged, "optional");
  assert.ok(AGENT_CONTRACT.errors.sharedHttp.some((entry) => entry.status === 403 && entry.code === "externally-managed"));
  assert.ok(AGENT_CONTRACT.errors.sharedHttp.some((entry) => entry.status === 403 && entry.code === "observe-only"));
  assert.equal(AGENT_CONTRACT.contractVersion, CONTRACT_VERSION);
  assert.deepEqual(AGENT_CONTRACT.routes.filter((route) => route.public === true)
    .map((route) => route.pattern), ["/health"]);
  assert.deepEqual(Object.keys(AGENT_CONTRACT.headers).sort(), ["actor", "secret"]);
  assert.equal("tiers" in AGENT_CONTRACT, false);
  assert.ok(AGENT_CONTRACT.routes.every((route) => !("tier" in route)));
  assert.ok(AGENT_CONTRACT.errors.sharedHttp.some((entry) => entry.status === 403 && entry.code === "actor-not-allowed"));
});

test("jede im Handler gesendete NDJSON-Art steht in der Vertragsauskunft", () => {
  const actual = [...new Set(handlerSources().flatMap(({ text }) => emittedNdjsonKinds(text)))].sort();
  const listed = [...new Set(Object.values(AGENT_CONTRACT.ndjsonKinds).flat())].sort();
  assert.deepEqual(listed, actual);
});

test("a changed contract needs a new contract number", () => {
  // Published contract changes need a new number. Coordinated changes share
  // the current unreleased version and its complete fingerprint.
  const hashes: Record<number, string> = {
    1: "fecdb3b4d12dbd31d6de36de743409b1dfde5a1b3dc9f11ecf5672b94557a873",
    2: "7aa61d5e42bb8ceb10c070eeb3299da7d1f92090de5e7dacd0fd7d5b534da3b4",
    3: "4f170c6e11ccc9b3eeebcb41a37da86368ebddfadffde3ed8d95a7df0a99d61c",
    4: "876f559abbc99460d03cfa7f8e90447387c1540607d8ce93ca6eb027d8814eee",
    5: "5be90d1f348db59e26163c6a57bd2130d4fc6b2b15d9727e1b13a171319aa1f2",
    6: "d78606e05aa33d0ea6f4df8fdbc049328546cddfdc1f2d2d3a72afa2eea17843",
    7: "5edd3eb74a69cbcc57125b269616acbb3b558e3442699043d956a37cecc46676",
    8: "acc30e178edd0b6862f3e59188e630184fefbe1bf9eab67bb6bfc9b18e2e64e1",
    9: "316edce52066f64f7ad6d774ca40a68bc16d8321f3400741ada74c5aeb2b69b6",
    10: "14858fa82db200035630dc67291bc686be0d6c3961cded9ec4d6fab926deafe2",
    11: "131c3b084c20c29860f2b9647732c2e4d90756f7c2725a4b7465fb5940ac605b",
    12: "885de46da8d7fa553c8608d95124fd154fba1e2773935c03dbfa64599b798505",
    13: "8dc39161db34646280f75dcc102a9a2602a0c5f1675b314fb5622770bcb712e6"
  };
  const actual = createHash("sha256").update(JSON.stringify(AGENT_CONTRACT)).digest("hex");
  assert.equal(actual, hashes[CONTRACT_VERSION]);
});

test("NDJSON guard distinguishes target kinds and rejects unknown or unresolved emitted kinds", () => {
  const source = 'const target = { kind: "container" }; const stack = { kind: "compose" }; sendLine(response, { kind: "start" } satisfies StreamLine);';
  assert.deepEqual(emittedNdjsonKinds(source), ["start"]);
  const listed = [...new Set(Object.values(AGENT_CONTRACT.ndjsonKinds).flat())];
  assert.equal(emittedNdjsonKinds('sendLine(response, { kind: "unknown-stream-kind" })').every((kind) => listed.includes(kind)), false);
  assert.deepEqual(emittedNdjsonKinds('import { sendLine as emit } from "./http.js"; emit(response, { kind: "unknown-stream-kind" })'), ["unknown-stream-kind"]);
  assert.deepEqual(emittedNdjsonKinds('http["sendLine"](response, { kind: "unknown-stream-kind" })'), ["unknown-stream-kind"]);
  for (const expression of ['{ kind: value }', 'payload', '{ ...payload }']) assert.throws(() => emittedNdjsonKinds(`sendLine(response, ${expression})`), /Unresolved/);
});
