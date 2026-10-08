import { renderInDom, waitFor, settle } from "./dom-harness.js";
import * as React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { LifecycleProvider } from "../src/features/containers/LifecycleProvider.js";
import { UpdateControls } from "../src/features/containers/UpdateControls.js";
import { host, container, click, textButton } from "./lifecycle-test-support.js";
import { queryKeys } from "../src/platform/query/query-keys.js";
import type { UpdatePreviewResponse, UpdateProgress } from "contract";
const oldDigest = `sha256:${"a".repeat(64)}`, offeredDigest = `sha256:${"b".repeat(64)}`;
async function fixture(kind: "container" | "stack" = "container", blocker: string | null = null) {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["de"] });
  const current = host([container("paused", { health: "unhealthy" })]);
  const target = kind === "container" ? { kind, hostId: current.host.id, container: current.stacks[0].containers[0] }
    : { kind, hostId: current.host.id, stack: current.stacks[0] };
  const scope = kind === "stack" ? { kind: "stack" as const, projectName: "demo" } : { kind: "compose" as const, projectName: "demo", serviceName: "web" };
  const service = { target: { kind: "compose" as const, projectName: "demo", serviceName: "web" }, expectedContainer: { containerId: "demo-web-id", status: "paused", startedAt: current.stacks[0].containers[0].startedAt },
    startDeadlineSeconds: 1800, backup: null, imageRef: "nginx:1.27", currentDigest: oldDigest, offeredDigest, rollbackImageId: "old-image",
    definitionHash: "definition", acceptance: "service" as const, initialState: { containerId: "demo-web-id", status: "paused", startedAt: current.stacks[0].containers[0].startedAt, health: "unhealthy", exitCode: null },
    mounts: [], warnings: ["unhealthy", "paused", "rollback-does-not-restore-data"], blocker };
  const preview = { previewId: "preview", target: scope, digestSource: "registry-manifest", services: [service] } as UpdatePreviewResponse;
  const calls: { path: string; body: unknown }[] = []; const before = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = String(input); calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path.includes("/jobs?")) return Response.json({ active: [], recent: [] });
    if (path.includes("update-settings")) return Response.json({ startDeadlineSeconds: 1800 });
    if (path.endsWith("update-previews")) return Response.json(preview);
    if (path.endsWith("updates")) return Response.json({ jobId: "job" });
    return Response.json({ jobId: "job", accepted: true });
  };
  const f = await renderInDom(<AppLanguageProvider><LifecycleProvider role="admin"><UpdateControls target={target} detail={kind === "container"} /></LifecycleProvider></AppLanguageProvider>);
  f.queryClient.setDefaultOptions({ ...f.queryClient.getDefaultOptions(), mutations: { gcTime: 0 } });
  await React.act(async () => { f.queryClient.setQueryData(queryKeys.containers.overview(), [current]); }); await settle();
  return { ...f, target, preview, calls, close: async () => { await f.unmount(); globalThis.fetch = before;
    if (languages) Object.defineProperty(navigator, "languages", languages); else Reflect.deleteProperty(navigator, "languages"); } };
}
for (const kind of ["container", "stack"] as const) test(`${kind} update always confirms digests, warnings and deadline before start`, async () => {
  const f = await fixture(kind);
  try {
    await click(textButton("Update")); assert.equal(await waitFor(() => document.querySelector('[role="dialog"]') !== null), true);
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.equal(dialog.textContent?.includes(oldDigest), true); assert.equal(dialog.textContent?.includes(offeredDigest), true);
    assert.equal(dialog.textContent?.includes("1800"), true); assert.equal(dialog.textContent?.includes("pausiert"), true);
    assert.equal(f.calls.some((call) => call.path.endsWith("/updates")), false);
    await click(textButton("Update starten", dialog)); assert.equal(await waitFor(() => f.calls.some((call) => call.path.endsWith("/updates"))), true);
    const body = f.calls.find((call) => call.path.endsWith("/updates"))!.body as { confirmed: boolean; services: { offeredDigest: string; startDeadlineSeconds: number }[] };
    assert.equal(body.confirmed, true); assert.equal(body.services[0].offeredDigest, offeredDigest); assert.equal(body.services[0].startDeadlineSeconds, 1800);
  } finally { await f.close(); }
});
test("blocked local-image preview cannot be confirmed and cancelling never starts an update", async () => {
  const f = await fixture("container", "local-image-no-registry-digest");
  try {
    await click(textButton("Update")); await waitFor(() => document.querySelector('[role="dialog"]') !== null);
    assert.equal(textButton("Update starten").disabled, true); await click(textButton("Update starten"));
    assert.equal(f.calls.some((call) => call.path.endsWith("/updates")), false);
    await click(textButton("Abbrechen", document.querySelector('[role="dialog"]')!)); assert.equal(document.querySelector('[role="dialog"]') === null, true);
  } finally { await f.close(); }
});
test("recovered progress shows service/phase, enforces cancellation and separates rollback errors", async () => {
  const f = await fixture("stack");
  try {
    const progress: UpdateProgress = { kind: "update", jobId: "job", target: f.preview.target, service: f.preview.services[0].target,
      phase: "rollback", phaseStartedAt: "2026-10-08T00:00:00Z", phaseDeadlineAt: "2026-10-08T00:20:00Z", completedAt: null,
      cancelAllowed: false, firstExchangeStarted: true, result: null };
    await React.act(async () => { f.queryClient.setQueryData(["update-jobs", "demo-host"], { active: [progress], recent: [] }); }); await settle();
    assert.equal(document.body.textContent?.includes("web"), true); assert.equal(textButton("Auftrag abbrechen").disabled, true);
    const result = { target: progress.target, outcome: "rollback-failed", updateError: "update-health-timeout", rollbackError: "update-rollback-failed",
      services: [{ target: progress.service, outcome: "rollback-failed", state: f.preview.services[0].initialState, imageId: "new", definitionHash: "hash", backupId: null,
        updateError: "update-health-timeout", rollbackError: "update-rollback-failed", resumeError: null }] };
    await React.act(async () => { f.queryClient.setQueryData(["update-jobs", "demo-host"], { active: [], recent: [{ ...progress, phase: "completed", completedAt: "2026-10-08T00:20:00Z", result }] }); }); await settle();
    assert.equal(document.body.textContent?.includes("Update-Fehler"), true); assert.equal(document.body.textContent?.includes("Rollback-Fehler"), true);
  } finally { await f.close(); }
});
test("container setting submits its stable identity and configured start deadline", async () => {
  const f = await fixture();
  try {
    await waitFor(() => document.querySelector('input[type="number"]') !== null);
    const input = document.querySelector<HTMLInputElement>('input[type="number"]')!;
    assert.equal(input.min, "10"); assert.equal(input.max, "1800");
    await React.act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "10"); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); }); await settle();
    await click(textButton("Speichern"));
    assert.equal(await waitFor(() => f.calls.some((call) => (call.body as { settings?: unknown } | null)?.settings !== undefined)), true);
    const saved = f.calls.find((call) => (call.body as { settings?: unknown } | null)?.settings !== undefined)!.body;
    assert.deepEqual(saved, { target: f.preview.services[0].target, settings: { startDeadlineSeconds: 10 } });
  } finally { await f.close(); }
});
