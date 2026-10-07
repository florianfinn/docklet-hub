import { fixture, host, container, button, textButton, click, press, React, waitFor } from "./lifecycle-test-support.js";
import test from "node:test";
import assert from "node:assert/strict";
import type { SelfHealingIncident } from "contract";
const target = { kind: "compose" as const, projectName: "demo", serviceName: "web" };
const incident: SelfHealingIncident = { id: "demo-incident", target, containerId: "demo-web-id", openedAt: "2026-10-07T01:30:00Z",
  closedAt: null, closedReason: null, cause: { exitCode: 1, engineError: "Example failure" },
  attempts: [{ attempt: 1, startedAt: "2026-10-07T01:20:00Z", finishedAt: "2026-10-07T01:21:00Z", result: "failed", error: "engine-action-failed" }],
  recommendation: "inspect-container-logs-and-configuration", logs: { available: true, lines: ["Example redacted log"] } };

test("manual stop uses stable service identity, timestamp and actor; a known crash is distinct", async () => {
  const current = host([container("exited", { exitCode: 137 })]);
  current.lifecycle!.stopIntents!.intents = [{ target, containerId: "previous-id", stoppedAt: "2026-10-07T01:15:00Z", actor: "user:demo-human" }];
  const f = await fixture({ current });
  try {
    assert.equal(document.body.textContent?.includes("manuell gestoppt"), true); assert.equal(document.body.textContent?.includes("user:demo-human"), true);
    assert.equal(document.body.textContent?.includes("abgestürzt"), false);
    const next = host([container("exited", { exitCode: 1 })]); await f.update(next);
    assert.equal(document.body.textContent?.includes("abgestürzt · Exit-Code 1"), true);
    next.lifecycle!.stopIntents = null; await f.update({ ...next });
    assert.equal(document.body.textContent?.includes("Stopp-Absicht unbekannt"), true); assert.equal(document.body.textContent?.includes("abgestürzt"), false);
  } finally { await f.close(); }
});
test("known successful one-shot completion is never shown as a crash", async () => {
  const f = await fixture({ current: host([container("exited", { exitCode: 0 })]) });
  try { assert.equal(document.body.textContent?.includes("abgestürzt"), false); assert.equal(button("start").getAttribute("aria-disabled"), "false"); }
  finally { await f.close(); }
});
for (const duration of [null, 7200]) test(`maintenance uses the configured default ${duration}, supports keyboard duration choice and DELETE`, async () => {
  const current = host(); current.lifecycle!.maintenanceDurationSeconds = duration;
  const f = await fixture({ current, detail: true });
  try {
    await click(textButton("Wartung einschalten"));
    assert.equal(await waitFor(() => document.querySelector('[role="dialog"]') !== null), true);
    const select = document.querySelector<HTMLElement>('[role="combobox"]')!;
    assert.equal(select.textContent?.includes(duration === null ? "unbegrenzt" : "120 Minuten"), true);
    await React.act(async () => select.focus()); await press(select, "ArrowDown");
    assert.equal(await waitFor(() => document.querySelector('[role="listbox"]') !== null), true);
    await press(document.activeElement!, "End"); await press(document.activeElement!, "Enter");
    assert.equal(document.querySelector('[role="listbox"]') === null, true);
    await click(textButton("Wartung einschalten", document.querySelector('[role="dialog"]')!));
    assert.equal(await waitFor(() => f.calls.some((call) => call.method === "PUT")), true);
    const sent = f.calls.find((call) => call.method === "PUT")!.body as { target: unknown; durationSeconds: number | null };
    assert.equal(sent.durationSeconds, null); assert.deepEqual(sent.target, target);
    const active = host(); active.lifecycle!.selfHealing!.maintenance = [{ target, actor: "user:demo-human", startedAt: "2026-10-07T01:00:00Z", expiresAt: null }];
    await f.update(active); assert.equal(document.body.textContent?.includes("Wartung unbegrenzt"), true);
    await click(textButton("Wartung ausschalten")); assert.equal(await waitFor(() => f.calls.some((call) => call.method === "DELETE")), true);
    assert.deepEqual(f.calls.find((call) => call.method === "DELETE")!.body, { target });
  } finally { await f.close(); }
});
test("enabling maintenance without choosing a duration sends the current setting", async () => {
  const f = await fixture({ detail: true });
  try {
    await click(textButton("Wartung einschalten")); await click(textButton("Wartung einschalten", document.querySelector('[role="dialog"]')!));
    assert.equal(await waitFor(() => f.calls.some((call) => call.method === "PUT")), true);
    assert.equal((f.calls.find((call) => call.method === "PUT")!.body as { durationSeconds: number }).durationSeconds, 7200);
  } finally { await f.close(); }
});
test("row maintenance is reachable in its keyboard menu; inherited maintenance names the stack", async () => {
  const current = host(); current.lifecycle!.selfHealing!.maintenance = [{ target: { kind: "stack", projectName: "demo" }, actor: "user:demo-human", startedAt: "2026-10-07T01:00:00Z", expiresAt: "2099-10-07T04:00:00Z" }];
  const f = await fixture({ current });
  try {
    assert.equal(document.body.textContent?.includes("Wartung bis"), true); assert.equal(document.body.textContent?.includes("vom Stack übernommen"), true);
    const trigger = textButton("Wartung"); await React.act(async () => trigger.focus()); await press(trigger, "Enter");
    assert.equal(await waitFor(() => document.querySelector('[role="menu"]') !== null), true);
    assert.equal(document.querySelector('[role="menuitem"]')?.textContent, "Wartung einschalten");
    await press(document.activeElement!, "Escape");
  } finally { await f.close(); }
});
for (const available of [true, false]) test(`incident ${available ? "with logs" : "without redaction"} shows cause, attempts, recommendation and acknowledgement`, async () => {
  const current = host([container("exited", { exitCode: 1 })]);
  current.lifecycle!.selfHealing!.incidents = [{ ...incident, logs: available ? incident.logs : { available: false, reason: "redaction-unavailable" } }];
  const f = await fixture({ current });
  try {
    assert.equal(document.body.textContent?.includes("Offener Selbstheilungsvorfall"), true);
    assert.equal(document.body.textContent?.includes("Exit-Code 1 · Example failure"), true);
    assert.equal(document.body.textContent?.includes("Versuche: 1"), true);
    assert.equal(document.body.textContent?.includes("Container-Logs und Konfiguration prüfen"), true);
    assert.equal(document.body.textContent?.includes(available ? "Example redacted log" : "Bereinigung nicht verfügbar"), true);
    const details = document.querySelector('details')!; details.open = true;
    await click(textButton("Vorfall quittieren")); assert.equal(await waitFor(() => f.calls.some((call) => call.path.endsWith("/acknowledge"))), true);
    assert.deepEqual(f.calls.find((call) => call.path.endsWith("/acknowledge"))!.body, { target });
    assert.equal(f.calls.some((call) => call.path.endsWith("/start")), false);
    assert.equal(f.calls.some((call) => call.path.endsWith("/overview")), true);
  } finally { await f.close(); }
});
test("agent-removed maintenance and closed incidents are not shown as active", async () => {
  const current = host(); current.lifecycle!.selfHealing!.maintenance = [];
  current.lifecycle!.selfHealing!.incidents = [{ ...incident, closedAt: "2026-10-07T01:35:00Z", closedReason: "acknowledged" }];
  const f = await fixture({ current, detail: true });
  try { assert.equal(document.body.textContent?.includes("Wartung bis"), false); assert.equal(document.querySelector('details') === null, true); }
  finally { await f.close(); }
});

