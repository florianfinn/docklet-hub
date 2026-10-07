import { fixture, host, container, button, textButton, click, React, waitFor } from "./lifecycle-test-support.js";
import test from "node:test";
import assert from "node:assert/strict";
const service = (name: string, outcome: "ok" | "failed" | "not-created-externally-managed", status = "running") => ({
  serviceName: name, containerId: `${name}-id`, status, startedAt: null, exitCode: null, health: null, outcome
});
for (const outcome of ["ok", "partial", "failed"] as const) test(`stream ${outcome} displays service progress and the terminal outcome`, async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const f = await fixture({ kind: "stack", current: host([container("created")]), action: () => new Response(new ReadableStream({
    start: (controller) => { stream = controller; }
  }), { headers: { "content-type": "application/x-ndjson" } }) });
  const send = (line: unknown) => stream.enqueue(new TextEncoder().encode(JSON.stringify(line) + "\n"));
  try {
    await click(button("start")); assert.equal(await waitFor(() => Boolean(stream)), true);
    await React.act(async () => { send({ kind: "start", action: "start", projectName: "demo", applyDefinition: true });
      send({ kind: "progress", service: service("web", "ok") }); });
    assert.equal(await waitFor(() => document.body.textContent?.includes("web: running") === true), true);
    assert.equal(document.body.textContent?.includes("Vorgang läuft"), true);
    const services = [service("web", outcome === "failed" ? "failed" : "ok", outcome === "failed" ? "exited" : "running"),
      service("worker", outcome === "ok" ? "ok" : "not-created-externally-managed", outcome === "ok" ? "running" : "missing")];
    await React.act(async () => { send({ kind: "result", status: outcome === "ok" ? 200 : 502,
      body: { ok: outcome === "ok", action: "start", applyDefinition: true, outcome, services, containerIds: { web: "web-id" } } }); stream.close(); });
    assert.equal(await waitFor(() => f.calls.some((call) => call.path.endsWith("/overview"))), true);
    assert.equal(document.body.textContent?.includes(outcome === "ok" ? "Aktion abgeschlossen" : outcome === "partial" ? "teilweise abgeschlossen" : "Aktion fehlgeschlagen"), true);
    if (outcome !== "ok") {
      assert.equal(document.querySelector('[role="status"][aria-live="polite"]') !== null, true);
      assert.equal(document.body.textContent?.includes("nicht erzeugt (fremdverwaltet)"), true);
      assert.equal(document.body.textContent?.includes("Erzeugen gehört dem externen Verwalter"), true);
      await click(textButton("Meldung schließen")); assert.equal(document.querySelector('[role="status"][aria-live="polite"]')?.textContent === '', true);
    }
  } finally { await f.close(); }
});
test("an HTTP failure result retains every service and never shows free diagnostics", async () => {
  const f = await fixture({ kind: "stack", current: host([container("created")]), action: () => Response.json({
    ok: false, action: "start", outcome: "failed", applyDefinition: true,
    services: [service("web", "failed", "exited")], containerIds: {}, error: "compose-action-failed", stderr: "synthetic-private-detail"
  }, { status: 502 }) });
  try {
    await click(button("start")); assert.equal(await waitFor(() => document.body.textContent?.includes("Aktion fehlgeschlagen") === true), true);
    assert.equal(document.body.textContent?.includes("web: exited"), true); assert.equal(document.body.textContent?.includes("synthetic-private-detail"), false);
  } finally { await f.close(); }
});
for (const [error, message] of [
  ["runtime-outcome-unknown", "Ergebnis unbekannt"], ["action-queue-timeout", "keine neue Aktion gestartet"],
  ["runtime-agent-unreachable", "Aktion fehlgeschlagen"], ["runtime-stream-broken", "Ergebnis unbekannt"]
]) test(`${error}: persistent notice and actual state reread`, async () => {
  const f = await fixture({ action: () => Response.json({ error }, { status: 502 }) });
  try {
    await click(button("restart")); assert.equal(await waitFor(() => f.calls.some((call) => call.path.endsWith("/overview"))), true);
    assert.equal(document.body.textContent?.includes(message), true); assert.equal(document.querySelector('[role="status"][aria-live="polite"]') !== null, true);
  } finally { await f.close(); }
});
test("network loss is unknown, not failed, and releases the local lock", async () => {
  const f = await fixture({ action: () => { throw new TypeError("synthetic-private-network-detail"); } });
  try {
    await click(button("stop")); assert.equal(await waitFor(() => document.body.textContent?.includes("Ergebnis unbekannt") === true), true);
    assert.equal(document.body.textContent?.includes("Aktion fehlgeschlagen"), false);
    assert.equal(document.body.textContent?.includes("synthetic-private-network-detail"), false);
    assert.equal(button("stop").getAttribute("aria-disabled"), "false");
  } finally { await f.close(); }
});

