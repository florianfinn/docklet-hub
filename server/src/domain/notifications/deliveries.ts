import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { NOTIFICATION_LIMITS, notificationChannelSchema, notificationDeliveriesQuerySchema, notificationDeliveriesResponseSchema,
  notificationDeliveryViewSchema, notificationIdSchema, notificationInstantSchema, notificationRetryRequestSchema,
  DEFAULT_NOTIFICATION_FORMAT, type NotificationChannel, type NotificationDeliveriesQuery, type NotificationDeliveryView } from "contract";
import type { NotificationRuntimeConfig, NotificationTransportOutcome } from "../../platform/notification-delivery/index.js";
import { channelConfigured, readConfig } from "./config.js";
import { NotificationDeliveryError, type NotificationDeliveryClaim, type NotificationDeliveryDependencies,
  type NotificationDeliveryRow, type NotificationDeliverySnapshot, type NotificationPreparedDispatch,
  type NotificationDeliveryCancellation, type NotificationDeliveryFailure } from "./delivery-types.js";
import { renderNotificationMessage, NotificationMessageError } from "./message.js";
import { admitNotificationIntention, notificationBindingDigest, notificationRuntimeSelection, pendingNotificationIntentions } from "./tickets.js";
import type { NotificationDatabase, NotificationQuery, StoredChannel, StoredConfig, StoredSelection } from "./types.js";

