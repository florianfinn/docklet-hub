import { renderInDom, settleQueries, waitFor, settle } from "./dom-harness.js";
import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GLOBAL_THEME, DEFAULT_SELF_HEALING_CONFIG, type Settings } from "contract";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { RuntimeSettingsPanel } from "../src/features/settings/RuntimeSettingsPanel.js";
import { SetupView } from "../src/features/account/SetupView.js";

(globalThis as unknown as { __HUB_VERSION__: string }).__HUB_VERSION__ = "0.0.0-test";

type Call = { method: string; path: string; body: unknown };
function stub(failed = false) {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  const settings: Settings = { theme: DEFAULT_GLOBAL_THEME, logs: { tailLines: 200 }, containers: { showSystem: false },
    network: { externalEndpoint: null, internalTarget: null, externalTarget: null, externalTargetUnreachable: false },
    runtime: { applyComposeDefinition: true }, selfHealing: { config: structuredClone(DEFAULT_SELF_HEALING_CONFIG), revision: 1,
      hosts: [{ hostId: "demo", hostName: "Demo", status: "pending", appliedRevision: null, updatedAt: null }] } };
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method: init?.method ?? "GET", path, body });
    let result: unknown = settings;
    let status = 200;
    if (init?.method === "PUT") {
      if (failed) { result = { error: "unavailable" }; status = 500; }
      else if (path.endsWith("/runtime")) { settings.runtime = body.runtime; result = { runtime: settings.runtime }; }
      else {
        settings.selfHealing.config = body.selfHealing.config;
        settings.selfHealing.revision += 1;
        result = { selfHealing: settings.selfHealing };
      }
    }
    return new Response(JSON.stringify(result), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
function input(id: string): HTMLInputElement {
  const node = document.getElementById(id); assert.ok(node instanceof HTMLInputElement); return node;
}
function button(id: string): HTMLButtonElement {
  const node = document.getElementById(id); assert.ok(node instanceof HTMLButtonElement); return node;
}
async function type(id: string, value: string) {
  await React.act(async () => {
    const node = input(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function cleanup(mounted: Awaited<ReturnType<typeof renderInDom>>) {
  await waitFor(() => mounted.queryClient.isMutating() === 0);
  await settleQueries(mounted.queryClient);
  const mutations = mounted.queryClient.getMutationCache().getAll();
  await mounted.unmount();
  // MutationCache.clear leaves detached GC timers alive under happy-dom.
  for (const mutation of mutations) mutation.destroy();
}
async function submit(form: HTMLFormElement) {
  await React.act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
}

test("Ersteinrichtung zeigt Erklärung und Vorauswahl An und sendet die gewählte Stellung", async () => {
  const server = stub();
  const mounted = await renderInDom(<AppLanguageProvider><SetupView onDone={() => undefined} /></AppLanguageProvider>);
  try {
    const choice = button("setup-compose-definition");
    assert.equal(choice.getAttribute("aria-checked"), "true");
    assert.equal(choice.getAttribute("aria-describedby"), "setup-compose-definition-hint");
    assert.ok((document.getElementById("setup-compose-definition-hint")?.textContent?.length ?? 0) > 30);
    await React.act(async () => { choice.click(); });
    await type("setup-name", "Demo"); await type("setup-email", "demo@example.org"); await type("setup-password", "synthetic-password");
    const form = document.querySelector("form"); assert.ok(form instanceof HTMLFormElement);
    await submit(form);
    assert.equal((server.calls.find((call) => call.path.includes("sign-up/email"))?.body as { applyComposeDefinition: boolean })
      .applyComposeDefinition, false);
  } finally { await cleanup(mounted); server.restore(); }
});

test("Einstellungsseite zeigt alle Vorgaben, speichert Schalter und genau einen Zahlenabstand je Versuch", async () => {
  const server = stub();
  const mounted = await renderInDom(<AppLanguageProvider><RuntimeSettingsPanel role="admin" /></AppLanguageProvider>);
  try {
    await settleQueries(mounted.queryClient);
    assert.equal(button("apply-compose-definition").getAttribute("aria-checked"), "true");
    assert.equal(button("self-healing-enabled").getAttribute("aria-checked"), "true");
    assert.deepEqual(["self-healing-attempts", "self-healing-delay-0", "self-healing-delay-1", "self-healing-delay-2",
      "self-healing-stabilityWindowSeconds", "self-healing-maintenanceDurationSeconds"].map((id) => input(id).value),
      ["3", "10", "60", "300", "600", "3600"]);
    await React.act(async () => { button("apply-compose-definition").click(); });
    const forms = document.querySelectorAll("form"); await submit(forms[0]);
    assert.deepEqual(server.calls.find((call) => call.path.endsWith("/runtime"))?.body, { runtime: { applyComposeDefinition: false } });
    await type("self-healing-attempts", "2");
    assert.equal(document.getElementById("self-healing-delay-2") === null, true);
    await type("self-healing-delay-1", "45"); await submit(forms[1]);
    const sent = server.calls.find((call) => call.path.endsWith("/self-healing"))?.body as { selfHealing: { config: unknown } };
    assert.deepEqual(sent.selfHealing.config, { ...DEFAULT_SELF_HEALING_CONFIG, attempts: 2, retryDelaysSeconds: [10, 45] });
    assert.ok((mounted.container.textContent ?? "").includes("Demo"));
  } finally { await cleanup(mounted); server.restore(); }
});

test("ungültige Werte verhindern Übertragung und Anzahl wächst mit passenden Abständen", async () => {
  const server = stub();
  const mounted = await renderInDom(<AppLanguageProvider><RuntimeSettingsPanel role="admin" /></AppLanguageProvider>);
  try {
    await settleQueries(mounted.queryClient); await type("self-healing-attempts", "4");
    assert.equal(input("self-healing-delay-3").value, "300"); await type("self-healing-delay-0", "0");
    assert.equal(document.querySelector('[role="alert"]') !== null, true);
    const form = document.querySelectorAll("form")[1];
    assert.equal(form.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled, true);
    await submit(form); assert.equal(server.calls.some((call) => call.method === "PUT"), false);
  } finally { await cleanup(mounted); server.restore(); }
});

test("Benutzer sehen die Werte mit gesperrten Feldern und ohne Speichern", async () => {
  const server = stub();
  const mounted = await renderInDom(<AppLanguageProvider><RuntimeSettingsPanel role="user" /></AppLanguageProvider>);
  try {
    await settleQueries(mounted.queryClient);
    assert.equal(button("apply-compose-definition").disabled, true); assert.equal(input("self-healing-attempts").disabled, true);
    assert.equal(document.querySelector('button[type="submit"]') === null, true);
  } finally { await cleanup(mounted); server.restore(); }
});

test("ein Speicherfehler bleibt sichtbar und der Entwurf kann erneut abgesendet werden", async () => {
  const server = stub(true);
  const mounted = await renderInDom(<AppLanguageProvider><RuntimeSettingsPanel role="admin" /></AppLanguageProvider>);
  try {
    await settleQueries(mounted.queryClient); await type("self-healing-delay-0", "15"); await submit(document.querySelectorAll("form")[1]);
    assert.equal(await waitFor(() => document.querySelector('[role="alert"]') !== null), true);
    assert.equal(input("self-healing-delay-0").value, "15"); assert.equal(input("self-healing-delay-0").disabled, false);
  } finally { await cleanup(mounted); server.restore(); }
});
