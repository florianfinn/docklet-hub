import { waitFor, settle } from "./dom-harness.js";
import * as React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, click, textButton } from "./lifecycle-test-support.js";
import type { RestoreProgress } from "contract";
const target = { kind: "compose", projectName: "demo", serviceName: "web" } as const;
const source = { sourceId: "data", service: "web", kind: "volume", source: "demo-data", target: "/data", readOnly: false,
  shared: false, readable: true, writable: true, writeBlocker: null, estimatedBytes: null, backupEligible: true,
  restoreEligible: true, protection: "none", ownership: "exclusive" };
const backup = { backupId: "backup", target, completedAt: "2026-10-08T00:00:00Z", mode: "stop",
  archives: [{ sourceId: "data", mountTarget: "/data", archiveId: "archive", bytes: 2048 }] };
const expectedContainer = { containerId: "demo-web-id", status: "running", startedAt: "2026-10-07T01:00:00Z" };
const preview = { target, backupId: "backup", mounts: [{ sourceId: "data" }], backup, targets: [source], previewId: "preview",
  expectedContainer, warnings: ["data-overwrite", "database-consistency-not-guaranteed"] };
test("K22: restore selects a complete backup and mount, previews bytes and requires separate overwrite confirmation", async () => {
  const f = await fixture({ action: (call) => {
    if (call.path.endsWith("/backups")) return Response.json({ target, backups: [backup] });
    if (call.path.endsWith("/file-sources")) return Response.json({ sources: [source] });
    if (call.path.endsWith("/restore-previews")) return Response.json(preview);
    if (call.path.endsWith("/restores")) return Response.json({ jobId: "restore-job" });
    return Response.json({});
  } });
  f.queryClient.setDefaultOptions({ ...f.queryClient.getDefaultOptions(), mutations: { gcTime: 0 } });
  try {
    await click(textButton("Daten wiederherstellen"));
    assert.equal(await waitFor(() => document.querySelector('[role="dialog"]') !== null), true);
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.equal(dialog.textContent?.includes("2048 Bytes"), true); assert.equal(dialog.textContent?.includes("demo-data"), true);
    assert.equal(textButton("Restore-Vorschau", dialog).disabled, true);
    await click(dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await click(textButton("Restore-Vorschau", dialog));
    assert.equal(await waitFor(() => dialog.textContent?.includes("Überschreiben bestätigen") === true), true);
    assert.equal(f.calls.some((call) => call.path.endsWith("/restores")), false);
    assert.equal(dialog.textContent?.includes("keine konsistente Datenbanksicherung"), true);
    await click(textButton("Überschreiben bestätigen und wiederherstellen", dialog));
    assert.equal(await waitFor(() => f.calls.some((call) => call.path.endsWith("/restores"))), true);
    assert.equal(await waitFor(() => f.queryClient.isMutating() === 0), true);
    assert.deepEqual(f.calls.find((call) => call.path.endsWith("/restores"))!.body,
      { target, backupId: "backup", mounts: [{ sourceId: "data" }], expectedContainer, previewId: "preview", confirmed: true, startDeadlineSeconds: 120 });
  } finally { await f.close(); }
});
test("K18/K22: shared and unknown restore sources stay disabled with a translated blocker", async () => {
  const f = await fixture({ action: (call) => call.path.endsWith("/backups") ? Response.json({ target, backups: [backup] })
    : Response.json({ sources: [{ ...source, shared: true, ownership: "shared", writable: false, restoreEligible: false, writeBlocker: "source-shared" }] }) });
  f.queryClient.setDefaultOptions({ ...f.queryClient.getDefaultOptions(), mutations: { gcTime: 0 } });
  try {
    await click(textButton("Daten wiederherstellen")); await waitFor(() => document.querySelector('[role="dialog"]') !== null);
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.equal(dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled, true);
    assert.equal(dialog.textContent?.includes("Geteilte Quellen"), true); assert.equal(textButton("Restore-Vorschau", dialog).disabled, true);
  } finally { await f.close(); }
});
test("K22/R12: recovered restore progress blocks late cancellation and separates result errors", async () => {
  const f = await fixture();
  f.queryClient.setDefaultOptions({ ...f.queryClient.getDefaultOptions(), mutations: { gcTime: 0 } });
  try {
    const progress: RestoreProgress = { jobId: "restore", kind: "restore", target, phase: "extract", extractStarted: true,
      phaseStartedAt: "2026-10-08T00:00:00Z", phaseDeadlineAt: "2026-10-08T01:00:00Z", completedAt: null, cancelAllowed: false, result: null };
    await React.act(async () => { f.queryClient.setQueryData(["restore-jobs", "demo-host"], { active: [progress], recent: [] }); }); await settle();
    assert.equal(textButton("Auftrag abbrechen").disabled, true); assert.equal(document.body.textContent?.includes("entpacken"), true);
    await React.act(async () => { f.queryClient.setQueryData(["restore-jobs", "demo-host"], { active: [], recent: [{ ...progress, phase: "completed",
      completedAt: "2026-10-08T01:00:00Z", result: { target, backupId: "backup", ok: false, outcome: "failed",
        state: { ...expectedContainer, status: "exited", exitCode: 1, health: null }, restoreError: "restore-extract-failed", resumeError: "resume-failed" } }] }); }); await settle();
    assert.equal(document.body.textContent?.includes("Restore-Fehler"), true); assert.equal(document.body.textContent?.includes("Wiederanlauffehler"), true);
  } finally { await f.close(); }
});
