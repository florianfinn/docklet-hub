import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTRACT_VERSION, DEFAULT_NOTIFICATION_DELIVERY_OPTIONS, DEFAULT_NOTIFICATION_FORMAT,
  NOTIFICATION_API_VERSION, NOTIFICATION_CHANNELS, NOTIFICATION_EVENTS, NOTIFICATION_LIMITS,
  notificationAckRequestSchema, notificationAdditionalTextSchema, notificationBulkRequestSchema,
  notificationBulkResponseSchema, notificationChannelViewSchema, notificationChannelWriteSchema,
  notificationCountsResponseSchema, notificationDeliveriesQuerySchema, notificationDeliveriesResponseSchema,
  notificationDeliveryResponseSchema, notificationDeliveryViewSchema, notificationFailureSchema,
  notificationFormatSchema, notificationRetryRequestSchema, notificationScopeRequestSchema,
  notificationScopeResponseSchema, notificationScopeViewSchema, notificationScopeWriteSchema,
  notificationSecretInputSchema, notificationSelectionViewSchema, notificationSelectionWriteSchema,
  notificationSettingsResponseSchema, notificationSettingsWriteSchema, notificationTargetRequestSchema,
  notificationTargetSchema, notificationTargetWriteRequestSchema, notificationTemplateSchema,
  notificationTestRequestSchema, notificationTicketResponseSchema, notificationTicketsQuerySchema,
  notificationTicketsResponseSchema, notificationTicketViewSchema, resolveNotificationSelection,
  type NotificationSelectionView, type NotificationScopeView
} from "contract";

const now = "2026-01-01T00:00:00Z";
const later = "2026-01-01T00:01:00Z";
const options = { ...DEFAULT_NOTIFICATION_DELIVERY_OPTIONS };
const host = { kind: "host", hostId: "host-example" } as const;
const stack = { kind: "stack", hostId: host.hostId, projectName: "example-project" } as const;
const container = { kind: "container", hostId: host.hostId,
  target: { kind: "container", containerName: "example-container" } } as const;
const compose = { kind: "container", hostId: host.hostId,
  target: { kind: "compose", projectName: stack.projectName, serviceName: "example-service" } } as const;
const selection: NotificationSelectionView = { channel: "discord", events: ["self-healing-exhausted"],
  overrides: { additionalText: "Inspect {target}", includeLogs: true, recovery: true, destinationConfigured: true } };
const writeSelection = { channel: "discord", events: ["self-healing-exhausted"], overrides: {
  additionalText: "Inspect {target}", includeLogs: true, recovery: true,
  destination: { operation: "set", value: "https://example.invalid/destination" }
} };
const viewChannels = NOTIFICATION_CHANNELS.map((kind) => ({ kind, configured: false,
  destinationConfigured: false, credentialConfigured: false, defaults: options }));
const settings = { revision: 0, channels: viewChannels, format: DEFAULT_NOTIFICATION_FORMAT, defaults: [], hostRules: [] };
const keep = { operation: "keep" } as const;
const connection = { host: "smtp.example.invalid", port: 465, security: "tls", username: null, password: null,
  from: "sender@example.invalid", to: ["recipient@example.invalid"] };
const writes = [
  { kind: "discord", endpoint: keep, defaults: options },
  { kind: "smtp", connection: { operation: "set", value: connection }, defaults: options },
  { kind: "gotify", endpoint: keep, token: keep, defaults: options },
  { kind: "webhook", endpoint: keep, authorization: keep, defaults: options }
];
const settingsWrite = { expectedRevision: 0, channels: writes, format: DEFAULT_NOTIFICATION_FORMAT,
  defaults: [], hostRules: [] };
const ticket = { id: "ticket-example", episodeKey: "episode-example", event: "connection-lost", target: host,
  targetLabel: "Example host", cause: "Connection unavailable", action: "check-connection", state: "open",
  openedAt: now, acknowledgedAt: null, resolvedAt: null, affectedContainers: [], affectedContainerCount: 0, pendingDeliveryCount: 0 };