test("agent budgets and pending times are shown without reconstructing healing decisions", async () => {
  const current = host([container("exited", { exitCode: 1 })]);
  current.lifecycle!.selfHealing!.budgets = [{ target, containerId: "demo-web-id", usedAttempts: 2, remainingAttempts: 1,
    attempts: incident.attempts, nextAttemptAt: "2099-10-07T02:00:00Z", runningSince: null }];
  current.lifecycle!.selfHealing!.incidents = [incident];
  const f = await fixture({ current });
  try {
    assert.equal(document.body.textContent?.includes("Selbstheilungsbudget: 2 verbraucht · 1 verbleibend"), true);
    assert.equal(document.body.textContent?.includes("Nächster Heilungsversuch:"), true);
    const unavailable = structuredClone(current);
    unavailable.lifecycle!.selfHealing!.observing = false;
    unavailable.lifecycle!.stopIntents = null;
    await f.update(unavailable);
    assert.equal(document.body.textContent?.includes("Selbstheilung unbekannt"), true);
    assert.equal(document.body.textContent?.includes("Stopp-Absicht unbekannt"), true);
    assert.equal(document.body.textContent?.includes("Nächster Heilungsversuch:"), false);
    assert.equal(document.body.textContent?.includes("abgestürzt"), false);
    assert.equal(document.body.textContent?.includes("Selbstheilungsbudget: 2 verbraucht · 1 verbleibend"), true);
    assert.equal(document.body.textContent?.includes("Offener Selbstheilungsvorfall"), true);
    assert.equal(f.calls.some((call) => call.path.endsWith("/start")), false);
  } finally { await f.close(); }
});
test("maintenance follows the agent status despite a past wall-clock expiry", async () => {
  const current = host();
  current.lifecycle!.selfHealing!.maintenance = [{ target, actor: null, startedAt: "2020-01-01T00:00:00Z", expiresAt: "2020-01-01T01:00:00Z" }];
  const f = await fixture({ current, detail: true });
  try {
    assert.equal(document.body.textContent?.includes("Wartung bis"), true);
    assert.equal(textButton("Wartung ausschalten").getAttribute("aria-disabled"), "false");
    const expired = structuredClone(current);
    expired.lifecycle!.selfHealing!.maintenance = [];
    await f.update(expired);
    assert.equal(document.body.textContent?.includes("Wartung bis"), false);
    assert.equal(textButton("Wartung einschalten").getAttribute("aria-disabled"), "false");
  } finally { await f.close(); }
});
