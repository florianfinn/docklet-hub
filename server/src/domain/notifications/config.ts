import { DEFAULT_NOTIFICATION_DELIVERY_OPTIONS, DEFAULT_NOTIFICATION_FORMAT, NOTIFICATION_CHANNELS,
  notificationSettingsViewSchema, notificationSettingsWriteSchema, type NotificationChannelWrite,
  type NotificationScopeWrite, type NotificationSettingsView } from "contract";
import { NotificationError, type NotificationDatabase, type NotificationQuery, type StoredChannel,
  type StoredConfig, type StoredScope, type StoredSelection } from "./types.js";

export function initialConfig(): StoredConfig {
  return { revision: 0, format: DEFAULT_NOTIFICATION_FORMAT, defaults: [], hostRules: [],
    channels: NOTIFICATION_CHANNELS.map((kind) => ({ kind, defaults: { ...DEFAULT_NOTIFICATION_DELIVERY_OPTIONS },
      endpoint: null, authorization: null, token: null, connection: null })) };
}
function update<T>(command: { operation: "keep" } | { operation: "clear" } | { operation: "set"; value: T }, previous: T | null): T | null {
  return command.operation === "keep" ? previous : command.operation === "clear" ? null : command.value;
}
export function replaceSelections(selections: Extract<NotificationScopeWrite, { mode: "explicit" }>["selections"], previous: StoredSelection[]): StoredSelection[] {
  return selections.map((selection) => {
    const { destination, ...flags } = selection.overrides;
    return { ...selection, overrides: { ...flags, destination: update(destination ?? { operation: "keep" },
      previous.find((item) => item.channel === selection.channel)?.overrides.destination ?? null) } };
  });
}
export function scopeView(scope: StoredScope) {
  return scope.mode === "inherit" ? scope : { mode: "explicit" as const, selections: selectionViews(scope.selections) };
}
export function selectionViews(selections: StoredSelection[]) {
  return selections.map(({ overrides: { destination, ...flags }, ...selection }) => ({ ...selection,
    overrides: { ...flags, destinationConfigured: destination !== null } }));
}
export function channelConfigured(channel: StoredChannel): boolean {
  return channel.kind === "smtp" ? channel.connection !== null : channel.endpoint !== null &&
    (channel.kind !== "gotify" || channel.token !== null);
}
export function settingsView(config: StoredConfig): NotificationSettingsView {
  return notificationSettingsViewSchema.parse({ ...config, defaults: selectionViews(config.defaults),
    channels: config.channels.map((channel) => ({ kind: channel.kind, defaults: channel.defaults,
      configured: channelConfigured(channel), destinationConfigured: channel.kind === "smtp" ? channel.connection !== null : channel.endpoint !== null,
      credentialConfigured: channel.kind === "smtp" ? channel.connection?.password != null :
        channel.kind === "gotify" ? channel.token !== null : channel.kind === "webhook" && channel.authorization !== null })) });
}
function replaceChannel(write: NotificationChannelWrite, previous: StoredChannel): StoredChannel {
  const result = { ...previous, defaults: write.defaults };
  if (write.kind === "smtp") result.connection = update(write.connection, previous.connection);
  else {
    result.endpoint = update(write.endpoint, previous.endpoint);
    if (write.kind === "webhook") result.authorization = update(write.authorization, previous.authorization);
    if (write.kind === "gotify") result.token = update(write.token, previous.token);
  }
  return result;
}
export async function readConfig(query: NotificationQuery, lock = false): Promise<StoredConfig> {
  await query.query("INSERT INTO notification_config (document) VALUES ($1::jsonb) ON CONFLICT DO NOTHING", [JSON.stringify(initialConfig())]);
  const result = await query.query<{ revision: string; document: StoredConfig }>(
    `SELECT revision, document FROM notification_config WHERE singleton = true${lock ? " FOR UPDATE" : ""}`);
  const row = result.rows[0];
  if (!row) throw new Error("notification-config-missing");
  return { ...row.document, revision: Number(row.revision) };
}
export function assertConfigured(config: StoredConfig, channels: string[]): void {
  if (channels.some((kind) => !config.channels.some((channel) => channel.kind === kind && channelConfigured(channel)))) {
    throw new NotificationError("configuration-incomplete");
  }
}
export async function saveConfig(query: NotificationQuery, config: StoredConfig, expected: number): Promise<void> {
  const result = await query.query("UPDATE notification_config SET revision = revision + 1, document = $1::jsonb WHERE singleton = true AND revision = $2 RETURNING revision",
    [JSON.stringify(config), expected]);
  if (result.rowCount !== 1) throw new NotificationError("conflict");
}
export function createNotificationConfig(database: NotificationDatabase) {
  return {
    read: async () => settingsView(await readConfig(database)),
    write: async (input: unknown) => {
      const parsed = notificationSettingsWriteSchema.safeParse(input);
      if (!parsed.success) throw new NotificationError("invalid-input");
      const write = parsed.data;
      return database.transaction(async (query) => {
        const old = await readConfig(query, true);
        if (old.revision !== write.expectedRevision) throw new NotificationError("conflict");
        const config: StoredConfig = { revision: old.revision + 1, format: write.format, hostRules: write.hostRules,
          defaults: replaceSelections(write.defaults, old.defaults),
          channels: write.channels.map((channel) => replaceChannel(channel, old.channels.find((item) => item.kind === channel.kind)!)) };
        assertConfigured(config, [...config.defaults, ...config.hostRules].map((rule) => rule.channel));
        const scopes = await query.query<{ configuration: StoredScope }>("SELECT configuration FROM notification_scope WHERE active = true");
        for (const row of scopes.rows) if (row.configuration.mode === "explicit") assertConfigured(config, row.configuration.selections.map((rule) => rule.channel));
        await saveConfig(query, config, old.revision);
        return settingsView(config);
      });
    }
  };
}
