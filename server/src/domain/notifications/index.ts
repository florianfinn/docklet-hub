export { NotificationError, targetKey } from "./types.js";
export type { NotificationQuery, NotificationDatabase, ScopeTarget, StoredSelection, StoredScope,
  StoredChannel, StoredConfig, TargetReader, TicketObservation } from "./types.js";
export { createNotificationDatabase } from "./repository.js";
export { initialConfig, replaceSelections, scopeView, selectionViews, channelConfigured, settingsView,
  readConfig, assertConfigured, saveConfig, createNotificationConfig } from "./config.js";
export { readStoredScope, createNotificationScopes } from "./scopes.js";
export { notificationBindingDigest, notificationRuntimeSelection, prepareNotificationIntentions,
  createNotificationTickets, pendingNotificationIntentions, admitNotificationIntention } from "./tickets.js";
export type { NotificationDeliveryIntention, NotificationTicketDependencies } from "./tickets.js";
