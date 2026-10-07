import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import type { Auth } from "../../platform/auth/auth.js";
import { listenOnFetchablePort } from "../../platform/testing/port-test-support.js";
import { registerRuntimeActionsRoutes, type RuntimeActionsRouteOptions } from "./routes.js";

test("unknown actions reach later container and stack routes after the admin guard", async (t) => {
  const app = express();
  const router = express.Router();
  let sessions = 0;
  let signedIn = true;
  registerRuntimeActionsRoutes(router, {
    auth: { api: { getSession: async () => {
      sessions++;
      return signedIn ? { user: { id: "human", name: "Demo", email: "demo@example.org", role: "admin" } } : null;
    } } } as unknown as Auth,
    pool: {} as never, repository: {} as never, agentSecret: "synthetic", readApplyDefinition: async () => true
  } satisfies RuntimeActionsRouteOptions);
  router.post("/hosts/:hostId/containers/:containerId/update", (_request, response) => response.json({ route: "update" }));
  router.post("/hosts/:hostId/stacks/:containerId/actions/apply", (_request, response) => response.json({ route: "apply" }));
  app.use(router);
  const server = http.createServer(app);
  await listenOnFetchablePort(server);
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hosts/demo`;
  for (const [path, route] of [["containers/demo/update", "update"], ["stacks/demo/actions/apply", "apply"]]) {
    const response = await fetch(`${url}/${path}`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { route });
  }
  assert.equal(sessions, 2);
  signedIn = false;
  assert.equal((await fetch(`${url}/containers/demo/start`, { method: "POST" })).status, 401);
  assert.equal(sessions, 3);
});