const delivery = { id: "delivery-example", ticketId: ticket.id, phase: "initial", channel: "discord", generation: 0,
  state: "queued", attempts: 0, createdAt: now, updatedAt: now, nextAttemptAt: now, finishedAt: null,
  failure: null, includeLogs: false };
function rejects(schema: { safeParse: (value: unknown) => { success: boolean } }, values: unknown[]) {
  for (const value of values) assert.equal(schema.safeParse(value).success, false, JSON.stringify(value));
}

test("notification constants fix the API, agent boundary, retries and retention", () => {
  assert.equal(NOTIFICATION_API_VERSION, 1);
  assert.equal(CONTRACT_VERSION, 13);
  assert.deepEqual(NOTIFICATION_EVENTS, ["self-healing-exhausted", "connection-lost", "update-failed", "agent-update-available", "container-update-available"]);
  assert.deepEqual(NOTIFICATION_CHANNELS, ["discord", "smtp", "gotify", "webhook"]);
  assert.equal(NOTIFICATION_LIMITS.connectionGraceMs, 300_000);
  assert.deepEqual(NOTIFICATION_LIMITS.retryDelaysMs, [30_000, 120_000, 600_000]);
  assert.equal(NOTIFICATION_LIMITS.maxAttempts, 4);
  assert.equal(NOTIFICATION_LIMITS.deliveryTimeoutMs, 15_000);
  assert.equal(NOTIFICATION_LIMITS.resolvedRetentionMs, 2_592_000_000);
  assert.equal(NOTIFICATION_LIMITS.terminalDeliveryRetentionMs, 2_592_000_000);
  assert.equal(NOTIFICATION_LIMITS.maxQueuedDeliveries, 10_000);
  assert.equal(NOTIFICATION_LIMITS.maxTerminalDeliveries, 10_000);
  assert.equal(NOTIFICATION_LIMITS.maxHistoryEntriesPerTicket, 100);
});

test("templates accept only four bounded literal placeholders", () => {
  for (const value of ["", "Plain text", "{target} {cause} {time} {action}", "{target}{target}", "a".repeat(2000)])
    assert.equal(notificationTemplateSchema.safeParse(value).success, true);
  rejects(notificationTemplateSchema, ["{unknown}", "{target.name}", "{{target}}", "{target", "target}", "{target()}",
    "${{target}}", "a".repeat(2001), undefined, null]);
  assert.equal(notificationFormatSchema.safeParse(DEFAULT_NOTIFICATION_FORMAT).success, true);
  for (const key of ["target", "cause", "time", "action"])
    assert.equal(notificationFormatSchema.safeParse(DEFAULT_NOTIFICATION_FORMAT.replace(`{${key}}`, "")).success, false);
  rejects(notificationFormatSchema, ["", "Plain text"]);
  assert.equal(notificationAdditionalTextSchema.safeParse("a".repeat(1000)).success, true);
  rejects(notificationAdditionalTextSchema, ["a".repeat(1001), "{secret}"]);
});

test("stable target identities include host, project and service, never Docker bindings", () => {
  for (const target of [host, stack, container, compose]) assert.deepEqual(notificationTargetSchema.parse(target), target);
  rejects(notificationTargetSchema, [{ kind: "container", hostId: host.hostId, containerId: "docker-example" },
    { ...stack, projectName: "" }, { ...compose, target: { kind: "compose", projectName: "p" } },
    { ...container, hostId: "x".repeat(201) }, { ...container, target: { ...container.target, containerId: "docker-example" } }]);
  assert.deepEqual(notificationTargetRequestSchema.parse({ target: compose }), { target: compose });
  rejects(notificationTargetRequestSchema, [{ target: host }, { target: compose, extra: true }]);
});

