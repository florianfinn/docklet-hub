import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";
import type { Pool } from "pg";

import { createApiRouter } from "./router.js";
import type { Auth } from "../platform/auth/auth.js";
import type { Enrollment } from "../features/hosts/index.js";
import type { HostRepository } from "../domain/hosts/index.js";
import { NON_PAGE_PREFIXES, createIndexFallback, servesIndexHtml } from "../platform/http/index-fallback.js";
import { listenOnFetchablePort } from "../platform/testing/port-test-support.js";

// Der Rückfall auf `index.html` — die vier Bedingungen einzeln und dann
// dieselben vier über echte Anfragen.
//
// Was hier fällt, wenn der Rückfall zu breit gebaut ist:
//
//   1. `/containers` bekommt 404 statt der Anwendung — der Grund, warum es
//      ihn gibt (D6b, Router in der Oberfläche).
//   2. `/api/gibtsnicht` bekommt HTML statt eines 404 als JSON. Das ist der
//      teure Fall: ein `fetch`, das auf `response.ok` prüft, sähe eine
//      erfolgreiche Antwort, und der Parserfehler stünde weit weg von der
//      Ursache.
//   3. `/assets/fehlt.js` bekommt HTML statt eines 404 — ein fehlendes
//      Bündel zeigte sich dann im Browser als Syntaxfehler in einer
//      JavaScript-Datei.
//   4. Ein `POST` auf einen unbekannten Pfad bekommt eine Seite statt einer
//      Ablehnung.
//
// Der Aufbau ist der aus `server/src/index.ts`: `express.static` über einem
// echten Verzeichnis, dahinter dieser Rückfall, und davor der echte Router
// unter `/api`.

test("nur GET und HEAD kommen als Seite in Frage", () => {
  assert.equal(servesIndexHtml("GET", "/containers"), true);
  assert.equal(servesIndexHtml("HEAD", "/containers"), true);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.equal(servesIndexHtml(method, "/containers"), false, `${method} darf keine Seite bekommen`);
  }
});

test("die ausgelassenen Präfixe sind genau die, die JSON antworten", () => {
  assert.deepEqual([...NON_PAGE_PREFIXES], ["/api", "/health"]);
  for (const path of ["/api", "/api/hosts", "/api/gibtsnicht", "/api/auth/sign-in/email", "/health", "/health/tief"]) {
    assert.equal(servesIndexHtml("GET", path), false, `${path} ist keine Seite`);
  }
  // Ein Präfix ist ein Pfadsegment und keine Zeichenkette: `/apixyz` gehört
  // nicht zur API und ist eine ganz gewöhnliche Adresse der Oberfläche.
  assert.equal(servesIndexHtml("GET", "/apixyz"), true);
  assert.equal(servesIndexHtml("GET", "/healthcheck"), true);
});

test("eine Datei mit Endung bleibt 404", () => {
  assert.equal(servesIndexHtml("GET", "/foo.js"), false);
  assert.equal(servesIndexHtml("GET", "/assets/index-a1b2.js"), false);
  assert.equal(servesIndexHtml("GET", "/favicon.ico"), false);
  // Gezählt wird nur das LETZTE Segment: ein Punkt weiter vorn im Pfad macht
  // aus einer Seite keine Datei.
  assert.equal(servesIndexHtml("GET", "/v1.2/settings"), true);
});

test("die Wurzel und die Wege des Routers sind Seiten", () => {
  assert.equal(servesIndexHtml("GET", "/"), true);
  assert.equal(servesIndexHtml("GET", "/containers"), true);
  assert.equal(servesIndexHtml("GET", "/hosts/local-host/containers"), true);
  assert.equal(servesIndexHtml("GET", "/users"), true);
});

// ── Dieselben Bedingungen über echte Anfragen ───────────────────────────────

const NO_POOL = {
  query: () => {
    throw new Error("Dieser Test fasst keine Datenbank an.");
  }
} as unknown as Pool;

function webRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "hub-web-"));
  writeFileSync(join(directory, "index.html"), "<!doctype html><title>Hub</title>", "utf8");
  mkdirSync(join(directory, "assets"));
  writeFileSync(join(directory, "assets", "index-a1b2.js"), "export const marke = 1;\n", "utf8");
  return directory;
}

async function stack(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(
    "/api",
    createApiRouter({
      auth: {} as unknown as Auth,
      pool: NO_POOL,
      repository: {} as unknown as HostRepository,
      enrollment: {} as unknown as Enrollment,
      agentSecret: "unbenutzt",
      config: { wireguardEndpoint: "hub.test", wireguardPort: 51821 }
    })
  );
  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });
  const root = webRoot();
  app.use(express.static(root));
  app.use(createIndexFallback(root));

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

async function call(
  port: number,
  path: string,
  method = "GET"
): Promise<{ status: number; type: string; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  return {
    status: response.status,
    type: response.headers.get("content-type") ?? "",
    text: await response.text()
  };
}

test("ein Weg des Routers bekommt die Anwendung, eine echte Datei sich selbst", async () => {
  const running = await stack();
  try {
    const page = await call(running.port, "/containers");
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(page.text, /<title>Hub<\/title>/);

    const root = await call(running.port, "/");
    assert.equal(root.status, 200);
    assert.match(root.text, /<title>Hub<\/title>/);

    // Was es als Datei gibt, kommt weiterhin als Datei — der Rückfall steht
    // hinter `express.static` und nicht davor.
    const bundle = await call(running.port, "/assets/index-a1b2.js");
    assert.equal(bundle.status, 200);
    assert.match(bundle.text, /export const marke/);
  } finally {
    await running.close();
  }
});

test("eine unbekannte API-Route bleibt ein 404 als JSON", async () => {
  const running = await stack();
  try {
    const unknown = await call(running.port, "/api/gibtsnicht");
    assert.equal(unknown.status, 404);
    assert.match(unknown.type, /application\/json/);
    assert.deepEqual(JSON.parse(unknown.text), { error: "not-found" });
    assert.doesNotMatch(unknown.text, /<title>Hub<\/title>/);
  } finally {
    await running.close();
  }
});

test("eine fehlende Datei mit Endung bleibt ein 404", async () => {
  const running = await stack();
  try {
    const missing = await call(running.port, "/assets/fehlt.js");
    assert.equal(missing.status, 404);
    assert.doesNotMatch(missing.text, /<title>Hub<\/title>/);
  } finally {
    await running.close();
  }
});

test("ein POST auf einen unbekannten Pfad bekommt keine Seite", async () => {
  const running = await stack();
  try {
    const written = await call(running.port, "/containers", "POST");
    assert.equal(written.status, 404);
    assert.doesNotMatch(written.text, /<title>Hub<\/title>/);
  } finally {
    await running.close();
  }
});
