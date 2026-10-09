import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { NOTIFICATION_LIMITS, notificationIdSchema, notificationInstantSchema, notificationTargetSchema,
  notificationTicketViewSchema, notificationTicketsQuerySchema, notificationTicketsResponseSchema,
  notificationCountsResponseSchema, type NotificationChannel, type NotificationDeliveryOptions,
  type NotificationTicketEvidence, type NotificationTicketView, type NotificationTicketsQuery } from "contract";
import { readConfig } from "./config.js";
import { readStoredScope } from "./scopes.js";
import { NotificationError, targetKey, type NotificationDatabase, type NotificationQuery, type StoredConfig,
  type StoredSelection, type TargetReader, type TicketObservation } from "./types.js";

type TicketRow = { document: NotificationTicketView; observed_at: Date | string };
export type NotificationDeliveryIntention = {
  ticketId: string; phase: "initial" | "recovery"; channel: NotificationChannel; configurationRevision: number;
  snapshot: { ticket: NotificationTicketView; format: string; options: NotificationDeliveryOptions;
    destinationScopeKey: string | null; bindingDigest: string };
};
export type NotificationTicketDependencies = {
  now: () => Date;
  cursorSecret: string;
  targetReader: TargetReader;
  sanitizeText: (text: string) => string | null;
  sanitizeEvidence?: (evidence: NotificationTicketEvidence) => NotificationTicketEvidence | null;
};
function iso(value: Date | string): string { return new Date(value).toISOString(); }
function cleanObservation(input: TicketObservation, dependencies: NotificationTicketDependencies): TicketObservation {
  const source = notificationIdSchema.safeParse(input.source);
  const instant = notificationInstantSchema.safeParse(input.observedAt);
  if (!source.success || !instant.success || Date.parse(input.observedAt) > dependencies.now().getTime()) throw new NotificationError("invalid-input");
  const cause = dependencies.sanitizeText(input.cause);
  const targetLabel = dependencies.sanitizeText(input.targetLabel);
  if (!cause || !targetLabel) throw new NotificationError("invalid-input");
  const affectedContainers = input.affectedContainers.map((item) => {
    const label = dependencies.sanitizeText(item.label);
    if (!label) throw new NotificationError("invalid-input");
    return { ...item, label };
  });
  const evidence = input.evidence ? dependencies.sanitizeEvidence?.(input.evidence) ??
    { logs: { state: "unavailable" as const, reason: "redaction-unavailable" as const } } :
    { logs: { state: "unavailable" as const, reason: "not-collected" as const } };
  const { source: _source, observedAt: _observedAt, evidenceSanitized: _proof, ...rest } = input;
  void _source; void _observedAt; void _proof;
  const parsed = notificationTicketViewSchema.safeParse({ ...rest, id: randomUUID(), state: "open", openedAt: input.observedAt,
    acknowledgedAt: null, resolvedAt: null, pendingDeliveryCount: 0, cause, targetLabel, evidence, affectedContainers });
  if (!parsed.success) throw new NotificationError("invalid-input");
  return { ...input, ...parsed.data };
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export async function notificationRuntimeSelection(query: NotificationQuery, config: StoredConfig,
  ticket: NotificationTicketView, reader: TargetReader): Promise<{ selection: StoredSelection | StoredConfig["hostRules"][number]; scopeKey: string | null }[]> {
  if (ticket.target.kind === "host") return config.hostRules.map((selection) => ({ selection, scopeKey: null }));
  const target = ticket.target;
  const inventory = await reader(target, query);
  if (!inventory.exists) return [];
  const own = await readStoredScope(query, target);
  if (own.mode === "explicit") return own.selections.map((selection) => ({ selection, scopeKey: targetKey(target) }));
  if (inventory.stack && target.kind === "container") {
    const stack = await readStoredScope(query, inventory.stack);
    if (stack.mode === "explicit") return stack.selections.map((selection) => ({ selection, scopeKey: targetKey(inventory.stack!) }));
  }
  return config.defaults.map((selection) => ({ selection, scopeKey: null }));
}
export async function prepareNotificationIntentions(query: NotificationQuery, config: StoredConfig,
  ticket: NotificationTicketView, phase: "initial" | "recovery", reader: TargetReader): Promise<void> {
  const selections = await notificationRuntimeSelection(query, config, ticket, reader);
  for (const { selection, scopeKey } of selections) {
    if (!(selection.events as string[]).includes(ticket.event)) continue;
    const channel = config.channels.find((item) => item.kind === selection.channel)!;
    const { destination: localDestination, ...flags } = selection.overrides as StoredSelection["overrides"];
    const options: NotificationDeliveryOptions = {
      includeLogs: flags.includeLogs ?? channel.defaults.includeLogs,
      recovery: flags.recovery ?? channel.defaults.recovery,
      additionalText: [channel.defaults.additionalText, flags.additionalText ?? ""].filter(Boolean).join("\n")
    };
    if (phase === "recovery" && !options.recovery) continue;
    const snapshot = { ticket: { ...ticket, evidence: options.includeLogs ? ticket.evidence :
      { logs: { state: "unavailable", reason: "not-collected" } } }, format: config.format, options,
      destinationScopeKey: scopeKey,
      bindingDigest: digest({ channel, destination: localDestination ?? null }) };
    await query.query(`INSERT INTO notification_delivery_intention
      (ticket_id, phase, channel, configuration_revision, snapshot) VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (ticket_id, phase, channel) DO NOTHING`, [ticket.id, phase, selection.channel, config.revision, JSON.stringify(snapshot)]);
  }
}
async function ticketView(query: NotificationQuery, row: TicketRow): Promise<NotificationTicketView> {
  const pending = await query.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM notification_delivery_intention WHERE ticket_id = $1 AND admitted_at IS NULL", [row.document.id]);
  return notificationTicketViewSchema.parse({ ...row.document, pendingDeliveryCount: Number(pending.rows[0]?.count ?? 0) });
}
async function findRow(query: NotificationQuery, id: string, lock = false): Promise<TicketRow> {
  const parsed = notificationIdSchema.safeParse(id);
  if (!parsed.success) throw new NotificationError("invalid-input");
  const result = await query.query<TicketRow>(`SELECT document, observed_at FROM notification_ticket WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
  if (!result.rows[0]) throw new NotificationError("ticket-unknown");
  return result.rows[0];
}
function filterKey(query: NotificationTicketsQuery): string {
  return digest([query.state ?? null, query.event ?? null, query.hostId ?? null, query.targetKind ?? null, query.limit ?? 50]).slice(0, 16);
}
function encodeCursor(ticket: NotificationTicketView, query: NotificationTicketsQuery, secret: string): string {
  const payload = Buffer.from(JSON.stringify([ticket.openedAt, ticket.id, filterKey(query)])).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
function decodeCursor(cursor: string, query: NotificationTicketsQuery, secret: string): [string, string] {
  try {
    const [payload, signature, extra] = cursor.split(".");
    if (!payload || !signature || extra) throw new Error();
    const actual = Buffer.from(signature, "base64url");
    const expected = createHmac("sha256", secret).update(payload).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const position: unknown = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!Array.isArray(position) || position.length !== 3 || typeof position[0] !== "string" ||
      typeof position[1] !== "string" || position[2] !== filterKey(query)) throw new Error();
    notificationInstantSchema.parse(position[0]);
    notificationIdSchema.parse(position[1]);
    return [position[0], position[1]];
  } catch { throw new NotificationError("invalid-input"); }
}
export function createNotificationTickets(database: NotificationDatabase, dependencies: NotificationTicketDependencies) {
  if (dependencies.cursorSecret.length < 32) throw new Error("notification-cursor-secret-too-short");
  return {
    observe: async (input: TicketObservation) => {
      const observation = cleanObservation(input, dependencies);
      return database.transaction(async (query) => {
        const config = await readConfig(query, true);
        const target = notificationTargetSchema.parse(observation.target);
        const existing = await query.query<TicketRow>(`SELECT document, observed_at FROM notification_ticket
          WHERE source = $1 AND target_key = $2 AND episode_key = $3 FOR UPDATE`, [input.source, targetKey(target), input.episodeKey]);
        const row = existing.rows[0];
        if (row && (row.document.state === "resolved" || Date.parse(observation.observedAt) <= Date.parse(iso(row.observed_at)))) return ticketView(query, row);
        const ticket = notificationTicketViewSchema.parse({ id: row?.document.id ?? randomUUID(), episodeKey: observation.episodeKey,
          event: observation.event, target, targetLabel: observation.targetLabel, cause: observation.cause,
          evidence: observation.evidence, action: observation.action, state: row?.document.state ?? "open",
          openedAt: row?.document.openedAt ?? observation.observedAt, acknowledgedAt: row?.document.acknowledgedAt ?? null,
          resolvedAt: null, affectedContainers: observation.affectedContainers,
          affectedContainerCount: observation.affectedContainerCount, pendingDeliveryCount: 0 });
        if (row && row.document.event !== ticket.event) throw new NotificationError("invalid-input");
        await query.query(`INSERT INTO notification_ticket
          (id, source, target_key, episode_key, event, host_id, target_kind, state, opened_at, acknowledged_at, observed_at, document)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) ON CONFLICT (source, target_key, episode_key)
          DO UPDATE SET document = EXCLUDED.document, observed_at = EXCLUDED.observed_at`,
        [ticket.id, input.source, targetKey(target), ticket.episodeKey, ticket.event, target.hostId, target.kind,
          ticket.state, ticket.openedAt, ticket.acknowledgedAt, observation.observedAt, JSON.stringify(ticket)]);
        if (!row) await prepareNotificationIntentions(query, config, ticket, "initial", dependencies.targetReader);
        return ticketView(query, { document: ticket, observed_at: observation.observedAt });
      });
    },
    read: (id: string) => database.transaction(async (query) => ticketView(query, await findRow(query, id))),
    acknowledge: (id: string) => database.transaction(async (query) => {
      const row = await findRow(query, id, true);
      if (row.document.state !== "open") return ticketView(query, row);
      const ticket = notificationTicketViewSchema.parse({ ...row.document, state: "acknowledged", acknowledgedAt: dependencies.now().toISOString() });
      await query.query("UPDATE notification_ticket SET state = 'acknowledged', acknowledged_at = $2, document = $3::jsonb WHERE id = $1",
        [id, ticket.acknowledgedAt, JSON.stringify(ticket)]);
      return ticketView(query, { ...row, document: ticket });
    }),
    recover: (id: string, freshEvidence: (ticket: NotificationTicketView, query: NotificationQuery) => Promise<{ recovered: boolean; observedAt: string } | null>) => database.transaction(async (query) => {
      const config = await readConfig(query, true);
      const row = await findRow(query, id, true);
      if (row.document.state === "resolved") return ticketView(query, row);
      const evidence = await freshEvidence(row.document, query);
      if (!evidence?.recovered || !notificationInstantSchema.safeParse(evidence.observedAt).success ||
        Date.parse(evidence.observedAt) <= Date.parse(iso(row.observed_at)) ||
        Date.parse(evidence.observedAt) < Date.parse(row.document.acknowledgedAt ?? row.document.openedAt) ||
        Date.parse(evidence.observedAt) > dependencies.now().getTime()) return ticketView(query, row);
      const ticket = notificationTicketViewSchema.parse({ ...row.document, state: "resolved", resolvedAt: evidence.observedAt });
      await query.query("UPDATE notification_ticket SET state = 'resolved', resolved_at = $2, observed_at = $2, document = $3::jsonb WHERE id = $1",
        [id, evidence.observedAt, JSON.stringify(ticket)]);
      await prepareNotificationIntentions(query, config, ticket, "recovery", dependencies.targetReader);
      return ticketView(query, { document: ticket, observed_at: evidence.observedAt });
    }),
    list: async (input: unknown) => {
      const parsed = notificationTicketsQuerySchema.safeParse(input);
      if (!parsed.success) throw new NotificationError("invalid-input");
      const filter = parsed.data;
      const position = filter.cursor ? decodeCursor(filter.cursor, filter, dependencies.cursorSecret) : null;
      return database.transaction(async (query) => {
        const result = await query.query<TicketRow>(`SELECT document, observed_at FROM notification_ticket
          WHERE ($1::text IS NULL OR state = $1) AND ($2::text IS NULL OR event = $2)
          AND ($3::text IS NULL OR host_id = $3) AND ($4::text IS NULL OR target_kind = $4)
          AND ($5::timestamptz IS NULL OR (opened_at, id) < ($5::timestamptz, $6::text))
          ORDER BY opened_at DESC, id DESC LIMIT $7`, [filter.state ?? null, filter.event ?? null,
          filter.hostId ?? null, filter.targetKind ?? null, position?.[0] ?? null, position?.[1] ?? null, (filter.limit ?? 50) + 1]);
        const rows = result.rows.slice(0, filter.limit ?? 50);
        const tickets = await Promise.all(rows.map((row) => ticketView(query, row)));
        return notificationTicketsResponseSchema.parse({ tickets, nextCursor: result.rows.length > rows.length
          ? encodeCursor(tickets.at(-1)!, filter, dependencies.cursorSecret) : null });
      });
    },
    counts: async () => {
      const result = await database.query<{ open: string; acknowledged: string }>(`SELECT
        count(*) FILTER (WHERE state = 'open')::text AS open,
        count(*) FILTER (WHERE state = 'acknowledged')::text AS acknowledged FROM notification_ticket`);
      const open = Number(result.rows[0]?.open ?? 0);
      const acknowledged = Number(result.rows[0]?.acknowledged ?? 0);
      return notificationCountsResponseSchema.parse({ open, acknowledged, active: open + acknowledged });
    },
    pruneResolved: () => database.transaction(async (query) => {
      const result = await query.query(`DELETE FROM notification_ticket WHERE state = 'resolved' AND resolved_at < $1
        AND NOT EXISTS (SELECT 1 FROM notification_delivery_intention i WHERE i.ticket_id = notification_ticket.id AND i.admitted_at IS NULL)`,
      [new Date(dependencies.now().getTime() - NOTIFICATION_LIMITS.resolvedRetentionMs).toISOString()]);
      return result.rowCount ?? 0;
    })
  };
}
// B2 must lock these rows and atomically insert its queue entry before marking admission.
export async function pendingNotificationIntentions(query: NotificationQuery, limit = 100): Promise<NotificationDeliveryIntention[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new NotificationError("invalid-input");
  const result = await query.query<{ ticket_id: string; phase: "initial" | "recovery"; channel: NotificationChannel;
    configuration_revision: string; snapshot: NotificationDeliveryIntention["snapshot"] }>(`SELECT * FROM notification_delivery_intention
    WHERE admitted_at IS NULL ORDER BY ticket_id, phase, channel LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
  return result.rows.map((row) => ({ ticketId: row.ticket_id, phase: row.phase, channel: row.channel,
    configurationRevision: Number(row.configuration_revision), snapshot: row.snapshot }));
}
export async function admitNotificationIntention(query: NotificationQuery, intention: Pick<NotificationDeliveryIntention, "ticketId" | "phase" | "channel">, at: string): Promise<void> {
  notificationInstantSchema.parse(at);
  await query.query("UPDATE notification_delivery_intention SET admitted_at = $4 WHERE ticket_id = $1 AND phase = $2 AND channel = $3 AND admitted_at IS NULL",
    [intention.ticketId, intention.phase, intention.channel, at]);
}
