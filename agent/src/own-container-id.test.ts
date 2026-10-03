import assert from "node:assert/strict";
import test from "node:test";
import { carriesSecret, pickOwnContainerId } from "./own-container-id.js";

const SECRET = "s".repeat(48);

// The situation on remote-host on 2026-08-26: the agent hangs via `network_mode:
// container:<X>` in the netns of the WireGuard sidecar and inherits its
// `/etc/hostname`. The hostname thus points to the sidecar — and exactly that
// one is what the watcher then swapped.
const SIDECAR = { id: "a1e99766d0ae".padEnd(64, "0"), envLines: ["PATH=/usr/bin"] };
const AGENT = {
  id: "a44aa070103f".padEnd(64, "0"),
  envLines: ["PATH=/usr/bin", `DOCKER_AGENT_SECRET=${SECRET}`, "DOCKER_AGENT_PORT=8099"]
};

test("finds the agent even when the hostname points to the netns provider", () => {
  assert.deepEqual(pickOwnContainerId([SIDECAR, AGENT], SECRET), {
    id: AGENT.id,
    reason: "verified"
  });
});

test("without a match the id stays null instead of guessing", () => {
  // Fail closed: self-update and self-protection then refuse. Exactly that was
  // already stated as the intent in the comment of the old HOSTNAME line — it
  // just could not detect the case.
  assert.deepEqual(pickOwnContainerId([SIDECAR], SECRET), {
    id: null,
    reason: "unverifiable"
  });
});

test("two matches are no answer", () => {
  // Two containers with the same secret can be two agents — or a copy someone
  // placed next to it for testing. In both cases the choice would be a
  // guess.
  assert.deepEqual(pickOwnContainerId([AGENT, { ...AGENT, id: "b".repeat(64) }], SECRET), {
    id: null,
    reason: "ambiguous"
  });
});

test("an empty secret confirms nothing", () => {
  assert.deepEqual(pickOwnContainerId([AGENT], ""), { id: null, reason: "unverifiable" });
});

test("only the first = separates — a secret may contain =", () => {
  // Base64 padding. A `split("=")[1]` would cut off here, the check would fail
  // for the right container, and the agent would consider itself unknown:
  // fail closed, but for the wrong reason.
  const withSame = `${"x".repeat(43)}==`;
  assert.equal(carriesSecret([`DOCKER_AGENT_SECRET=${withSame}`], withSame), true);
});

test("a different variable name with the same value does not count", () => {
  assert.equal(carriesSecret([`DOCKER_AGENT_SECRET_ALT=${SECRET}`], SECRET), false);
  assert.equal(carriesSecret([`FREMD=${SECRET}`], SECRET), false);
});

test("a prefix of the secret is not enough", () => {
  assert.equal(carriesSecret([`DOCKER_AGENT_SECRET=${SECRET.slice(0, 20)}`], SECRET), false);
});
