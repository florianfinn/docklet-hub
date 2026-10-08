import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import type { ContainerAccessResult, HostRouteAccessResult } from "../../domain/hosts/index.js";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import { createUpdatesService } from "./service.js";
import { readUpdateSetting, writeUpdateSetting, updateSettingKey } from "./store.js";
import type * as agentClient from "./agent-client.js";

const target = { kind: "container", containerName: "demo" } as const;
const selection = { target, expectedContainer: { containerId: "old", status: "running", startedAt: "seen" }, backup: null, startDeadlineSeconds: 120 };
function fixture() {
  const calls: { sql: string; args: unknown[] }[] = []; const writes: string[] = []; let deadline: number | null = null;
  const pool = { query: async (sql: string, args: unknown[]) => {
    calls.push({ sql, args }); return { rows: sql.startsWith("SELECT") && deadline !== null ? [{ start_deadline_seconds: deadline }] : [] };
  } } as unknown as Pool;
  const opened = { target: { baseUrl: "https://agent.example.org", secret: "synthetic" }, options: { actor: { kind: "user", id: "human" } },
    container: { id: "old", name: "demo", compose: null } };
  let denied = false; let containerName = "demo";
  const agent = { preview: async (_target: unknown, body: unknown) => { writes.push("preview"); return body; },
    start: async () => { writes.push("start"); return { jobId: "job" }; }, list: async () => ({ active: [], recent: [] }),
    backups: async () => { writes.push("backups"); return { target, backups: [] }; },
    restorePreview: async (_target: unknown, body: unknown) => { writes.push("restore-preview"); return body; },
    restoreStart: async () => { writes.push("restore-start"); return { jobId: "restore" }; },
    progress: async () => ({ progress: null }), cancel: async () => ({ jobId: "job", accepted: true }) } as unknown as typeof agentClient;
  const service = createUpdatesService({ pool, agent,
    openHost: async (_ref, writing) => { writes.push(writing); return denied ? { ok: false, failure: { kind: "problem", status: 503, error: "host-unreachable", message: "offline" } } as HostRouteAccessResult
      : { ok: true, access: opened } as unknown as HostRouteAccessResult; },
    openContainer: async (_ref, writing) => { writes.push(writing); return { ok: true, access: { ...opened, container: { ...opened.container, name: containerName } } } as unknown as ContainerAccessResult; }
  });
  return { pool, service, calls, writes, deadline: (value: number) => { deadline = value; }, deny: () => { denied = true; }, mismatch: () => { containerName = "other"; } };
}
const ref = { hostId: "host", userId: "human" };
test("settings default to 120 and stay attached to stable targets across replacement", async () => {
  const f = fixture(); assert.deepEqual(await readUpdateSetting(f.pool, "host", target), { startDeadlineSeconds: 120 });
  for (const seconds of [10, 1800]) { assert.deepEqual(await writeUpdateSetting(f.pool, "host", target, { startDeadlineSeconds: seconds }), { startDeadlineSeconds: seconds }); }
  for (const seconds of [9, 1801, 10.5]) await assert.rejects(writeUpdateSetting(f.pool, "host", target, { startDeadlineSeconds: seconds }));
  assert.equal(f.calls.at(-1)!.args[1], '["container","demo"]');
  assert.equal(updateSettingKey({ serviceName: "web", projectName: "demo", kind: "compose" }), '["compose","demo","web"]');
});
test("hub overrides the preview deadline from its setting and refuses stale start settings", async () => {
  const f = fixture(); f.deadline(1800);
  const preview = await f.service.preview(ref, { target, services: [selection] }) as unknown as { services: typeof selection[] };
  assert.equal(preview.services[0].startDeadlineSeconds, 1800); assert.deepEqual(f.writes, ["writes", "writes", "preview"]);
  const request = { target, previewId: "preview", confirmed: true, services: [{ ...selection, definitionHash: "hash", offeredDigest: `sha256:${"a".repeat(64)}` }] };
  await assert.rejects(f.service.start(ref, request), (error: unknown) => error instanceof AgentError && (error.detail as { error: string }).error === "update-preview-stale");
  assert.equal(f.writes.includes("start"), false);
  assert.deepEqual(await f.service.start(ref, { ...request, services: [{ ...request.services[0], startDeadlineSeconds: 1800 }] }), { jobId: "job" });
});
test("host access, body validation and current container identity precede agent work", async () => {
  const f = fixture(); await assert.rejects(f.service.preview(ref, {})); assert.equal(f.writes.length, 0);
  f.deny(); await assert.rejects(f.service.preview(ref, { target, services: [selection] })); assert.equal(f.writes.includes("preview"), false);
  const mismatch = fixture(); mismatch.mismatch(); await assert.rejects(mismatch.service.preview(ref, { target, services: [selection] }),
    (error: unknown) => error instanceof AgentError && (error.detail as { error: string }).error === "state-changed");
  assert.equal(mismatch.writes.includes("preview"), false);
});
test("job discovery reads the agent list without a local progress table", async () => {
  const f = fixture(); assert.deepEqual(await f.service.list(ref, {}), { active: [], recent: [] });
  assert.deepEqual(f.calls, []);
});

test("backup list uses container write authorization and update forwards optional mount selection", async () => {
  const f = fixture(); assert.deepEqual(await f.service.backups({ ...ref, containerId: "old" }), { target, backups: [] });
  assert.deepEqual(f.writes, ["writes", "backups"]);
  const backup = { mode: "live", mounts: [{ sourceId: "data", estimatedBytes: 4096 }] };
  const response = await f.service.preview(ref, { target, services: [{ ...selection, backup }] }) as unknown as { services: { backup: unknown }[] };
  assert.deepEqual(response.services[0].backup, backup);
});
test("restore preview and start retain stable target, confirmed mounts and configured deadline", async () => {
  const f = fixture(); const request = { target, backupId: "backup", mounts: [{ sourceId: "data" }] };
  assert.deepEqual(await f.service.restorePreview(ref, request), request);
  const start = { ...request, previewId: "preview", expectedContainer: selection.expectedContainer, confirmed: true, startDeadlineSeconds: 120 };
  assert.deepEqual(await f.service.restoreStart(ref, start), { jobId: "restore" });
  assert.deepEqual(f.writes, ["writes", "restore-preview", "writes", "writes", "restore-start"]);
  const denied = fixture(); denied.mismatch();
  await assert.rejects(denied.service.restoreStart(ref, start)); assert.equal(denied.writes.includes("restore-start"), false);
  const unconfirmed = fixture(); await assert.rejects(unconfirmed.service.restoreStart(ref, { ...start, confirmed: false }));
  assert.deepEqual(unconfirmed.writes, []);
  f.deadline(1800); await assert.rejects(f.service.restoreStart(ref, start));
});