test("all channel write variants accept keep, replace and clear with complete SMTP TLS", () => {
  for (const channel of writes) assert.deepEqual(notificationChannelWriteSchema.parse(channel), channel);
  for (const operation of ["keep", "clear"])
    assert.equal(notificationChannelWriteSchema.safeParse({ ...writes[1], connection: { operation } }).success, true);
  for (const operation of ["keep", "clear", "set"]) {
    const input = operation === "set" ? { operation, value: "synthetic-example-value" } : { operation };
    assert.deepEqual(notificationSecretInputSchema.parse(input), input);
  }
  for (const security of ["tls", "starttls"])
    assert.equal(notificationChannelWriteSchema.safeParse({ ...writes[1], connection: {
      operation: "set", value: { ...connection, security, username: "example-user", password: "synthetic-example-value" }
    } }).success, true);
  rejects(notificationSecretInputSchema, [{ operation: "set", value: "" }, { operation: "keep", value: "x" },
    { operation: "set", value: "x".repeat(4097) }, { operation: "set", value: "x\r\nHeader: injected" },
    { operation: "set", value: "x\u0000" }, "synthetic-example-value"]);
});

test("channel configuration rejects unsafe protocols and malformed SMTP inputs", () => {
  for (const url of ["https://example.invalid/destination", "http://example.invalid/destination"])
    assert.equal(notificationChannelWriteSchema.safeParse({ ...writes[0], endpoint: { operation: "set", value: url } }).success, true);
  for (const value of ["file:///example", "ftp://example.invalid", "https://user:pass@example.invalid/path", "https://@example.invalid/path", "https://example.invalid/path\nvalue", "https://example.invalid/path\rvalue", "https://example.invalid/path\tvalue", "bad"])
    assert.equal(notificationChannelWriteSchema.safeParse({ ...writes[0], endpoint: { operation: "set", value } }).success, false);
  for (const change of [{ security: "none" }, { port: 0 }, { port: 65536 }, { port: 465.5 }, { to: [] },
    { from: "not-an-address" }, { username: "example-user" }, { password: "synthetic-example-value" }])
    assert.equal(notificationChannelWriteSchema.safeParse({ ...writes[1], connection: { operation: "set", value: { ...connection, ...change } } }).success, false);
  rejects(notificationChannelWriteSchema, [{ ...writes[0], token: keep }, { ...writes[0], kind: "unknown" }]);
});

test("admin channel and selection views cannot carry secrets or destinations", () => {
  for (const view of viewChannels) assert.deepEqual(notificationChannelViewSchema.parse(view), view);
  for (const field of ["endpoint", "token", "password", "connection", "authorization", "host", "from", "to"])
    assert.equal(notificationChannelViewSchema.safeParse({ ...viewChannels[0], [field]: "synthetic-example-value" }).success, false);
  assert.deepEqual(notificationSelectionViewSchema.parse(selection), selection);
  rejects(notificationSelectionViewSchema, [writeSelection, { ...selection, overrides: { ...selection.overrides, destination: "https://example.invalid" } }]);
  rejects(notificationSelectionWriteSchema, [selection]);
});

test("global settings require exactly four unique transports and opt-in rules", () => {
  assert.deepEqual(notificationSettingsResponseSchema.parse({ notifications: settings }), { notifications: settings });
  assert.deepEqual(notificationSettingsWriteSchema.parse(settingsWrite), settingsWrite);
  assert.deepEqual(options, { includeLogs: false, recovery: false, additionalText: "" });
  rejects(notificationSettingsWriteSchema, [{ ...settingsWrite, channels: writes.slice(1) },
    { ...settingsWrite, channels: [writes[0], writes[0], writes[2], writes[3]] },
    { ...settingsWrite, expectedRevision: -1 }, { ...settingsWrite, revision: 0 },
    { ...settingsWrite, defaults: [writeSelection, writeSelection] }]);
  rejects(notificationSettingsResponseSchema, [{ notifications: { ...settings, channels: viewChannels.slice(1) } },
    { notifications: { ...settings, channels: writes } }]);
});

