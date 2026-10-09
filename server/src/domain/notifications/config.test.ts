import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { NotificationScopeWrite, NotificationTicketView } from "contract";
import { notificationSettingsResponseSchema, notificationScopeResponseSchema } from "contract";
import { createNotificationConfig, initialConfig, settingsView } from "./config.js";
import { createNotificationScopes } from "./scopes.js";
import { notificationRuntimeSelection } from "./tickets.js";
import { createNotificationDatabase } from "./repository.js";
import { targetKey, type NotificationDatabase, type NotificationQuery, type ScopeTarget, type StoredConfig, type StoredScope } from "./types.js";

function harness() {
  let config = initialConfig();
  let scopes = new Map<string, { configuration: StoredScope; active: boolean }>();
  let failCommit = false;
  const statements: string[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    statements.push(sql);
    if (sql.startsWith("INSERT INTO notification_config")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT revision")) return { rows: [{ revision: String(config.revision), document: structuredClone(config) }], rowCount: 1 };
    if (sql.startsWith("UPDATE notification_config")) {
      if (config.revision !== values[1]) return { rows: [], rowCount: 0 };
      config = { ...JSON.parse(values[0] as string), revision: config.revision + 1 };
      return { rows: [{ revision: config.revision }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT configuration FROM")) return { rows: [...scopes.values()].filter((row) => row.active), rowCount: scopes.size };
    if (sql.startsWith("SELECT configuration, active")) return { rows: scopes.has(values[0] as string) ? [scopes.get(values[0] as string)] : [], rowCount: 1 };
    if (sql.includes("INSERT INTO notification_scope")) {
      const key = values[0] as string;
      const removing = sql.includes("DO UPDATE SET active = false");
      scopes.set(key, { configuration: removing && scopes.has(key) ? scopes.get(key)!.configuration : JSON.parse(values[3] as string), active: !removing });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected-sql: ${sql}`);
  };
  const database = {
    query,
    transaction: async <T>(operation: (query: NotificationQuery) => Promise<T>) => {
      const oldConfig = structuredClone(config);
      const oldScopes = structuredClone(scopes);
      try {
        const result = await operation({ query } as NotificationQuery);
        if (failCommit) throw new Error("synthetic-commit-failure");
        return result;
      } catch (error) { config = oldConfig; scopes = oldScopes; throw error; }
    }
  } as NotificationDatabase;
  const stack: ScopeTarget = { kind: "stack", hostId: "host-a", projectName: "project-a" };
  const container: ScopeTarget = { kind: "container", hostId: "host-a", target: { kind: "compose", projectName: "project-a", serviceName: "service-a" } };
  const reader = async (target: ScopeTarget) => ({ exists: target.hostId !== "missing", stack: target.kind === "container" ? stack : null });
  return { database, config: () => config, scopes: () => scopes, statements, stack, container,
    reader, service: createNotificationConfig(database), rules: createNotificationScopes(database, reader), fail: () => { failCommit = true; } };
}
function configuredWrite(config: StoredConfig, expectedRevision = config.revision) {
  return { expectedRevision, format: config.format, defaults: [], hostRules: [], channels: config.channels.map((channel) =>
    channel.kind === "smtp" ? { kind: channel.kind, defaults: channel.defaults, connection: { operation: "clear" } } :
      channel.kind === "webhook" ? { kind: channel.kind, defaults: channel.defaults, endpoint: { operation: "set", value: "https://example.invalid/webhook" }, authorization: { operation: "set", value: "synthetic-token" } } :
        channel.kind === "gotify" ? { kind: channel.kind, defaults: channel.defaults, endpoint: { operation: "clear" }, token: { operation: "clear" } } :
          { kind: channel.kind, defaults: channel.defaults, endpoint: { operation: "set", value: "https://example.invalid/discord" } }) };
}
const explicit = { mode: "explicit", selections: [{ channel: "webhook", events: ["update-failed"],
  overrides: { includeLogs: false, recovery: false, additionalText: "", destination: { operation: "set", value: "https://example.invalid/custom" } } }] };

test("global writes mask every private value and keep/clear secrets atomically", { timeout: 1000 }, async () => {
  const h = harness();
  const view = await h.service.write(configuredWrite(h.config()));
  notificationSettingsResponseSchema.parse({ notifications: view });
  assert.ok(!JSON.stringify(view).includes("example.invalid"));
  assert.ok(!JSON.stringify(view).includes("synthetic-token"));
  const write = configuredWrite(h.config());
  const channel = write.channels.find((item) => item.kind === "webhook")!;
  Object.assign(channel, { endpoint: { operation: "keep" }, authorization: { operation: "keep" } });
  await h.service.write(write);
  assert.equal(h.config().channels.find((item) => item.kind === "webhook")!.authorization, "synthetic-token");
  Object.assign(channel, { authorization: { operation: "clear" } });
  await h.service.write({ ...write, expectedRevision: 2 });
  assert.equal(h.config().channels.find((item) => item.kind === "webhook")!.authorization, null);
  assert.equal(settingsView(h.config()).channels.find((item) => item.kind === "webhook")!.credentialConfigured, false);
  assert.ok(h.statements.some((sql) => sql.includes("FOR UPDATE")));
  assert.ok(h.statements.some((sql) => sql.includes("AND revision = $2")));
});

test("inheritance includes flags/custom destination; explicit empty fully replaces; keep and clear are local", { timeout: 1000 }, async () => {
  const h = harness();
  await h.service.write(configuredWrite(h.config()));
  await h.rules.bulk({ expectedRevision: 1, targets: [h.stack], configuration: explicit });
  const inherited = await h.rules.read(h.container);
  notificationScopeResponseSchema.parse(inherited);
  assert.equal(inherited.inheritedFrom, "stack");
  assert.equal(inherited.effective[0].overrides.includeLogs, false);
  assert.equal(inherited.effective[0].overrides.recovery, false);
  assert.equal(inherited.effective[0].overrides.destinationConfigured, true);
  await h.rules.bulk({ expectedRevision: 2, targets: [h.container], configuration: { mode: "explicit", selections: [] } });
  assert.deepEqual((await h.rules.read(h.container)).effective, []);
  const keep = structuredClone(explicit);
  Object.assign(keep.selections[0].overrides, { destination: { operation: "keep" } });
  await h.rules.bulk({ expectedRevision: 3, targets: [h.stack], configuration: keep });
  assert.equal((await h.rules.read(h.stack)).effective[0].overrides.destinationConfigured, true);
  Object.assign(keep.selections[0].overrides, { destination: { operation: "clear" } });
  await h.rules.bulk({ expectedRevision: 4, targets: [h.stack], configuration: keep });
  assert.equal((await h.rules.read(h.stack)).effective[0].overrides.destinationConfigured, false);
  await h.rules.bulk({ expectedRevision: 5, targets: [h.stack], configuration: { mode: "inherit" } });
  assert.equal(h.scopes().get(targetKey(h.stack))!.configuration.mode, "inherit");
});

test("bulk validates all targets before writes, rejects revision/invalid input and rolls back commit failure", { timeout: 1000 }, async () => {
  const h = harness();
  await h.service.write(configuredWrite(h.config()));
  await assert.rejects(h.rules.bulk({ expectedRevision: 1, targets: [h.stack, { ...h.stack, hostId: "missing" }], configuration: explicit }), { code: "target-unknown" });
  assert.equal(h.scopes().size, 0);
  assert.equal(h.config().revision, 1);
  await assert.rejects(h.rules.bulk({ expectedRevision: 0, targets: [h.stack], configuration: explicit }), { code: "conflict" });
  await assert.rejects(h.rules.bulk({ expectedRevision: 1, targets: [h.stack], configuration: { ...explicit, extra: true } }), { code: "invalid-input" });
  h.fail();
  await assert.rejects(h.rules.bulk({ expectedRevision: 1, targets: [h.stack, h.container], configuration: explicit }), /synthetic-commit-failure/);
  assert.equal(h.scopes().size, 0);
  assert.equal(h.config().revision, 1);
});

test("selected incomplete channels are rejected and removed identities stay disabled until explicit write", { timeout: 1000 }, async () => {
  const h = harness();
  await assert.rejects(h.rules.bulk({ expectedRevision: 0, targets: [h.stack], configuration: explicit }), { code: "configuration-incomplete" });
  const write = configuredWrite(h.config());
  await h.service.write({ ...write, defaults: explicit.selections });
  await h.rules.markRemoved(h.container);
  assert.deepEqual((await h.rules.read(h.container)).effective, []);
  await h.rules.bulk({ expectedRevision: 2, targets: [h.container], configuration: { mode: "inherit" } });
  assert.equal((await h.rules.read(h.container)).effective.length, 1);
});

test("SMTP private connection is masked; malformed secrets and extra DTO fields fail closed", { timeout: 1000 }, async () => {
  const h = harness();
  const write = configuredWrite(h.config());
  Object.assign(write.channels.find((item) => item.kind === "smtp")!, { connection: { operation: "set", value: {
    host: "example.invalid", port: 465, security: "tls", username: "synthetic-user", password: "synthetic-password",
    from: "sender@example.invalid", to: ["recipient@example.invalid"] } } });
  const view = await h.service.write(write);
  assert.ok(!JSON.stringify(view).includes("example.invalid"));
  assert.ok(!JSON.stringify(view).includes("synthetic-password"));
  await assert.rejects(h.service.write({ ...configuredWrite(h.config()), channels: write.channels.map((channel) =>
    channel.kind === "webhook" ? { ...channel, authorization: { operation: "set", value: "unsafe\r\nheader" } } : channel) }), { code: "invalid-input" });
  assert.equal(notificationSettingsResponseSchema.safeParse({ notifications: { ...view, connection: "private" } }).success, false);
});

test("pool adapter rolls back commit errors and always releases connection", { timeout: 1000 }, async () => {
  const calls: string[] = [];
  const pool = { connect: async () => ({ query: async (sql: string) => {
    calls.push(sql);
    if (sql === "COMMIT") throw new Error("synthetic-commit-failure");
    return { rows: [], rowCount: 0 };
  }, release: () => calls.push("release") }), query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
  await assert.rejects(createNotificationDatabase(pool).transaction(async (query) => { await query.query("SELECT 1"); return 1; }), /synthetic-commit-failure/);
  assert.deepEqual(calls, ["BEGIN", "SELECT 1", "COMMIT", "ROLLBACK", "release"]);
});


test("revision losers and over-limit bulk cannot make partial progress", { timeout: 1000 }, async () => {
  const h = harness();
  await h.service.write(configuredWrite(h.config()));
  await h.rules.bulk({ expectedRevision: 1, targets: [h.stack], configuration: explicit });
  await assert.rejects(h.rules.bulk({ expectedRevision: 1, targets: [h.container], configuration: explicit }), { code: "conflict" });
  const targets = Array.from({ length: 201 }, (_, i) => ({ ...h.stack, projectName: `project-${i}` }));
  await assert.rejects(h.rules.bulk({ expectedRevision: 2, targets, configuration: explicit }), { code: "invalid-input" });
  assert.equal(h.scopes().size, 1);
  assert.equal(h.config().revision, 2);
});

const reactivationTargets: ScopeTarget[] = [
  { kind: "stack", hostId: "host-a", projectName: "project-a" },
  { kind: "container", hostId: "host-a", target: { kind: "container", containerName: "container-a" } },
  { kind: "container", hostId: "host-a", target: { kind: "compose", projectName: "project-a", serviceName: "service-a" } }
];
function runtimeTicket(target: ScopeTarget): NotificationTicketView {
  return { id: "ticket-a", target, targetLabel: "Synthetic target", episodeKey: "episode-a", event: "update-failed",
    action: "inspect-update", cause: "Synthetic failure", state: "open", openedAt: "2026-01-01T00:00:00.000Z",
    acknowledgedAt: null, resolvedAt: null, affectedContainers: [], affectedContainerCount: 0,
    pendingDeliveryCount: 0, evidence: { logs: { state: "unavailable", reason: "not-collected" } } };
}
const reactivationPaths = [
  ...reactivationTargets.map((target, index) => ({ name: `single-${index}`, targets: [target], single: true })),
  ...reactivationTargets.map((target, index) => ({ name: `bulk-${index}`, targets: [target], single: false })),
  { name: "bulk-mixed", targets: reactivationTargets, single: false }
];
for (const path of reactivationPaths) for (const channel of ["webhook", "discord"] as const) {
  for (const command of ["keep", "missing", "clear", "set", "inherit", "removed-channel", "empty"] as const) {
    test(`inactive reactivation ${path.name}/${channel}/${command} retains only authorized rules`, { timeout: 1000 }, async () => {
      const h = harness();
      await h.service.write({ ...configuredWrite(h.config()), defaults: explicit.selections });
      const selection = (destination?: { operation: "keep" | "clear" } | { operation: "set"; value: string }): NotificationScopeWrite => ({
        mode: "explicit", selections: [{ channel, events: ["update-failed"],
          overrides: { includeLogs: false, recovery: false, additionalText: "", ...(destination ? { destination } : {}) } }] });
      const local = (target: ScopeTarget) => `https://example.invalid/local/${encodeURIComponent(targetKey(target))}`;
      for (const target of path.targets) {
        await h.rules.write({ target, expectedRevision: h.config().revision, configuration: selection({ operation: "set", value: local(target) }) });
        await h.rules.markRemoved(target);
      }
      const beforeRead = structuredClone(h.scopes());
      for (const target of path.targets) {
        assert.deepEqual(await notificationRuntimeSelection(h.database, h.config(), runtimeTicket(target), h.reader), []);
        const view = await h.rules.read(target);
        assert.deepEqual(view.configuration, { mode: "explicit", selections: [] });
        assert.deepEqual(view.effective, []);
        const stored = h.scopes().get(targetKey(target))!;
        assert.equal(stored.active, false);
        assert.equal(stored.configuration.mode === "explicit" && stored.configuration.selections[0].overrides.destination, local(target));
      }
      assert.deepEqual(h.scopes(), beforeRead);
      const replacement = "https://example.invalid/replacement";
      const configuration: NotificationScopeWrite = command === "inherit" ? { mode: "inherit" } :
        command === "empty" || command === "removed-channel" ? { mode: "explicit", selections: [] } :
          selection(command === "missing" ? undefined : command === "set" ? { operation: "set", value: replacement } : { operation: command });
      // A different selected channel proves omission removes only the old channel override.
      if (command === "removed-channel") Object.assign(configuration, selection({ operation: "keep" }), {
        selections: [{ channel: channel === "webhook" ? "discord" : "webhook", events: ["update-failed"], overrides: {} }] });
      const expectedRevision = h.config().revision;
      const responses = path.single ? [await h.rules.write({ target: path.targets[0], expectedRevision, configuration })] :
        (await h.rules.bulk({ targets: path.targets, expectedRevision, configuration })).targets;
      assert.equal(h.config().revision, expectedRevision + 1);
      for (const [index, target] of path.targets.entries()) {
        const stored = h.scopes().get(targetKey(target))!;
        assert.equal(stored.active, true);
        const expected: StoredScope = configuration.mode === "inherit" ? { mode: "inherit" } : {
          mode: "explicit", selections: configuration.selections.map(({ overrides: { destination: _destination, ...flags }, ...rule }) => {
            void _destination;
            return { ...rule, overrides: { ...flags, destination: command === "keep" || command === "missing" ? local(target) : command === "set" ? replacement : null } };
          }) };
        assert.deepEqual(stored.configuration, expected);
        const runtime = await notificationRuntimeSelection(h.database, h.config(), runtimeTicket(target), h.reader);
        const expectedRules = expected.mode === "explicit" ? expected.selections : h.config().defaults;
        assert.deepEqual(runtime.map(({ selection }) => selection), expectedRules);
        const view = responses[index];
        notificationScopeResponseSchema.parse(view);
        assert.deepEqual(await h.rules.read(target), view);
        assert.deepEqual(view.effective, expectedRules.map(({ overrides: { destination, ...flags }, ...rule }) => ({
          ...rule, overrides: { ...flags, destinationConfigured: destination !== null } })));
        assert.ok(!JSON.stringify(view).includes("example.invalid"));
      }
    });
  }
}
