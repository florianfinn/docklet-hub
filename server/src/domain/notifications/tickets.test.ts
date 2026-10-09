import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { notificationTicketResponseSchema, notificationTicketsResponseSchema, type NotificationTicketView } from "contract";
import { initialConfig } from "./config.js";
import { createNotificationTickets, pendingNotificationIntentions, admitNotificationIntention } from "./tickets.js";
import { targetKey, type NotificationDatabase, type NotificationQuery, type TicketObservation } from "./types.js";

type Row = { document: NotificationTicketView; observed_at: string; source: string; target_key: string };
type Intention = { ticket_id: string; phase: string; channel: string; configuration_revision: string; snapshot: unknown; admitted_at: string | null };
function harness() {
  let rows = new Map<string, Row>();
  let intentions = new Map<string, Intention>();
  let clock = new Date("2026-01-02T00:00:00.000Z");
  let failCommit = false;
  let failIntention = false;
  let readerCalls = 0;
  const statements: string[] = [];
  const config = initialConfig();
  const scopes = new Map<string, { configuration: unknown; active: boolean }>();
  config.channels.find((channel) => channel.kind === "webhook")!.endpoint = "https://example.invalid/webhook";
  config.hostRules = [{ channel: "webhook", events: ["connection-lost"], overrides: { recovery: true } }];
  const query = async (sql: string, values: unknown[] = []) => {
    statements.push(sql);
    if (sql.startsWith("INSERT INTO notification_config")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT configuration, active")) return { rows: scopes.has(values[0] as string) ? [scopes.get(values[0] as string)] : [], rowCount: 1 };
    if (sql.startsWith("SELECT revision")) return { rows: [{ revision: "0", document: structuredClone(config) }], rowCount: 1 };
    if (sql.includes("SELECT count(*)::text AS count")) return { rows: [{ count: String([...intentions.values()].filter((item) => item.ticket_id === values[0] && !item.admitted_at).length) }], rowCount: 1 };
    if (sql.startsWith("SELECT document, observed_at FROM notification_ticket WHERE id")) return { rows: rows.has(values[0] as string) ? [structuredClone(rows.get(values[0] as string))] : [], rowCount: 1 };
    if (sql.includes("WHERE source = $1")) return { rows: [...rows.values()].filter((row) => row.source === values[0] && row.target_key === values[1] && row.document.episodeKey === values[2]).map((row) => structuredClone(row)), rowCount: 1 };
    if (sql.includes("INSERT INTO notification_ticket")) {
      const row = { document: JSON.parse(values[11] as string), observed_at: values[10] as string, source: values[1] as string, target_key: values[2] as string };
      rows.set(values[0] as string, row);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO notification_delivery_intention")) {
      if (failIntention) throw new Error("synthetic-intention-failure");
      const key = values.slice(0, 3).join("|");
      if (!intentions.has(key)) intentions.set(key, { ticket_id: values[0] as string, phase: values[1] as string,
        channel: values[2] as string, configuration_revision: String(values[3]), snapshot: JSON.parse(values[4] as string), admitted_at: null });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE notification_ticket")) {
      const row = rows.get(values[0] as string)!;
      row.document = JSON.parse(values[2] as string);
      if (sql.includes("observed_at = $2")) row.observed_at = values[1] as string;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM notification_ticket") && sql.includes("ORDER BY opened_at DESC")) {
      const selected = [...rows.values()].filter(({ document: ticket }) => (!values[0] || ticket.state === values[0]) &&
        (!values[1] || ticket.event === values[1]) && (!values[2] || ticket.target.hostId === values[2]) &&
        (!values[3] || ticket.target.kind === values[3]) && (!values[4] || ticket.openedAt < values[4] ||
          (ticket.openedAt === values[4] && ticket.id < (values[5] as string))))
        .sort((a, b) => b.document.openedAt.localeCompare(a.document.openedAt) || b.document.id.localeCompare(a.document.id));
      return { rows: structuredClone(selected.slice(0, values[6] as number)), rowCount: selected.length };
    }
    if (sql.includes("FILTER (WHERE state")) return { rows: [{ open: String([...rows.values()].filter((row) => row.document.state === "open").length),
      acknowledged: String([...rows.values()].filter((row) => row.document.state === "acknowledged").length) }], rowCount: 1 };
    if (sql.startsWith("DELETE FROM notification_ticket")) {
      let removed = 0;
      for (const [id, row] of rows) if (row.document.state === "resolved" && row.document.resolvedAt! < (values[0] as string) &&
        ![...intentions.values()].some((item) => item.ticket_id === id && !item.admitted_at)) {
        rows.delete(id); removed += 1;
        for (const [key, intention] of intentions) if (intention.ticket_id === id) intentions.delete(key);
      }
      return { rows: [], rowCount: removed };
    }
    if (sql.startsWith("SELECT * FROM notification_delivery_intention")) return { rows: [...intentions.values()].filter((item) => !item.admitted_at).slice(0, values[0] as number), rowCount: intentions.size };
    if (sql.startsWith("UPDATE notification_delivery_intention SET admitted_at")) {
      const item = intentions.get(values.slice(0, 3).join("|"));
      if (item && !item.admitted_at) item.admitted_at = values[3] as string;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected-sql: ${sql}`);
  };
  let tail = Promise.resolve();
  const database = { query,
    transaction: <T>(operation: (query: NotificationQuery) => Promise<T>) => {
      const result = tail.then(async () => {
        const oldRows = structuredClone(rows); const oldIntentions = structuredClone(intentions);
        try {
          const result = await operation({ query } as NotificationQuery);
          if (failCommit) throw new Error("synthetic-commit-failure");
          return result;
        } catch (error) { rows = oldRows; intentions = oldIntentions; throw error; }
      });
      tail = result.then(() => undefined, () => undefined);
      return result;
    }
  } as NotificationDatabase;
  const service = createNotificationTickets(database, { now: () => clock, cursorSecret: "synthetic-cursor-secret-at-least-32-chars",
    targetReader: async () => { readerCalls += 1; return { exists: true, stack: null }; },
    sanitizeText: (value) => value.includes("private") ? null : value });
  const observation: TicketObservation = { source: "connection-observer", observedAt: "2026-01-01T00:00:00.000Z",
    episodeKey: "episode-a", event: "connection-lost", target: { kind: "host", hostId: "host-a" },
    targetLabel: "Synthetic host", cause: "Connection unavailable", action: "check-connection",
    affectedContainers: [{ containerId: "container-a", label: "Synthetic container" }], affectedContainerCount: 3 };
  return { database, service, observation, statements, config, scopes, rows: () => rows, intentions: () => intentions,
    clock: (value: string) => { clock = new Date(value); }, fail: () => { failCommit = true; }, failIntent: () => { failIntention = true; },
    readerCalls: () => readerCalls };
}

test("dedup, idempotent ack without dispatch, fresh recovery only, new episodes and full public DTO", { timeout: 1000 }, async () => {
  const h = harness();
  const ticket = await h.service.observe(h.observation);
  notificationTicketResponseSchema.parse({ ticket });
  assert.equal(ticket.pendingDeliveryCount, 1);
  const repeat = await h.service.observe({ ...h.observation, observedAt: "2026-01-01T01:00:00.000Z" });
  assert.equal(repeat.id, ticket.id);
  assert.equal(h.intentions().size, 1);
  const beforeAck = h.statements.length;
  const acknowledged = await h.service.acknowledge(ticket.id);
  assert.equal(acknowledged.state, "acknowledged");
  assert.equal(h.readerCalls(), 0);
  assert.ok(h.statements.slice(beforeAck).every((sql) => !sql.includes("INSERT INTO notification_delivery_intention")));
  assert.deepEqual(await h.service.acknowledge(ticket.id), acknowledged);
  for (const evidence of [null, { recovered: false, observedAt: "2026-01-02T00:00:00.000Z" },
    { recovered: true, observedAt: "2026-01-01T00:00:00.000Z" }, { recovered: true, observedAt: "2026-01-03T00:00:00.000Z" }]) {
    assert.equal((await h.service.recover(ticket.id, async () => evidence)).state, "acknowledged");
  }
  h.clock("2026-01-02T01:00:00.000Z");
  const resolved = await h.service.recover(ticket.id, async () => ({ recovered: true, observedAt: "2026-01-02T00:30:00.000Z" }));
  assert.equal(resolved.state, "resolved");
  assert.equal(resolved.pendingDeliveryCount, 2);
  assert.equal((await h.service.observe({ ...h.observation, observedAt: "2026-01-02T01:00:00.000Z" })).state, "resolved");
  assert.equal((await h.service.acknowledge(ticket.id)).state, "resolved");
  const next = await h.service.observe({ ...h.observation, episodeKey: "episode-b", observedAt: "2026-01-02T01:00:00.000Z" });
  assert.notEqual(next.id, ticket.id);
});

test("unproven logs fail closed, malicious text rejected, schema bounds enforced", { timeout: 1000 }, async () => {
  const h = harness();
  const ticket = await h.service.observe({ ...h.observation, evidence: { logs: { state: "available", text: "private evidence", truncated: false } } });
  assert.deepEqual(ticket.evidence, { logs: { state: "unavailable", reason: "redaction-unavailable" } });
  const unavailable = await h.service.observe({ ...h.observation, episodeKey: "unavailable-episode",
    evidence: { logs: { state: "unavailable", reason: "source-unavailable" } } });
  assert.deepEqual(unavailable.evidence, { logs: { state: "unavailable", reason: "source-unavailable" } });
  assert.ok(!JSON.stringify([...h.intentions().values()]).includes("private evidence"));
  assert.ok(!JSON.stringify([...h.intentions().values()]).includes("example.invalid"));
  await assert.rejects(h.service.observe({ ...h.observation, cause: "private endpoint" }), { code: "invalid-input" });
  await assert.rejects(h.service.observe({ ...h.observation, cause: "x".repeat(1001) }), { code: "invalid-input" });
  await assert.rejects(h.service.observe({ ...h.observation, affectedContainerCount: 0 }), { code: "invalid-input" });
  await assert.rejects(h.service.observe({ ...h.observation, episodeKey: "x".repeat(201) }), { code: "invalid-input" });
  assert.equal(notificationTicketResponseSchema.safeParse({ ticket: { ...ticket, credentials: "secret" } }).success, false);
});

test("ticket and intentions rollback together on intention/commit failure and parallel duplicate observations converge", { timeout: 1000 }, async () => {
  const failed = harness(); failed.failIntent();
  await assert.rejects(failed.service.observe(failed.observation), /synthetic-intention-failure/);
  assert.equal(failed.rows().size, 0); assert.equal(failed.intentions().size, 0);
  const commit = harness(); commit.fail();
  await assert.rejects(commit.service.observe(commit.observation), /synthetic-commit-failure/);
  assert.equal(commit.rows().size, 0); assert.equal(commit.intentions().size, 0);
  const h = harness();
  const [a, b] = await Promise.all([h.service.observe(h.observation), h.service.observe(h.observation)]);
  assert.equal(a.id, b.id); assert.equal(h.rows().size, 1); assert.equal(h.intentions().size, 1);
  assert.ok(h.statements.some((sql) => sql.includes("FOR UPDATE")));
});

test("stable filter-bound cursor, finite pages and global counts", { timeout: 1000 }, async () => {
  const h = harness();
  const first = await h.service.observe(h.observation);
  await h.service.observe({ ...h.observation, episodeKey: "episode-b" });
  await h.service.observe({ ...h.observation, episodeKey: "episode-c", target: { kind: "host", hostId: "host-b" } });
  const page = await h.service.list({ limit: 1, hostId: "host-a" });
  notificationTicketsResponseSchema.parse(page);
  assert.equal(page.tickets.length, 1); assert.ok(page.nextCursor); assert.ok(page.nextCursor.length <= 200);
  const next = await h.service.list({ limit: 1, hostId: "host-a", cursor: page.nextCursor });
  assert.equal(next.nextCursor, null); assert.notEqual(next.tickets[0].id, page.tickets[0].id);
  await assert.rejects(h.service.list({ limit: 1, hostId: "host-b", cursor: page.nextCursor }), { code: "invalid-input" });
  await assert.rejects(h.service.list({ limit: 2, hostId: "host-a", cursor: page.nextCursor }), { code: "invalid-input" });
  await assert.rejects(h.service.list({ limit: 1, hostId: "host-a", cursor: `${page.nextCursor.slice(0, -3)}xxx` }), { code: "invalid-input" });
  await assert.rejects(h.service.list({ limit: 101 }), { code: "invalid-input" });
  await h.service.acknowledge(first.id);
  assert.deepEqual(await h.service.counts(), { open: 2, acknowledged: 1, active: 3 });
  assert.equal((await h.service.list({ state: "resolved" })).tickets.length, 0);
});

test("retention is resolved-only and never destroys pending intentions; admission is restart-safe", { timeout: 1000 }, async () => {
  const h = harness();
  const ticket = await h.service.observe(h.observation);
  await h.service.recover(ticket.id, async () => ({ recovered: true, observedAt: "2026-01-01T01:00:00.000Z" }));
  const open = await h.service.observe({ ...h.observation, episodeKey: "episode-b" });
  const ack = await h.service.observe({ ...h.observation, episodeKey: "episode-c" });
  await h.service.acknowledge(ack.id);
  h.clock("2026-02-02T00:00:00.000Z");
  assert.equal(await h.service.pruneResolved(), 0);
  await h.database.transaction(async (query) => {
    const intentions = await pendingNotificationIntentions(query);
    for (const intention of intentions.filter((item) => item.ticketId === ticket.id)) {
      await admitNotificationIntention(query, intention, "2026-02-02T00:00:00.000Z");
    }
  });
  assert.equal(await h.service.pruneResolved(), 1);
  assert.equal((await h.service.read(open.id)).state, "open");
  assert.equal((await h.service.read(ack.id)).state, "acknowledged");
  await assert.rejects(h.service.read(ticket.id), { code: "ticket-unknown" });
  await assert.rejects(pendingNotificationIntentions(h.database, 101), { code: "invalid-input" });
  assert.ok(h.statements.some((sql) => sql.includes("FOR UPDATE SKIP LOCKED")));
});

test("migration enforces singleton, revision bounds, stable dedup and cascading intention ownership", () => {
  const sql = readFileSync(new URL("../../platform/db/migrations/019-notifications.sql", import.meta.url), "utf8");
  assert.match(sql, /PRIMARY KEY DEFAULT true CHECK \(singleton\)/);
  assert.match(sql, /revision >= 0 AND revision <= 9007199254740991/);
  assert.match(sql, /UNIQUE \(source, target_key, episode_key\)/);
  assert.match(sql, /REFERENCES docker_host\(id\) ON DELETE CASCADE/);
  assert.match(sql, /REFERENCES notification_ticket\(id\) ON DELETE CASCADE/);
  assert.match(sql, /PRIMARY KEY \(ticket_id, phase, channel\)/);
  assert.match(sql, /CHECK \(\(state = 'resolved'\) = \(resolved_at IS NOT NULL\)\)/);
});


test("runtime defaults honor false overrides and explicit empty cancels selection rather than falling through", { timeout: 1000 }, async () => {
  const h = harness();
  const channel = h.config.channels.find((item) => item.kind === "webhook")!;
  channel.defaults = { includeLogs: true, recovery: true, additionalText: "Global" };
  h.config.defaults = [{ channel: "webhook", events: ["update-failed"], overrides: {
    includeLogs: false, recovery: false, additionalText: "Local", destination: "https://example.invalid/custom" } }];
  const target = { kind: "container" as const, hostId: "host-a", target: { kind: "container" as const, containerName: "container-a" } };
  const observation: TicketObservation = { ...h.observation, target, event: "update-failed", action: "inspect-update",
    affectedContainers: [], affectedContainerCount: 0 };
  const ticket = await h.service.observe(observation);
  const snapshot = [...h.intentions().values()][0].snapshot as { options: { includeLogs: boolean; recovery: boolean; additionalText: string }; ticket: NotificationTicketView };
  assert.deepEqual(snapshot.options, { includeLogs: false, recovery: false, additionalText: "Global\nLocal" });
  assert.deepEqual(snapshot.ticket.evidence.logs, { state: "unavailable", reason: "not-collected" });
  await h.service.recover(ticket.id, async () => ({ recovered: true, observedAt: "2026-01-01T01:00:00.000Z" }));
  assert.equal(h.intentions().size, 1);
  h.scopes.set(targetKey(target), { active: true, configuration: { mode: "explicit", selections: [] } });
  const disabled = await h.service.observe({ ...observation, episodeKey: "episode-b" });
  assert.equal(disabled.pendingDeliveryCount, 0);
  assert.equal(h.intentions().size, 1);
});