test("host and target event domains are disjoint where required and deduplicated", () => {
  for (const event of ["connection-lost", "update-failed", "agent-update-available"])
    assert.equal(notificationSettingsWriteSchema.safeParse({ ...settingsWrite, hostRules: [
      { channel: "smtp", events: [event], overrides: { includeLogs: false, recovery: true } }
    ] }).success, true);
  for (const events of [["self-healing-exhausted"], ["container-update-available"], [], ["connection-lost", "connection-lost"]])
    assert.equal(notificationSettingsWriteSchema.safeParse({ ...settingsWrite, hostRules: [{ channel: "smtp", events, overrides: {} }] }).success, false);
  for (const events of [["self-healing-exhausted"], ["update-failed"], ["container-update-available"]])
    assert.equal(notificationSelectionWriteSchema.safeParse({ ...writeSelection, events }).success, true);
  for (const events of [["agent-update-available"], ["connection-lost"], [], ["update-failed", "update-failed"]])
    assert.equal(notificationSelectionWriteSchema.safeParse({ ...writeSelection, events }).success, false);
  for (const channel of ["smtp", "gotify"])
    assert.equal(notificationSelectionWriteSchema.safeParse({ ...writeSelection, channel }).success, false);
});

test("inheritance preserves stack additions, explicit container replaces them, empty disables", () => {
  const inherit: NotificationScopeView = { mode: "inherit" };
  const explicit: NotificationScopeView = { mode: "explicit", selections: [selection] };
  const off: NotificationScopeView = { mode: "explicit", selections: [] };
  const own: NotificationScopeView = { mode: "explicit", selections: [{ channel: "smtp", events: ["update-failed"],
    overrides: { includeLogs: false, destinationConfigured: false } }] };
  assert.deepEqual(resolveNotificationSelection([selection], inherit), { inheritedFrom: "global", effective: [selection] });
  assert.deepEqual(resolveNotificationSelection([], explicit, inherit), { inheritedFrom: "stack", effective: [selection] });
  assert.deepEqual(resolveNotificationSelection([selection], off, inherit), { inheritedFrom: "stack", effective: [] });
  assert.deepEqual(resolveNotificationSelection([selection], explicit, off), { inheritedFrom: "container", effective: [] });
  assert.deepEqual(resolveNotificationSelection([selection], explicit, own), { inheritedFrom: "container", effective: own.selections });
  assert.deepEqual(resolveNotificationSelection([selection], inherit, inherit), { inheritedFrom: "global", effective: [selection] });
  for (const value of [inherit, explicit, off]) assert.deepEqual(notificationScopeViewSchema.parse(value), value);
  rejects(notificationScopeViewSchema, [{ mode: "inherit", selections: [] }, { ...explicit, selections: [selection, selection] }]);
  assert.deepEqual(notificationScopeWriteSchema.parse({ mode: "explicit", selections: [] }), { mode: "explicit", selections: [] });
});

test("scope and bulk writes bind revision, stable mixed targets and complete replacement", () => {
  const configuration = { mode: "explicit", selections: [writeSelection] };
  const scope = { expectedRevision: 7, configuration };
  assert.deepEqual(notificationScopeRequestSchema.parse(scope), scope);
  assert.deepEqual(notificationTargetWriteRequestSchema.parse({ target: compose, ...scope }), { target: compose, ...scope });
  const bulk = { ...scope, targets: [stack, container, compose] };
  assert.deepEqual(notificationBulkRequestSchema.parse(bulk), bulk);
  rejects(notificationBulkRequestSchema, [{ ...bulk, targets: [] }, { ...bulk, targets: [host] },
    { ...bulk, targets: [container, container] }, { ...bulk, expectedRevision: 1.5 }, { ...bulk, append: true },
    { ...bulk, targets: Array.from({ length: 201 }, (_, i) => ({ ...stack, projectName: `project-${i}` })) }]);
  assert.equal(notificationBulkRequestSchema.safeParse({ ...bulk,
    targets: Array.from({ length: 200 }, (_, i) => ({ ...stack, projectName: `project-${i}` })) }).success, true);
  const response = { target: compose, revision: 8, configuration: { mode: "inherit" }, inheritedFrom: "stack", effective: [selection] };
  assert.deepEqual(notificationScopeResponseSchema.parse(response), response);
  assert.deepEqual(notificationBulkResponseSchema.parse({ revision: 8, targets: [response] }), { revision: 8, targets: [response] });
});