const activeStates = ["queued", "sending", "retrying"];
export const NOTIFICATION_DELIVERY_LEASE_MS = NOTIFICATION_LIMITS.deliveryTimeoutMs + 5000;
const iso = (value: Date | string) => new Date(value).toISOString();
function view(row: NotificationDeliveryRow): NotificationDeliveryView {
  return notificationDeliveryViewSchema.parse({ id: row.id, ticketId: row.ticket_id, phase: row.phase, channel: row.channel,
    generation: Number(row.generation), state: row.state, attempts: row.attempts,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), nextAttemptAt: row.next_attempt_at === null ? null : iso(row.next_attempt_at),
    finishedAt: row.finished_at === null ? null : iso(row.finished_at), failure: row.failure, includeLogs: row.include_logs });
}
function validId(id: string): void {
  if (!notificationIdSchema.safeParse(id).success) throw new NotificationDeliveryError("invalid-input");
}
function validClaim(claim: NotificationDeliveryClaim): void {
  validId(claim.id);
  if (!Number.isSafeInteger(claim.generation) || claim.generation < 0 || typeof claim.token !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(claim.token)) throw new NotificationDeliveryError("invalid-input");
}
function batchSize(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new NotificationDeliveryError("invalid-input");
}
function owned(row: NotificationDeliveryRow, claim: NotificationDeliveryClaim, now: Date): boolean {
  return row.state === "sending" && Number(row.generation) === claim.generation && row.claim_token === claim.token &&
    row.lease_deadline !== null && Date.parse(iso(row.lease_deadline)) > now.getTime();
}
// All writers acquire the configuration singleton before queue/intention rows.
function repository(query: NotificationQuery) {
  const read = async (id: string, lock = false) => {
    const result = await query.query<NotificationDeliveryRow>(`SELECT * FROM notification_delivery WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
    const row = result.rows[0];
    if (!row) throw new NotificationDeliveryError("delivery-unknown");
    return row;
  };
  return {
    read,
    activeCount: async () => Number((await query.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM notification_delivery WHERE state IN ('queued', 'sending', 'retrying')")).rows[0].count),
    insert: async (row: NotificationDeliveryRow) => {
      const result = await query.query<NotificationDeliveryRow>(`INSERT INTO notification_delivery
        (id,ticket_id,phase,channel,generation,state,attempts,created_at,updated_at,next_attempt_at,finished_at,failure,include_logs,private_snapshot)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
        ON CONFLICT (ticket_id,phase,channel) DO NOTHING RETURNING *`,
      [row.id, row.ticket_id, row.phase, row.channel, row.generation, row.state, row.attempts, row.created_at, row.updated_at,
        row.next_attempt_at, row.finished_at, row.failure, row.include_logs, JSON.stringify(row.private_snapshot)]);
      return result.rows[0] ?? null;
    },
    existing: async (ticket: string, phase: string, channel: string) => (await query.query<{ id: string }>(
      "SELECT id FROM notification_delivery WHERE ticket_id = $1 AND phase = $2 AND channel = $3", [ticket, phase, channel])).rows[0],
    due: async (now: string, limit: number, expired = false) => (await query.query<NotificationDeliveryRow>(expired
      ? `SELECT * FROM notification_delivery WHERE state = 'sending' AND lease_deadline <= $1 ORDER BY lease_deadline, id LIMIT $2 FOR UPDATE SKIP LOCKED`
      : `SELECT * FROM notification_delivery WHERE state IN ('queued', 'retrying') AND next_attempt_at <= $1 ORDER BY next_attempt_at, id LIMIT $2 FOR UPDATE SKIP LOCKED`,
    [now, limit])).rows,
    save: async (old: NotificationDeliveryRow, row: NotificationDeliveryRow) => {
      const result = await query.query<NotificationDeliveryRow>(`UPDATE notification_delivery SET
        generation=$2,state=$3,attempts=$4,updated_at=$5,next_attempt_at=$6,finished_at=$7,failure=$8,
        include_logs=$9,private_snapshot=$10::jsonb,claim_token=$11,lease_deadline=$12,cancellation_reason=$13
        WHERE id=$1 AND generation=$14 AND state=$15 AND claim_token IS NOT DISTINCT FROM $16 RETURNING *`,
      [row.id, row.generation, row.state, row.attempts, row.updated_at, row.next_attempt_at, row.finished_at, row.failure,
        row.include_logs, JSON.stringify(row.private_snapshot), row.claim_token, row.lease_deadline, row.cancellation_reason,
        Number(old.generation), old.state, old.claim_token]);
      if (result.rowCount !== 1) throw new NotificationDeliveryError("conflict");
      return result.rows[0];
    },
    recordTerminal: async (row: NotificationDeliveryRow) => {
      await query.query(`INSERT INTO notification_delivery_history (delivery_id,ticket_id,generation,state,attempts,failure,finished_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (delivery_id,generation) DO NOTHING`,
      [row.id, row.ticket_id, Number(row.generation), row.state, row.attempts, row.failure, row.finished_at]);
      await query.query(`DELETE FROM notification_delivery_history WHERE sequence IN
        (SELECT sequence FROM notification_delivery_history WHERE
          ($1::text IS NOT NULL AND ticket_id=$1) OR ($1::text IS NULL AND delivery_id=$2)
          ORDER BY sequence DESC OFFSET $3)`, [row.ticket_id, row.id, NOTIFICATION_LIMITS.maxHistoryEntriesPerTicket]);
    },
    prune: async (now: Date) => {
      const result = await query.query(`DELETE FROM notification_delivery WHERE id IN (
        SELECT id FROM (SELECT id,finished_at,row_number() OVER (ORDER BY finished_at DESC,id DESC) AS position
          FROM notification_delivery WHERE state IN ('delivered','failed','cancelled')) terminal
        WHERE finished_at < $1 OR position > $2)`,
      [new Date(now.getTime() - NOTIFICATION_LIMITS.terminalDeliveryRetentionMs).toISOString(), NOTIFICATION_LIMITS.maxTerminalDeliveries]);
      return result.rowCount ?? 0;
    }
  };
}
function queued(snapshot: NotificationDeliverySnapshot, channel: NotificationChannel, phase: NotificationDeliveryRow["phase"],
  ticketId: string | null, now: Date): NotificationDeliveryRow {
  return { id: randomUUID(), ticket_id: ticketId, phase, channel, generation: 0, state: "queued", attempts: 0,
    created_at: now.toISOString(), updated_at: now.toISOString(), next_attempt_at: now.toISOString(), finished_at: null,
    failure: null, include_logs: phase !== "test" && snapshot.options.includeLogs, private_snapshot: snapshot,
    claim_token: null, lease_deadline: null, cancellation_reason: null };
}
function testSnapshot(config: StoredConfig, channel: StoredChannel, now: Date): NotificationDeliverySnapshot {
  return { ticket: { id: "notification-test", episodeKey: "notification-test", event: "connection-lost",
    target: { kind: "host", hostId: "notification-test" }, targetLabel: "Gespeicherter Meldekanal",
    cause: "Testnachricht zur Prüfung der gespeicherten Konfiguration.", action: "check-connection", state: "open",
    openedAt: now.toISOString(), acknowledgedAt: null, resolvedAt: null, affectedContainers: [], affectedContainerCount: 0,
    pendingDeliveryCount: 0, evidence: { logs: { state: "unavailable", reason: "not-collected" } } },
  format: config.format || DEFAULT_NOTIFICATION_FORMAT, options: { ...channel.defaults, includeLogs: false },
  destinationScopeKey: null, bindingDigest: notificationBindingDigest({ channel, destination: null }) };
}
function runtime(channel: StoredChannel, destination: string | null): NotificationRuntimeConfig {
  if (!channelConfigured(channel)) throw new NotificationDeliveryError("channel-unconfigured");
  switch (channel.kind) {
    case "smtp": return { kind: "smtp", ...channel.connection! };
    case "discord": return { kind: "discord", endpoint: destination ?? channel.endpoint! };
    case "gotify": return { kind: "gotify", endpoint: channel.endpoint!, token: channel.token! };
    case "webhook": return { kind: "webhook", endpoint: destination ?? channel.endpoint!, authorization: channel.authorization };
  }
}
async function currentSelection(query: NotificationQuery, config: StoredConfig, row: NotificationDeliveryRow,
  dependencies: NotificationDeliveryDependencies): Promise<{ snapshot: NotificationDeliverySnapshot; config: NotificationRuntimeConfig } | NotificationDeliveryCancellation> {
  const channel = config.channels.find((item) => item.kind === row.channel)!;
  if (!channelConfigured(channel)) return "channel-unconfigured";
  if (row.phase === "test") return { snapshot: testSnapshot(config, channel, dependencies.now()), config: runtime(channel, null) };
  const ticket = row.private_snapshot.ticket;
  if (!(await dependencies.hostExists(ticket.target.hostId, query))) return "target-removed";
  if (ticket.target.kind !== "host" && !(await dependencies.targetReader(ticket.target, query)).exists) return "target-removed";
  const selections = await notificationRuntimeSelection(query, config, ticket, dependencies.targetReader);
  const selected = selections.find(({ selection }) => selection.channel === row.channel && (selection.events as string[]).includes(ticket.event));
  if (!selected) return "rule-changed";
  const flags = selected.selection.overrides as StoredSelection["overrides"];
  const options = { includeLogs: flags.includeLogs ?? channel.defaults.includeLogs,
    recovery: flags.recovery ?? channel.defaults.recovery,
    additionalText: [channel.defaults.additionalText, flags.additionalText ?? ""].filter(Boolean).join("\n") };
  if (row.phase === "recovery" && !options.recovery) return "rule-changed";
  return { config: runtime(channel, flags.destination ?? null), snapshot: { ...row.private_snapshot,
    format: config.format, options, destinationScopeKey: selected.scopeKey,
    bindingDigest: notificationBindingDigest({ channel, destination: flags.destination ?? null }) } };
}
function cancelled(row: NotificationDeliveryRow, reason: NotificationDeliveryCancellation, now: Date): NotificationDeliveryRow {
  return { ...row, state: "cancelled", updated_at: now.toISOString(), finished_at: now.toISOString(), next_attempt_at: null,
    claim_token: null, lease_deadline: null, cancellation_reason: reason,
    failure: reason === "rule-changed" || reason === "logs-revoked" ? "validation" : "configuration-missing" };
}
function completed(row: NotificationDeliveryRow, outcome: NotificationTransportOutcome, now: Date): NotificationDeliveryRow {
  const failure = outcome.status === "delivered" ? null : outcome.failure;
  const retry = (failure === "transient" || failure === "timeout") && row.attempts < NOTIFICATION_LIMITS.maxAttempts;
  return { ...row, state: retry ? "retrying" : failure === null ? "delivered" : "failed", failure,
    updated_at: now.toISOString(), finished_at: retry ? null : now.toISOString(),
    next_attempt_at: retry ? new Date(now.getTime() + NOTIFICATION_LIMITS.retryDelaysMs[row.attempts - 1]).toISOString() : null,
    claim_token: null, lease_deadline: null, cancellation_reason: null };
}
function filterKey(query: NotificationDeliveriesQuery): string {
  return createHash("sha256").update(JSON.stringify([query.ticketId ?? null, query.state ?? null, query.channel ?? null, query.limit ?? 50])).digest("hex").slice(0, 16);
}
function cursor(row: NotificationDeliveryView, filter: NotificationDeliveriesQuery, secret: string): string {
  const payload = Buffer.from(JSON.stringify([row.createdAt, row.id, filterKey(filter)])).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
function position(value: string, filter: NotificationDeliveriesQuery, secret: string): [string, string] {
  try {
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra || !/^[A-Za-z0-9_-]+$/u.test(payload) || !/^[A-Za-z0-9_-]+$/u.test(signature)) throw new Error();
    const actual = Buffer.from(signature, "base64url");
    const expected = createHmac("sha256", secret).update(payload).digest();
    if (actual.toString("base64url") !== signature || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[2] !== filterKey(filter)) throw new Error();
    return [notificationInstantSchema.parse(decoded[0]), notificationIdSchema.parse(decoded[1])];
  } catch { throw new NotificationDeliveryError("invalid-input"); }
}
export function createNotificationDeliveries(database: NotificationDatabase, dependencies: NotificationDeliveryDependencies) {
  if (dependencies.cursorSecret.length < 32) throw new Error("notification-cursor-secret-too-short");
  const write = <T>(operation: (query: NotificationQuery, config: StoredConfig, now: Date) => Promise<T>) =>
    database.transaction(async (query) => operation(query, await readConfig(query, true), dependencies.now()));
  const terminal = async (query: NotificationQuery, old: NotificationDeliveryRow, next: NotificationDeliveryRow, now: Date) => {
    const store = repository(query);
    const saved = await store.save(old, next);
    if (!activeStates.includes(next.state)) { await store.recordTerminal(saved); await store.prune(now); }
    return view(saved);
  };
  return {
    read: async (id: string) => { validId(id); return view(await repository(database).read(id)); },
    list: async (input: unknown) => {
      const parsed = notificationDeliveriesQuerySchema.safeParse(input);
      if (!parsed.success) throw new NotificationDeliveryError("invalid-input");
      const filter = parsed.data;
      const after = filter.cursor ? position(filter.cursor, filter, dependencies.cursorSecret) : null;
      const result = await database.query<NotificationDeliveryRow>(`SELECT * FROM notification_delivery
        WHERE ($1::text IS NULL OR ticket_id=$1) AND ($2::text IS NULL OR state=$2) AND ($3::text IS NULL OR channel=$3)
        AND ($4::timestamptz IS NULL OR (created_at,id) < ($4::timestamptz,$5::text))
        ORDER BY created_at DESC,id DESC LIMIT $6`, [filter.ticketId ?? null, filter.state ?? null, filter.channel ?? null,
        after?.[0] ?? null, after?.[1] ?? null, (filter.limit ?? 50) + 1]);
      const deliveries = result.rows.slice(0, filter.limit ?? 50).map(view);
      return notificationDeliveriesResponseSchema.parse({ deliveries, nextCursor: result.rows.length > deliveries.length
        ? cursor(deliveries.at(-1)!, filter, dependencies.cursorSecret) : null });
    },
    admitPending: async (limit = 100) => {
      batchSize(limit);
      return write(async (query, _config, now) => {
        const store = repository(query);
        await store.prune(now);
        let available = NOTIFICATION_LIMITS.maxQueuedDeliveries - await store.activeCount();
        const intentions = await pendingNotificationIntentions(query, limit);
        let admitted = 0;
        for (const intention of intentions) {
          const existing = await store.existing(intention.ticketId, intention.phase, intention.channel);
          if (existing) { await admitNotificationIntention(query, intention, now.toISOString()); admitted += 1; continue; }
          if (available <= 0) continue;
          const row = await store.insert(queued(intention.snapshot, intention.channel, intention.phase, intention.ticketId, now));
          if (!row) continue;
          await admitNotificationIntention(query, intention, now.toISOString());
          available -= 1; admitted += 1;
        }
        return { admitted, deferred: intentions.length - admitted };
      });
    },
    enqueueSavedChannelTest: async (input: unknown) => {
      const parsed = notificationChannelSchema.safeParse(input);
      if (!parsed.success) throw new NotificationDeliveryError("invalid-input");
      return write(async (query, config, now) => {
        const channel = config.channels.find((item) => item.kind === parsed.data)!;
        if (!channelConfigured(channel)) throw new NotificationDeliveryError("channel-unconfigured");
        const store = repository(query);
        await store.prune(now);
        if (await store.activeCount() >= NOTIFICATION_LIMITS.maxQueuedDeliveries) throw new NotificationDeliveryError("queue-full");
        return view((await store.insert(queued(testSnapshot(config, channel, now), parsed.data, "test", null, now)))!);
      });
    },
    claim: async (limit = 10): Promise<NotificationDeliveryClaim[]> => {
      batchSize(limit);
      return write(async (query, _config, now) => {
        const store = repository(query);
        const rows = await store.due(now.toISOString(), limit);
        const claims: NotificationDeliveryClaim[] = [];
        for (const row of rows) {
          const token = randomUUID();
          await store.save(row, { ...row, state: "sending", attempts: row.attempts + 1, updated_at: now.toISOString(),
            next_attempt_at: null, claim_token: token, lease_deadline: new Date(now.getTime() + NOTIFICATION_DELIVERY_LEASE_MS).toISOString() });
          claims.push({ id: row.id, generation: Number(row.generation), token });
        }
        return claims;
      });
    },
    prepareDispatch: async (claim: NotificationDeliveryClaim): Promise<NotificationPreparedDispatch | null> => {
      validClaim(claim);
      return write(async (query, config, now) => {
        const row = await repository(query).read(claim.id, true);
        if (!owned(row, claim, now)) return null;
        const current = await currentSelection(query, config, row, dependencies);
        const snapshot = row.private_snapshot;
        const reason = typeof current === "string" ? current : snapshot.options.includeLogs && !current.snapshot.options.includeLogs && row.phase !== "test"
          ? "logs-revoked" : snapshot.destinationScopeKey !== current.snapshot.destinationScopeKey ? "rule-changed" :
            snapshot.bindingDigest !== current.snapshot.bindingDigest ? "binding-changed" : null;
        if (reason) { await terminal(query, row, cancelled(row, reason, now), now); return null; }
        if (typeof current === "string") return null;
        try {
          const message = renderNotificationMessage(snapshot, { id: row.id, generation: Number(row.generation), channel: row.channel, phase: row.phase });
          // Recheck lease after asynchronous readers, then CAS before returning private dispatch data.
          const dispatchAt = dependencies.now();
          if (!owned(row, claim, dispatchAt) || Date.parse(iso(row.lease_deadline!)) - dispatchAt.getTime() <
            NOTIFICATION_LIMITS.deliveryTimeoutMs + 1000) return null;
          await repository(query).save(row, { ...row, updated_at: dispatchAt.toISOString() });
          return { claim, config: current.config, message };
        } catch (error) {
          if (!(error instanceof NotificationMessageError)) throw error;
          await terminal(query, row, completed(row, { status: "failed", failure: "validation" }, now), now);
          return null;
        }
      });
    },
    finish: async (claim: NotificationDeliveryClaim, outcome: NotificationTransportOutcome) => {
      validClaim(claim);
      const failures: NotificationDeliveryFailure[] = ["transient", "timeout", "authentication", "validation", "destination-rejected", "configuration-missing"];
      if (!outcome || !["delivered", "failed"].includes(outcome.status) ||
        (outcome.status === "failed" && !failures.includes(outcome.failure))) throw new NotificationDeliveryError("invalid-input");
      return write(async (query, _config, now) => {
        const row = await repository(query).read(claim.id, true);
        if (!owned(row, claim, now)) return null;
        return terminal(query, row, completed(row, outcome, now), now);
      });
    },
    recoverExpiredSending: async (limit = 100) => {
      batchSize(limit);
      return write(async (query, _config, now) => {
        const store = repository(query);
        const rows = await store.due(now.toISOString(), limit, true);
        for (const row of rows) await terminal(query, row, completed(row, { status: "failed", failure: "timeout" }, now), now);
        return rows.length;
      });
    },
    retry: async (id: string, input: unknown) => {
      validId(id);
      const parsed = notificationRetryRequestSchema.safeParse(input);
      if (!parsed.success || !Number.isSafeInteger(parsed.data.expectedGeneration)) throw new NotificationDeliveryError("invalid-input");
      return write(async (query, config, now) => {
        const store = repository(query);
        const row = await store.read(id, true);
        if (!["failed", "cancelled"].includes(row.state) || Number(row.generation) !== parsed.data.expectedGeneration ||
          Number(row.generation) >= Number.MAX_SAFE_INTEGER) throw new NotificationDeliveryError("conflict");
        const current = await currentSelection(query, config, row, dependencies);
        if (typeof current === "string") throw new NotificationDeliveryError(current === "channel-unconfigured" ? "channel-unconfigured" : "conflict");
        if (await store.activeCount() >= NOTIFICATION_LIMITS.maxQueuedDeliveries) throw new NotificationDeliveryError("queue-full");
        const next = { ...row, state: "queued" as const, generation: Number(row.generation) + 1, attempts: 0,
          updated_at: now.toISOString(), next_attempt_at: now.toISOString(), finished_at: null, failure: null,
          include_logs: row.phase !== "test" && current.snapshot.options.includeLogs, private_snapshot: current.snapshot,
          claim_token: null, lease_deadline: null, cancellation_reason: null };
        const result = await store.save(row, next);
        await store.prune(now);
        return view(result);
      });
    },
    pruneTerminal: () => write(async (query, _config, now) => repository(query).prune(now))
  };
}
