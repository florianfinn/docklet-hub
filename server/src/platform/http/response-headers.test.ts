import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";

import { NO_STORE_VALUE, SECURITY_HEADERS, createNoStoreHeader, createSecurityHeaders } from "./response-headers.js";
import { listenOnFetchablePort } from "../testing/port-test-support.js";

// Die Sicherheitsköpfe aus #133 — über echte Anfragen an einen Aufbau wie in
// `index.ts`, und dazu ein Blick in `index.ts` selbst: eine richtige Schicht,
// die dort nie eingehängt wird, fiele sonst keinem Fall hier auf.

async function stack(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.use(createSecurityHeaders());
  app.use("/api", createNoStoreHeader());
  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });
  app.get("/api/users", (_request, response) => {
    response.json({ users: [] });
  });
  // Ein Download in der Form von `api/routes/file-routes.ts`: Bytes als
  // `application/octet-stream` mit `attachment`. Gerade dort zählt `nosniff`.
  app.get("/api/file", (_request, response) => {
    response.setHeader("content-type", "application/octet-stream");
    response.setHeader("content-disposition", `attachment; filename="a.html"`);
    response.end("<script>alert(1)</script>");
  });
  // Eine Route mit eigenem `Cache-Control`, wie die Ströme in
  // `api/stream-response.ts`: ihr Wert gewinnt.
  app.get("/api/stream", (_request, response) => {
    response.setHeader("cache-control", "no-store, no-transform");
    response.end("");
  });

  const server = http.createServer(app);
  await listenOnFetchablePort(server);
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

function assertSecurityHeaders(response: Response, where: string): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(response.headers.get(name), value, `${name} fehlt oder weicht ab: ${where}`);
  }
}

test("eine reguläre API-Antwort trägt die drei Köpfe und no-store", async () => {
  const running = await stack();
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/api/users`);
    assert.equal(response.status, 200);
    assertSecurityHeaders(response, "/api/users");
    assert.equal(response.headers.get("cache-control"), NO_STORE_VALUE);
  } finally {
    await running.close();
  }
});

test("ein Download trägt nosniff und no-store", async () => {
  const running = await stack();
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/api/file`);
    assert.equal(response.status, 200);
    assertSecurityHeaders(response, "/api/file");
    assert.equal(response.headers.get("cache-control"), NO_STORE_VALUE);
    await response.text();
  } finally {
    await running.close();
  }
});

test("außerhalb von /api gibt es die drei Köpfe, aber kein no-store", async () => {
  const running = await stack();
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/health`);
    assertSecurityHeaders(response, "/health");
    assert.equal(response.headers.get("cache-control"), null);
  } finally {
    await running.close();
  }
});

test("eine Route mit eigenem Cache-Control behält ihren Wert", async () => {
  const running = await stack();
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/api/stream`);
    assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
  } finally {
    await running.close();
  }
});

test("index.ts hängt beide Schichten ein, und zwar vor dem Anmeldeweg", () => {
  const source = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
  const security = source.indexOf("app.use(createSecurityHeaders());");
  const noStore = source.indexOf('app.use("/api", createNoStoreHeader());');
  const auth = source.indexOf('app.all("/api/auth/*splat", toNodeHandler(auth));');
  assert.ok(security > 0, "createSecurityHeaders ist in index.ts nicht eingehängt");
  assert.ok(noStore > 0, "createNoStoreHeader ist in index.ts nicht unter /api eingehängt");
  assert.ok(auth > 0, "der Anmeldeweg ist in index.ts nicht zu finden");
  assert.ok(security < auth && noStore < auth, "beide Schichten müssen vor dem Anmeldeweg stehen");
});