test("ticket lifecycle fixes acknowledgement without accepting rearm or manual resolution", () => {
  const acknowledged = { ...ticket, state: "acknowledged", acknowledgedAt: later };
  const resolved = { ...acknowledged, state: "resolved", resolvedAt: later };
  for (const value of [ticket, acknowledged, resolved, { ...ticket, state: "resolved", resolvedAt: later }])
    assert.deepEqual(notificationTicketViewSchema.parse(value), value);
  assert.deepEqual(notificationAckRequestSchema.parse({}), {});
  rejects(notificationAckRequestSchema, [{ rearm: true }, { resolved: true }, { state: "open" }]);
  rejects(notificationTicketViewSchema, [{ ...ticket, state: "acknowledged" }, { ...ticket, acknowledgedAt: later },
    { ...ticket, state: "resolved" }, { ...ticket, resolvedAt: later },
    { ...acknowledged, acknowledgedAt: "2025-01-01T00:00:00Z" }, { ...resolved, resolvedAt: now },
    { ...ticket, openedAt: "invalid" }, { ...ticket, cause: "" }, { ...ticket, cause: "x".repeat(1001) }]);
  assert.equal(notificationTicketViewSchema.safeParse({ ...resolved, openedAt: "2026-01-01T00:00:00.000Z" }).success, true);
});

test("each ticket event requires its real target domain and recommended action", () => {
  for (const [event, target, action] of [
    ["self-healing-exhausted", compose, "inspect-self-healing"], ["update-failed", stack, "inspect-update"],
    ["agent-update-available", host, "review-update"], ["container-update-available", container, "review-update"]] as const)
    assert.equal(notificationTicketViewSchema.safeParse({ ...ticket, event, target, action }).success, true);
  rejects(notificationTicketViewSchema, [{ ...ticket, target: container }, { ...ticket, event: "self-healing-exhausted" },
    { ...ticket, event: "container-update-available", action: "review-update" }, { ...ticket, action: "inspect-update" },
    { ...ticket, event: "agent-update-available", action: "review-update", target: stack }]);
});

test("host outage bundles a bounded sample without lying about affected count", () => {
  const affectedContainers = Array.from({ length: 200 }, (_, i) => ({ containerId: `example-${i}`, label: `Example ${i}` }));
  assert.equal(notificationTicketViewSchema.safeParse({ ...ticket, affectedContainers, affectedContainerCount: 250 }).success, true);
  rejects(notificationTicketViewSchema, [{ ...ticket, affectedContainers, affectedContainerCount: 199 },
    { ...ticket, affectedContainers: [...affectedContainers, affectedContainers[0]], affectedContainerCount: 201 },
    { ...ticket, affectedContainers: [affectedContainers[0], affectedContainers[0]], affectedContainerCount: 2 },
    { ...ticket, event: "update-failed", action: "inspect-update", affectedContainerCount: 1 }]);
});