test("completion keeps the target locked until its actual state has been read", async () => {
  const f = await fixture(); const fetch = globalThis.fetch;
  let finish = () => {};
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/overview")) await new Promise<void>((resolve) => { finish = resolve; });
    return fetch(input, init);
  };
  try {
    await click(button("stop"));
    assert.equal(await waitFor(() => document.body.textContent?.includes("Aktion abgeschlossen") === true), true);
    assert.equal(button("restart").getAttribute("aria-disabled"), "true");
    await click(button("restart")); assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
    await React.act(async () => { finish(); });
    assert.equal(await waitFor(() => button("restart").getAttribute("aria-disabled") === "false"), true);
  } finally { finish(); await f.close(); }
});

test("a stack only reports waiting after queued, and start resumes service progress", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const f = await fixture({ kind: "stack", current: host([container("created")]), action: () => new Response(new ReadableStream({
    start: (controller) => { stream = controller; }
  }), { headers: { "content-type": "application/x-ndjson" } }) });
  const send = (line: unknown) => stream.enqueue(new TextEncoder().encode(JSON.stringify(line) + "\n"));
  try {
    await click(button("start")); assert.equal(await waitFor(() => Boolean(stream)), true);
    assert.equal(document.body.textContent?.includes("Vorgang läuft"), true);
    assert.equal(document.body.textContent?.includes("wartet auf laufenden Vorgang"), false);
    await React.act(async () => { send({ kind: "queued" }); });
    assert.equal(await waitFor(() => document.body.textContent?.includes("wartet auf laufenden Vorgang") === true), true);
    assert.equal(button("start").getAttribute("aria-disabled"), "true");
    await React.act(async () => { send({ kind: "start", action: "start", projectName: "demo", applyDefinition: true }); });
    assert.equal(await waitFor(() => document.body.textContent?.includes("Vorgang läuft") === true), true);
    assert.equal(document.body.textContent?.includes("wartet auf laufenden Vorgang"), false);
    await React.act(async () => { send({ kind: "result", status: 200, body: { ok: true, action: "start", outcome: "ok",
      applyDefinition: true, services: [service("web", "ok")], containerIds: { web: "web-id" } } }); stream.close(); });
    assert.equal(await waitFor(() => f.calls.some((call) => call.path.endsWith("/overview"))), true);
  } finally { await f.close(); }
});
test("synchronous container progress never claims queue state and retains sanitized 502 state", async () => {
  let answer!: (response: Response) => void;
  const f = await fixture({ action: () => new Promise<Response>((resolve) => { answer = resolve; }) });
  try {
    await click(button("stop"));
    assert.equal(document.body.textContent?.includes("Vorgang läuft"), true);
    assert.equal(document.body.textContent?.includes("wartet auf laufenden Vorgang"), false);
    await React.act(async () => { answer(Response.json({ ok: false, action: "stop", outcome: "failed",
      error: "runtime-target-not-reached", state: { containerId: "demo-web-id", status: "restarting", startedAt: null,
        exitCode: null, health: null }, stderr: "synthetic-private-detail" }, { status: 502 })); });
    assert.equal(await waitFor(() => f.calls.some((call) => call.path.endsWith("/overview"))), true);
    assert.equal(document.body.textContent?.includes("demo-web: restarting"), true);
    assert.equal(document.body.textContent?.includes("synthetic-private-detail"), false);
  } finally { await f.close(); }
});
test("a sent request with unknown outcome reads state and never repeats automatically", async () => {
  const f = await fixture({ action: () => Response.json({ error: "runtime-outcome-unknown" }, { status: 502 }) });
  try {
    await click(button("restart"));
    assert.equal(await waitFor(() => f.calls.some((call) => call.path.endsWith("/overview"))), true);
    assert.equal(document.body.textContent?.includes("Ergebnis unbekannt, Vorgang kann auf dem Host weiterlaufen"), true);
    assert.equal(document.body.textContent?.includes("Aktion fehlgeschlagen"), false);
    assert.equal(document.body.textContent?.includes("Die Aktion wurde abgelehnt"), false);
    assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
  } finally { await f.close(); }
});

test("the polite status region exists before the first action and retains its identity", async () => {
  const f = await fixture();
  try {
    const region = document.querySelector('[role="status"][aria-live="polite"]');
    assert.equal(region !== null, true);
    assert.equal(region?.textContent, "");
    await click(button("stop"));
    assert.equal(await waitFor(() => region?.textContent?.includes("Aktion abgeschlossen") === true), true);
    assert.equal(document.querySelector('[role="status"][aria-live="polite"]') === region, true);
    assert.equal(document.querySelector('[role="alert"][aria-live="polite"]') === null, true);
  } finally { await f.close(); }
});
