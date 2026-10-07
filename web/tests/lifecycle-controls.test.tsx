import { fixture, container, host, button, textButton, click, press, React, waitFor, settle } from "./lifecycle-test-support.js";
import test from "node:test";
import assert from "node:assert/strict";

for (const status of ["running", "paused", "restarting", "created", "exited", "dead", "removing", "unknown"]) {
  test(`rendered ${status} buttons and their accessible descriptions match the contract`, async () => {
    const f = await fixture({ current: host([container(status)]) });
    try {
      const running = ["running", "paused", "restarting"].includes(status);
      const invalid = ["dead", "removing", "unknown"].includes(status);
      for (const action of ["start", "stop", "restart"]) {
        const control = button(action);
        assert.equal(control.getAttribute("aria-disabled"), String(invalid || (action === "start" ? running : !running)));
        assert.equal(control.className.includes("min-h-11"), true);
        await React.act(async () => { control.focus(); }); assert.equal(document.activeElement === control, true);
        if (invalid) {
          const described = document.getElementById(control.getAttribute("aria-describedby")!);
          assert.equal(described?.textContent?.includes("Containerzustand"), true); assert.equal(described?.className.includes("sr-only"), false);
        }
      }
      if (status === "restarting") assert.equal(document.body.textContent?.includes("startet wiederholt neu"), true);
    } finally { await f.close(); }
  });
}
for (const [reason, change] of [
  ["Host offline", (h: ReturnType<typeof host>) => { h.host.status = "offline"; }],
  ["Nur-Lese-Modus", (h: ReturnType<typeof host>) => { h.agent = { reachable: true, readOnly: true, version: "0.32.0", contractVersion: 12, entries: 1 }; }],
  ["zur Beobachtung", (h: ReturnType<typeof host>) => { h.stacks[0].containers[0].runtimeAccess = { blocker: "observe-only" }; }],
  ["nicht in der Allowlist", (h: ReturnType<typeof host>) => { h.stacks[0].containers[0].runtimeAccess = { blocker: "not-allowlisted" }; }],
  ["Selbstverwaltungssperre", (h: ReturnType<typeof host>) => { h.stacks[0].containers[0].system = true; }],
  ["Fähigkeit", (h: ReturnType<typeof host>) => { delete h.stacks[0].containers[0].runtimeAccess; }]
] as const) test(`visible blocker: ${reason} prevents any request`, async () => {
  const current = host(); change(current);
  const f = await fixture({ current });
  try {
    assert.equal(document.body.textContent?.includes(reason), true); await click(button("stop")); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
test("readers see the disabled actions and their role reason", async () => {
  const f = await fixture({ role: "user" });
  try { assert.equal(document.body.textContent?.includes("Nur Administratoren"), true); await click(button("restart")); assert.equal(f.calls.length, 0); }
  finally { await f.close(); }
});
for (const action of ["start", "stop", "restart"]) test(`container ${action} runs without confirmation and reads actual state`, async () => {
  const f = await fixture({ current: host([container(action === "start" ? "exited" : "running")]) });
  try {
    await click(button(action)); assert.equal(document.querySelector('[role="dialog"]') === null, true);
    assert.equal(await waitFor(() => f.calls.some((call) => call.path.endsWith("/overview"))), true);
    assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(document.body.textContent?.includes("Aktion abgeschlossen"), true);
    const body = f.calls.find((call) => call.method === "POST")!.body as { expectedContainer: { containerId: string; status: string } };
    assert.equal(body.expectedContainer.containerId, "demo-web-id");
    assert.equal(body.expectedContainer.status, action === "start" ? "exited" : "running");
  } finally { await f.close(); }
});
test("double clicks and a second rendering of the same target share an immediate lock", async () => {
  let resolve!: (response: Response) => void;
  const response = new Promise<Response>((done) => { resolve = done; });
  const f = await fixture({ copies: 2, action: () => response });
  try {
    await React.act(async () => { button("stop").click(); button("stop").click(); button("restart", 1).click(); }); await settle();
    assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(button("restart", 1).getAttribute("aria-disabled"), "true");
    assert.equal(document.body.textContent?.includes("Vorgang läuft"), true);
    assert.equal(document.body.textContent?.includes("wartet auf laufenden Vorgang"), false);
    resolve(Response.json({ ok: true, action: "stop", outcome: "ok", state: { containerId: "demo-web-id", status: "exited", startedAt: null, exitCode: 0, health: null } }));
    await waitFor(() => f.calls.some((call) => call.path.endsWith("/overview")));
  } finally {
    resolve(Response.json({ error: "runtime-outcome-unknown" }, { status: 502 }));
    await f.close();
  }
});
for (const mode of [true, false]) for (const owned of [true, false]) test(`stack mode ${mode}, ownership ${owned}: labels reflect only the effective stack mode`, async () => {
  const current = host([container("running"), container("exited", { id: "db-id", name: "demo-db", compose: { project: "demo", service: "db" }, exitCode: 1 })]);
  current.lifecycle!.applyDefinition = mode; current.stacks[0].hubOwned = owned;
  const f = await fixture({ kind: "stack", current });
  try {
    assert.equal(button("start").textContent, mode && owned ? "Start · Definition anwenden" : "Start");
    assert.equal(button("restart").textContent, mode && owned ? "Neustart · neu erstellen" : "Neustart");
    await click(button("restart"));
    assert.equal(await waitFor(() => document.querySelector('[role="dialog"]') !== null), true);
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.equal(dialog.textContent?.includes("web: running"), true); assert.equal(dialog.textContent?.includes("db: exited"), true);
    assert.equal(dialog.textContent?.includes("Volumes und Bind-Mounts bleiben erhalten"), mode && owned);
    assert.equal(f.calls.some((call) => call.method === "POST"), false);
    await click(textButton("Jetzt ausführen", dialog));
    assert.equal(await waitFor(() => f.calls.some((call) => call.method === "POST")), true);
  } finally { await f.close(); }
});
test("stack Stop asks, Escape cancels, Start applies definition without a question", async () => {
  const f = await fixture({ kind: "stack", current: host([container("running"), container("created", { id: "db-id", name: "demo-db", compose: { project: "demo", service: "db" } })]) });
  try {
    await click(button("stop")); assert.equal(await waitFor(() => document.querySelector('[role="dialog"]') !== null), true);
    const dialog = document.querySelector('[role="dialog"]')!;
    await press(dialog, "Escape"); assert.equal(await waitFor(() => document.querySelector('[role="dialog"]') === null), true);
    assert.equal(f.calls.some((call) => call.method === "POST"), false);
    await click(button("start"));
    assert.equal(await waitFor(() => f.calls.some((call) => call.method === "POST")), true);
    assert.equal(document.querySelector('[role="dialog"]') === null, true);
  } finally { await f.close(); }
});
test("state-changed reloads then asks again even for a container; it never repeats automatically", async () => {
  let posts = 0;
  const current = host();
  const f = await fixture({ current, action: () => {
    posts++;
    return posts === 1 ? Response.json({ error: "state-changed" }, { status: 409 }) : Response.json({ ok: true, action: "restart", outcome: "ok", state: { containerId: "demo-web-id", status: "running", startedAt: null, exitCode: null, health: null } });
  } });
  try {
    f.state.host = host([container("restarting", { startedAt: "2026-10-07T02:00:00Z" })]);
    await click(button("restart"));
    assert.equal(await waitFor(() => document.querySelector('[role="dialog"]') !== null), true);
    assert.equal(posts, 1); assert.equal(document.body.textContent?.includes("erneut bestätigen"), true);
    assert.equal(document.querySelector('[role="dialog"]')?.textContent?.includes("restarting"), true);
    await click(textButton("Jetzt ausführen")); assert.equal(await waitFor(() => posts === 2), true);
    const sent = f.calls.filter((call) => call.method === "POST").at(-1)!.body as { expectedContainer: { status: string } };
    assert.equal(sent.expectedContainer.status, "restarting");
  } finally { await f.close(); }
});
test("StrictMode does not dispose the active session before its first action", async () => {
  const f = await fixture({ strict: true });
  try { await click(button("stop")); assert.equal(await waitFor(() => f.calls.some((call) => call.method === "POST")), true); }
  finally { await f.close(); }
});