test("delivery views model queued, sending, retries, terminal errors and tests without raw diagnostics", () => {
  const sending = { ...delivery, state: "sending", attempts: 1, nextAttemptAt: null };
  const retrying = { ...delivery, state: "retrying", attempts: 1, failure: "transient", nextAttemptAt: later };
  const delivered = { ...sending, state: "delivered", updatedAt: later, finishedAt: later };
  const failed = { ...sending, state: "failed", failure: "authentication", updatedAt: later, finishedAt: later };
  for (const value of [delivery, sending, retrying, delivered, failed, { ...failed, attempts: 4, failure: "timeout" },
    { ...failed, state: "cancelled", attempts: 0, failure: null }, { ...delivery, phase: "test", ticketId: null }])
    assert.deepEqual(notificationDeliveryViewSchema.parse(value), value);
  rejects(notificationDeliveryViewSchema, [{ ...delivery, attempts: 1 }, { ...sending, attempts: 0 },
    { ...retrying, attempts: 4 }, { ...retrying, failure: "authentication" }, { ...retrying, nextAttemptAt: null },
    { ...delivered, failure: "transient" }, { ...failed, failure: null }, { ...failed, nextAttemptAt: later },
    { ...delivery, phase: "test" }, { ...delivery, ticketId: null }, { ...delivery, responseBody: "raw-example" },
    { ...retrying, nextAttemptAt: now }, { ...failed, failure: "transient" },
    { ...failed, updatedAt: now }, { ...delivery, endpoint: "https://example.invalid" }, { ...delivery, attempts: 5 }, { ...delivery, generation: -1 }]);
});

test("paged tickets, deliveries and navigation counts preserve exact response shapes", () => {
  for (const query of [{}, { state: "acknowledged", event: "update-failed", hostId: host.hostId, targetKind: "container", limit: 100, cursor: "cursor-example" }])
    assert.deepEqual(notificationTicketsQuerySchema.parse(query), query);
  rejects(notificationTicketsQuerySchema, [{ limit: 101 }, { limit: 0 }, { limit: "50" }, { state: "closed" }, { cursor: "" }]);
  assert.deepEqual(notificationDeliveriesQuerySchema.parse({ state: "failed", channel: "smtp", ticketId: ticket.id }),
    { state: "failed", channel: "smtp", ticketId: ticket.id });
  assert.deepEqual(notificationTicketResponseSchema.parse({ ticket }), { ticket });
  assert.deepEqual(notificationTicketsResponseSchema.parse({ tickets: [ticket], nextCursor: null }), { tickets: [ticket], nextCursor: null });
  assert.deepEqual(notificationDeliveryResponseSchema.parse({ delivery }), { delivery });
  assert.deepEqual(notificationDeliveriesResponseSchema.parse({ deliveries: [delivery], nextCursor: "cursor-example" }),
    { deliveries: [delivery], nextCursor: "cursor-example" });
  rejects(notificationTicketsResponseSchema, [{ tickets: Array(101).fill(ticket), nextCursor: null }]);
  rejects(notificationDeliveriesResponseSchema, [{ deliveries: Array(101).fill(delivery), nextCursor: null }]);
  assert.deepEqual(notificationCountsResponseSchema.parse({ open: 2, acknowledged: 3, active: 5 }), { open: 2, acknowledged: 3, active: 5 });
  rejects(notificationCountsResponseSchema, [{ open: 2, acknowledged: 3, active: 2 }, { open: -1, acknowledged: 1, active: 0 }]);
});

test("manual retry and test requests carry no new event, secret or repair action", () => {
  assert.deepEqual(notificationRetryRequestSchema.parse({ expectedGeneration: 0 }), { expectedGeneration: 0 });
  rejects(notificationRetryRequestSchema, [{}, { expectedGeneration: -1 }, { expectedGeneration: 0, rearm: true }]);
  assert.deepEqual(notificationTestRequestSchema.parse({ channel: "smtp" }), { channel: "smtp" });
  rejects(notificationTestRequestSchema, [{ channel: "unknown" }, { channel: "smtp", endpoint: "https://example.invalid" }]);
  assert.deepEqual(notificationFailureSchema.parse({ error: "queue-full" }), { error: "queue-full" });
  rejects(notificationFailureSchema, [{ error: "queue-full", message: "raw-example" }, { error: "unknown" }]);
});
