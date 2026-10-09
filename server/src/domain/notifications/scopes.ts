import { notificationBulkRequestSchema, notificationScopeResponseSchema, notificationScopeTargetSchema,
  resolveNotificationSelection } from "contract";
import { assertConfigured, readConfig, replaceSelections, saveConfig, scopeView, selectionViews } from "./config.js";
import { NotificationError, targetKey, type NotificationDatabase, type NotificationQuery, type ScopeTarget,
  type StoredConfig, type StoredScope, type TargetReader } from "./types.js";

export async function readStoredScope(query: NotificationQuery, target: ScopeTarget): Promise<StoredScope> {
  const result = await query.query<{ configuration: StoredScope; active: boolean }>(
    "SELECT configuration, active FROM notification_scope WHERE target_key = $1", [targetKey(target)]);
  const row = result.rows[0];
  return !row ? { mode: "inherit" } : row.active ? row.configuration : { mode: "explicit", selections: [] };
}
async function response(query: NotificationQuery, reader: TargetReader, target: ScopeTarget, config: StoredConfig) {
  const inventory = await reader(target, query);
  if (!inventory.exists) throw new NotificationError("target-unknown");
  const configuration = await readStoredScope(query, target);
  const stack = target.kind === "stack" ? configuration : inventory.stack ? await readStoredScope(query, inventory.stack) : { mode: "inherit" as const };
  const resolved = resolveNotificationSelection(selectionViews(config.defaults), scopeView(stack),
    target.kind === "container" ? scopeView(configuration) : undefined);
  return notificationScopeResponseSchema.parse({ target, revision: config.revision, configuration: scopeView(configuration), ...resolved });
}
export function createNotificationScopes(database: NotificationDatabase, reader: TargetReader) {
  return {
    read: async (input: unknown) => {
      const parsed = notificationScopeTargetSchema.safeParse(input);
      if (!parsed.success) throw new NotificationError("invalid-input");
      return database.transaction(async (query) => response(query, reader, parsed.data, await readConfig(query, true)));
    },
    bulk: async (input: unknown) => {
      const parsed = notificationBulkRequestSchema.safeParse(input);
      if (!parsed.success) throw new NotificationError("invalid-input");
      const write = parsed.data;
      if (new Set(write.targets.map(targetKey)).size !== write.targets.length) throw new NotificationError("invalid-input");
      return database.transaction(async (query) => {
        const config = await readConfig(query, true);
        if (config.revision !== write.expectedRevision) throw new NotificationError("conflict");
        for (const target of write.targets) if (!(await reader(target, query)).exists) throw new NotificationError("target-unknown");
        if (write.configuration.mode === "explicit") assertConfigured(config, write.configuration.selections.map((rule) => rule.channel));
        for (const target of write.targets) {
          const previous = await readStoredScope(query, target);
          const configuration: StoredScope = write.configuration.mode === "inherit" ? { mode: "inherit" } : {
            mode: "explicit", selections: replaceSelections(write.configuration.selections, previous.mode === "explicit" ? previous.selections : []) };
          await query.query(`INSERT INTO notification_scope (target_key, host_id, target, configuration, active)
            VALUES ($1, $2, $3::jsonb, $4::jsonb, true) ON CONFLICT (target_key)
            DO UPDATE SET configuration = EXCLUDED.configuration, active = true`,
          [targetKey(target), target.hostId, JSON.stringify(target), JSON.stringify(configuration)]);
        }
        await saveConfig(query, { ...config, revision: config.revision + 1 }, config.revision);
        config.revision += 1;
        return { revision: config.revision, targets: await Promise.all(write.targets.map((target) => response(query, reader, target, config))) };
      });
    },
    // Call only after inventory proves removal, never on an offline snapshot.
    markRemoved: (target: ScopeTarget) => database.transaction(async (query) => {
      const config = await readConfig(query, true);
      await query.query(`INSERT INTO notification_scope (target_key, host_id, target, configuration, active)
        VALUES ($1, $2, $3::jsonb, $4::jsonb, false) ON CONFLICT (target_key) DO UPDATE SET active = false`,
      [targetKey(target), target.hostId, JSON.stringify(target), JSON.stringify({ mode: "explicit", selections: [] })]);
      await saveConfig(query, { ...config, revision: config.revision + 1 }, config.revision);
    })
  };
}
