import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import type { ContainerAccessResult, HostRouteAccessResult } from "../../domain/hosts/index.js";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import { createUpdatesService } from "./service.js";
import { readUpdateSetting, writeUpdateSetting, updateSettingKey, recordUpdateJobs } from "./store.js";
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
test("recovered jobs are persisted and completed results expire after 24 hours", async () => {
  const f = fixture(); await recordUpdateJobs(f.pool, "host", { active: [{ jobId: "job", kind: "update", target, service: null, phase: "queued",
    phaseStartedAt: "2026-10-08T00:00:00Z", phaseDeadlineAt: "2026-10-08T00:01:00Z", completedAt: null, result: null, firstExchangeStarted: false, cancelAllowed: true }], recent: [] });
  assert.match(f.calls[0].sql, /ON CONFLICT/); assert.equal(f.calls[0].args[1], "job"); assert.match(f.calls[1].sql, /24 hours/);
});
