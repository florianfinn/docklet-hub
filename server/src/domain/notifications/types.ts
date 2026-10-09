import type { QueryResultRow } from "pg";
import type { NotificationChannelWrite, NotificationScopeWrite, NotificationSettingsWrite, NotificationTarget,
  NotificationTicketView } from "contract";

export type NotificationQuery = {
  query<R extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
};
export type NotificationDatabase = NotificationQuery & {
  transaction<T>(operation: (query: NotificationQuery) => Promise<T>): Promise<T>;
};
export type ScopeTarget = Exclude<NotificationTarget, { kind: "host" }>;
export type StoredSelection = Omit<Extract<NotificationScopeWrite, { mode: "explicit" }>["selections"][number], "overrides"> & {
  overrides: { includeLogs?: boolean; recovery?: boolean; additionalText?: string; destination: string | null };
};
export type StoredScope = { mode: "inherit" } | { mode: "explicit"; selections: StoredSelection[] };
export type StoredChannel = { kind: NotificationChannelWrite["kind"]; defaults: NotificationChannelWrite["defaults"];
  endpoint: string | null; authorization: string | null; token: string | null;
  connection: Extract<NotificationChannelWrite, { kind: "smtp" }>["connection"] extends infer C
    ? C extends { operation: "set"; value: infer V } ? V | null : never : never };
export type StoredConfig = { revision: number; channels: StoredChannel[]; format: string;
  defaults: StoredSelection[]; hostRules: NotificationSettingsWrite["hostRules"] };
export type TargetReader = (target: ScopeTarget, query: NotificationQuery) => Promise<{ exists: boolean; stack: ScopeTarget | null }>;
export type TicketObservation = Omit<NotificationTicketView, "id" | "state" | "openedAt" | "acknowledgedAt" |
  "resolvedAt" | "pendingDeliveryCount" | "evidence"> & {
  source: string; observedAt: string;
  evidence?: NotificationTicketView["evidence"];
  evidenceSanitized?: boolean;
};
export class NotificationError extends Error {
  constructor(public readonly code: "invalid-input" | "conflict" | "target-unknown" | "ticket-unknown" | "configuration-incomplete") {
    super(code);
  }
}
export function targetKey(target: NotificationTarget): string {
  if (target.kind === "host") return JSON.stringify(["host", target.hostId]);
  if (target.kind === "stack") return JSON.stringify(["stack", target.hostId, target.projectName]);
  return target.target.kind === "compose"
    ? JSON.stringify(["compose", target.hostId, target.target.projectName, target.target.serviceName])
    : JSON.stringify(["container", target.hostId, target.target.containerName]);
}
