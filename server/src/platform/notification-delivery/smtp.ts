import { createConnection, isIP, type Socket } from "node:net";
import nodemailer from "nodemailer";
import { NOTIFICATION_LIMITS } from "contract";
import { delivered, failed, MAX_RESPONSE_BYTES, safeHeader, transportText, type NotificationMessage, type NotificationRuntimeConfig,
  type NotificationTransportFailure, type NotificationTransportOutcome } from "./http.js";

import { certificateRejected } from "./tls-failure.js";

type SmtpConfig = Extract<NotificationRuntimeConfig, { kind: "smtp" }>;
function mailbox(value: string): boolean {
  return value.length <= 320 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/u.test(value);
}
function validConfig(config: SmtpConfig): boolean {
  return safeHeader(config.host) && /^[A-Za-z0-9.:[\]-]+$/u.test(config.host) &&
    Number.isInteger(config.port) && config.port >= 1 && config.port <= 65535 &&
    ["tls", "starttls"].includes(config.security) && mailbox(config.from) &&
    Array.isArray(config.to) && config.to.length > 0 && config.to.length <= 20 && config.to.every(mailbox) &&
    ((config.username === null && config.password === null) ||
      (typeof config.username === "string" && typeof config.password === "string" &&
        safeHeader(config.username) && safeHeader(config.password)));
}
export function smtpFailure(error: unknown): NotificationTransportFailure {
  if (!error || typeof error !== "object") return "transient";
  const code = "code" in error ? error.code : null;
  const response = "responseCode" in error ? error.responseCode : null;
  if (certificateRejected(error)) return "destination-rejected";
  if (code === "ETIMEDOUT") return "timeout";
  if (typeof response === "number" && response >= 400 && response < 500) return "transient";
  if (code === "EAUTH" || response === 530 || response === 535) return "authentication";
  if (typeof response === "number" && response >= 500) return "destination-rejected";
  if (code === "EENVELOPE" || code === "EMESSAGE") return "validation";
  if (code === "ETLS" || code === "EPROTOCOL") return "destination-rejected";
  return "transient";
}

// The optional trust anchor is an internal certificate-test seam; verification remains mandatory.
export async function sendSmtp(config: SmtpConfig, message: NotificationMessage, signal: AbortSignal,
  certificateAuthority?: string): Promise<NotificationTransportOutcome> {
  if (!validConfig(config)) return failed("validation");
  if (signal.aborted) return failed("timeout");
  const text = transportText(message, NOTIFICATION_LIMITS.maxMessageChars - message.title.length - 2);
  if (text === null) return failed("validation");
  let socket: Socket | undefined;
  const timeout = NOTIFICATION_LIMITS.deliveryTimeoutMs;
  const transporter = nodemailer.createTransport({
    host: config.host, port: config.port, secure: config.security === "tls", requireTLS: config.security === "starttls",
    ignoreTLS: false, opportunisticTLS: false, name: "example.invalid",
    connectionTimeout: timeout, greetingTimeout: timeout, socketTimeout: timeout, dnsTimeout: timeout,
    maxResponseSize: MAX_RESPONSE_BYTES,
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2", ...(isIP(config.host) ? {} : { servername: config.host }),
      ...(certificateAuthority ? { ca: certificateAuthority } : {}) },
    auth: config.username === null ? undefined : { user: config.username, pass: config.password! },
    logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
    getSocket: (_options, callback) => {
      if (signal.aborted) { callback(new Error("aborted"), false); return; }
      socket = createConnection({ host: config.host, port: config.port });
      let returned = false;
      socket.once("error", (error) => {
        if (!returned) { returned = true; callback(error, false); }
      });
      socket.once("connect", () => {
        if (returned) return;
        returned = true;
        if (signal.aborted) { socket?.destroy(); callback(new Error("aborted"), false); }
        else callback(null, { connection: socket! });
      });
    }
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: NotificationTransportOutcome) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      socket?.destroy();
      transporter.close();
      resolve(outcome);
    };
    const abort = () => finish(failed("timeout"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    void transporter.sendMail({ from: { address: config.from, name: "" },
      to: config.to.map((address) => ({ address, name: "" })), subject: message.title, text,
      envelope: { from: config.from, to: config.to },
      headers: { "X-Idempotency-Key": message.idempotencyKey }, disableFileAccess: true, disableUrlAccess: true
    }).then((info) => finish(info.accepted.length === config.to.length && info.rejected.length === 0 ? delivered : failed("destination-rejected")),
      (error: unknown) => finish(failed(signal.aborted ? "timeout" : smtpFailure(error))));
  });
}
