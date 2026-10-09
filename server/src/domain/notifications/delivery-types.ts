import type { NotificationChannel, NotificationDeliveryOptions, NotificationDeliveryView, NotificationTicketView } from "contract";
import type { NotificationRuntimeConfig, NotificationMessage } from "../../platform/notification-delivery/index.js";
import type { NotificationQuery, TargetReader } from "./types.js";

export class NotificationDeliveryError extends Error {
  constructor(public readonly code: "invalid-input" | "delivery-unknown" | "conflict" | "channel-unconfigured" | "queue-full") {
    super(code);
  }
}
export type NotificationDeliverySnapshot = {
  ticket: NotificationTicketView; format: string; options: NotificationDeliveryOptions;
  destinationScopeKey: string | null; bindingDigest: string;
};
export type NotificationDeliveryClaim = { id: string; generation: number; token: string };
export type NotificationDeliveryDependencies = {
  now: () => Date; cursorSecret: string; targetReader: TargetReader;
  hostExists: (hostId: string, query: NotificationQuery) => Promise<boolean>;
};
export type NotificationPreparedDispatch = {
  claim: NotificationDeliveryClaim; config: NotificationRuntimeConfig; message: NotificationMessage;
};
export type NotificationDeliveryFailure = NonNullable<NotificationDeliveryView["failure"]>;
export type NotificationDeliveryCancellation = "target-removed" | "rule-changed" | "binding-changed" | "logs-revoked" | "channel-unconfigured";
export type NotificationDeliveryRow = {
  id: string; ticket_id: string | null; phase: NotificationDeliveryView["phase"]; channel: NotificationChannel;
  generation: number; state: NotificationDeliveryView["state"]; attempts: number;
  created_at: Date | string; updated_at: Date | string; next_attempt_at: Date | string | null;
  finished_at: Date | string | null; failure: NotificationDeliveryFailure | null; include_logs: boolean;
  private_snapshot: NotificationDeliverySnapshot; claim_token: string | null; lease_deadline: Date | string | null;
  cancellation_reason: NotificationDeliveryCancellation | null;
};
