import test from "node:test";
import assert from "node:assert/strict";

import { ACTOR_HEADER, SECRET_HEADER } from "contract";

import { startAgent } from "./agent-roundtrip-test-support.js";

// The agent's real dispatcher (#152): no request needs a network tier header,
// and one that still carries it is answered exactly like one without it.

type Answer = { status: number; body: unknown };

async function ask(base: string, secret: string, pathname: string, extra: Record<string, string> = {}): Promise<Answer> {
  const response = await fetch(`${base}${pathname}`, {
    headers: { [SECRET_HEADER]: secret, [ACTOR_HEADER]: "system:hub", accept: "application/json", ...extra }
  });
  return { status: response.status, body: await response.json() };
}

test("ohne Netzstufe angenommen, eine gesendete Netzstufe wird ignoriert, monitor-events bleibt gebunden", async (t) => {
  const agent = await startAgent();
  t.after(agent.stop);
  const { baseUrl, secret } = agent.target;

  for (const pathname of ["/contract", "/containers", "/monitors", "/self-update"]) {
    const without = await ask(baseUrl, secret, pathname);
    assert.equal(without.status, 200, pathname);
    for (const tier of ["internal", "external", "bogus"]) {
      const withHeader = await ask(baseUrl, secret, pathname, { "x-docker-agent-tier": tier });
      assert.deepEqual(withHeader, without, `${pathname} with tier ${tier}`);
    }
  }

  const contract = (await ask(baseUrl, secret, "/contract")).body as Record<string, unknown>;
  assert.deepEqual(contract.headers, { secret: SECRET_HEADER, actor: ACTOR_HEADER });
  assert.equal("tiers" in contract, false);

  // The one route bound to a caller: anyone else gets 403 before a stream opens.
  const foreign = await ask(baseUrl, secret, "/monitor-events", { [ACTOR_HEADER]: "user:u-1" });
  assert.deepEqual(foreign, { status: 403, body: { error: "actor-not-allowed" } });
});
