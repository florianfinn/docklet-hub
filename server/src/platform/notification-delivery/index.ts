import { NOTIFICATION_LIMITS } from "contract";
import { sendDiscord } from "./discord.js";
import { sendGotify } from "./gotify.js";
import { sendSmtp } from "./smtp.js";
import { sendWebhook } from "./webhook.js";
import { failed, validMessage, type NotificationMessage, type NotificationRuntimeConfig,
  type NotificationTransportOutcome } from "./http.js";

export type { NotificationMessage, NotificationRuntimeConfig, NotificationTransportFailure, NotificationTransportOutcome } from "./http.js";

export async function sendNotification(config: NotificationRuntimeConfig, message: NotificationMessage,
  signal: AbortSignal): Promise<NotificationTransportOutcome> {
  if (signal.aborted) return failed("timeout");
  if (!validMessage(message)) return failed("validation");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, NOTIFICATION_LIMITS.deliveryTimeoutMs);
  try {
    switch (config.kind) {
      case "discord": return await sendDiscord(config, message, controller.signal);
      case "gotify": return await sendGotify(config, message, controller.signal);
      case "webhook": return await sendWebhook(config, message, controller.signal);
      case "smtp": return await sendSmtp(config, message, controller.signal);
      default: return failed("configuration-missing");
    }
  } catch { return failed(controller.signal.aborted ? "timeout" : "validation"); }
  finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}
