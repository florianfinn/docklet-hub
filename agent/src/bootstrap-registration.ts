import fs from "node:fs";
import path from "node:path";
import { AGENT_VERSION } from "./version.js";

export type BootstrapRegistrationConfig = {
  registrationUrl: string | null;
  registrationToken: string | null;
  stateFile: string;
  listenHost: string;
  listenPort: number;
  readOnly: boolean;
  // The version that registers here. Optional only for tests; in operation
  // it comes from version.ts and thus from the image's package.json.
  agentVersion?: string;
};

type FetchLike = typeof fetch;

const FIRST_ATTEMPT_MS = 1_000;

// Upper bound for the backoff.
//
// ⚠️ The number is NOT freely chosen, it comes from the other side. The
// registration endpoint of the main API allows TWELVE attempts per source IP
// in a window of 15 minutes and answers with 429 afterwards. With the old cap
// of 30 s the agent made 34 attempts in the same time: slot twelve was used
// up after three and a half minutes, everything after that ran against the
// rate limit, and the deadline expired before the other side's window reset.
// The cap from R9 thus hit exactly the case the retry is built for — from the
// main API's point of view the tunnel is not up yet (503).
//
// With 180 s exactly twelve attempts fill the deadline (last one at 796 s),
// and none of them goes beyond the budget. Whoever changes the deadline
// recalculates this number — the test for it keeps both together.
const MAX_WAIT_MS = 180_000;

// R9: How long registration is attempted in total.
//
// Before, the backoff capped at 30 s but kept trying INDEFINITELY. With a
// misconfigured URL that means: every 30 seconds, forever, a one-time token is
// sent to an address that is not supposed to have it — and the log contains
// the same line so often that nobody reads it any more.
//
// 15 minutes are long enough for the case the retry is built for: the tunnel
// is not up yet, or the main API is itself restarting. They are short enough
// that a typo in the URL stays an incident of minutes and not one of weeks.
// When the deadline expires, only the REGISTRATION ends — the agent keeps
// serving its API, and because no marker was written, registration starts
// again after a restart.
export const REGISTRATION_DEADLINE_MS = 15 * 60_000;

// A time NAMED by the endpoint (429 with `Retry-After` or
// `retryAfterSeconds`) is not a failure but an appointment: the other side
// says when it will accept again. Honouring it while also counting it against
// the own deadline would be pointless — the appointment as a rule lies BEYOND
// the deadline, because it lasts as long as the rate-limit window.
// Granted appointments therefore do not count as own waiting time.
export const DATE_MAX_MS = 15 * 60_000;

// On top of that there is a hard upper bound on the wall clock. Without it a
// broken — or hostile — endpoint could string the agent along indefinitely
// with ever new appointments, and the deadline would again be what R9
// abolished: a number that does not take effect.
export const REGISTRATION_HARD_LIMIT_MS = 60 * 60_000;

// Response statuses after which a retry is pointless.
//
// A 4xx is the other side's statement that it does not WANT to accept this
// request: wrong path (404 — the most common case of a misconfigured URL),
// unknown or already used token (401/403/409). None of these states changes
// by sending the same token thirty more times; every retry is then just one
// more disclosure of the secret. 5xx and network errors explicitly stay
// retryable: that is exactly the situation the backoff exists for.
//
// Excepted are the three 4xx that mean "try again later".
const RETRYABLE_4XX = new Set([408, 425, 429]);

export class RegistrationError extends Error {
  constructor(
    readonly status: number,
    // Only set on 429: the waiting time the endpoint named itself.
    readonly dueMs?: number
  ) {
    super(`registration endpoint responded ${status}`);
    this.name = "RegistrationError";
  }
}

// Reads the named time from a 429 response.
//
// Two sources, because two spellings are in circulation: the standard header
// `Retry-After` (seconds OR HTTP date) and the JSON field
// `retryAfterSeconds`, which the main app sends along. None of it is logged —
// it is a number for the schedule, not text for the log.
//
// A nonsensical value (not a number, negative, absurdly large) deliberately
// falls back to `undefined`: then the normal backoff applies. An appointment
// one does not understand must not invent a waiting time.
export async function dateFromResponse(response: {
  headers: { get: (name: string) => string | null };
  json: () => Promise<unknown>;
}): Promise<number | undefined> {
  const raw = response.headers.get("retry-after");
  if (raw !== null) {
    const seconds = Number(raw.trim());
    if (Number.isFinite(seconds)) return validateDate(seconds * 1000);
    const timestamp = Date.parse(raw);
    if (Number.isFinite(timestamp)) return validateDate(timestamp - Date.now());
  }
  try {
    const body = (await response.json()) as { retryAfterSeconds?: unknown };
    if (typeof body?.retryAfterSeconds === "number") return validateDate(body.retryAfterSeconds * 1000);
  } catch {
    // No JSON or already read: then simply no appointment.
  }
  return undefined;
}

function validateDate(ms: number): number | undefined {
  if (!Number.isFinite(ms) || ms <= 0 || ms > DATE_MAX_MS) return undefined;
  return Math.round(ms);
}

export type RegistrationStep =
  | { proceed: true; waitMs: number; due: boolean }
  | { proceed: false; reason: "rejected" | "deadline" | "limit" };

// The decision after a failed attempt — pure and without a clock, so that
// the abort behaviour can be tested without waiting a quarter of an hour.
export function nextRegistrationStep(situation: {
  // How many attempts have already failed (>= 1).
  attempts: number;
  // OWN waiting time since the start: the wall clock minus the appointments
  // the other side demanded itself. It runs against the deadline.
  elapsedMs: number;
  // The wall clock since the start. It runs against the hard limit. If it is
  // missing, there were no appointments and both times are the same.
  totalMs?: number;
  // The HTTP status, if the endpoint answered at all.
  status?: number;
  // The appointment it named, if it named one (429).
  dueMs?: number;
  deadlineMs?: number;
  hardLimitMs?: number;
}): RegistrationStep {
  const { attempts, elapsedMs, status, dueMs } = situation;
  const deadlineMs = situation.deadlineMs ?? REGISTRATION_DEADLINE_MS;
  const hardLimitMs = situation.hardLimitMs ?? REGISTRATION_HARD_LIMIT_MS;
  const totalMs = situation.totalMs ?? elapsedMs;
  if (status !== undefined && status >= 400 && status < 500 && !RETRYABLE_4XX.has(status)) {
    return { proceed: false, reason: "rejected" };
  }
  // A named appointment beats the own backoff — even if it is shorter. The
  // other side knows better than any formula here when it will accept again;
  // coming earlier than agreed only produces the next 429.
  const hasDue = status === 429 && dueMs !== undefined && dueMs > 0;
  const waitMs = hasDue
    ? Math.min(dueMs, DATE_MAX_MS)
    : Math.min(FIRST_ATTEMPT_MS * 2 ** (attempts - 1), MAX_WAIT_MS);
  // What is checked each time is the TIME of the next attempt, not the
  // current one: scheduling a retry that is already known to lie beyond the
  // limit would be an attempt nobody ordered.
  if (totalMs + waitMs > hardLimitMs) return { proceed: false, reason: "limit" };
  // Only the own waiting time runs against the deadline. Otherwise an honoured
  // appointment would be pointless: it lasts as long as the other side's
  // rate-limit window and thus almost always lies beyond the deadline.
  if (!hasDue && elapsedMs + waitMs > deadlineMs) return { proceed: false, reason: "deadline" };
  return { proceed: true, waitMs, due: hasDue };
}

// Clock and timer as one seam: otherwise the expiry of the deadline can only
// be tested in real time, and a test that waits a quarter of an hour does not
// get run.
export type Clock = {
  now: () => number;
  schedule: (callback: () => void, ms: number) => { cancel: () => void };
};

const realTime: Clock = {
  now: () => Date.now(),
  schedule: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    // A pending registration must not hold up a clean shutdown.
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  }
};

export type BootstrapPhase = "off" | "running" | "registered" | "given-up";

// How the registration ended. `limit` means: the other side strung us
// along with appointments beyond the hard upper bound.
export type RegistrationEnd = "registered" | "rejected" | "deadline" | "limit";

export type BootstrapState = {
  phase: BootstrapPhase;
  // ⚠️ `attempts` is not just an identifier but a RESPONSE KEY: this object
  // goes unchanged as `bootstrap` into the response of `/health` (index.ts). A
  // wire key only moves on BOTH SIDES — renamed on one side only, the other
  // side reads `undefined` and takes it for "not specified", without `tsc`, a
  // test or the build noticing anything. (It was the German `versuche` before
  // v0.18.0.)
  //
  // The local counters next to it are also called `attempts`; where both
  // meet, it therefore says `attempts: attempts` and not the shorthand.
  attempts: number;
};

export type BootstrapLogin = {
  stop: () => void;
  // The current state — for /health. Deliberately only phase and counter: the
  // endpoint sits before the secret check, where neither the address of the
  // main API nor a response text has any business.
  state: () => BootstrapState;
};

function markerExists(file: string, registrationUrl: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { registrationUrl?: unknown };
    return parsed.registrationUrl === registrationUrl;
  } catch {
    return false;
  }
}

function writeMarker(file: string, registrationUrl: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ registrationUrl, registeredAt: new Date().toISOString() }), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  fs.renameSync(temp, file);
}

export async function registerBootstrapOnce(
  config: BootstrapRegistrationConfig,
  fetchImpl: FetchLike = fetch
): Promise<"disabled" | "already" | "registered"> {
  if (!config.registrationUrl || !config.registrationToken) return "disabled";
  if (markerExists(config.stateFile, config.registrationUrl)) return "already";

  const response = await fetchImpl(config.registrationUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-docker-host-registration": config.registrationToken
    },
    body: JSON.stringify({
      // ⚠️ Until v0.7.0 the constant "0.1.0" stood here — for six releases
      // every newly connected host reported the same wrong version, and the
      // dashboard's update view thus had no reliable basis.
      agentVersion: config.agentVersion ?? AGENT_VERSION,
      listenHost: config.listenHost,
      listenPort: config.listenPort,
      readOnly: config.readOnly
    }),
    signal: AbortSignal.timeout(10_000)
  });
  // The status travels with the error, because it alone decides the retry
  // (nextRegistrationStep): 503 means "again shortly", 404 means "never".
  // On 429 the named appointment is added — then the other side says not only
  // "not now" but "from when again".
  if (!response.ok) {
    throw new RegistrationError(response.status, response.status === 429 ? await dateFromResponse(response) : undefined);
  }
  writeMarker(config.stateFile, config.registrationUrl);
  return "registered";
}

export function startBootstrapRegistration(
  config: BootstrapRegistrationConfig,
  options: {
    fetchImpl?: FetchLike;
    log?: (message: string) => void;
    clock?: Clock;
    deadlineMs?: number;
    hardLimitMs?: number;
    // Called exactly once when the registration ends — successfully or
    // given up. The caller writes an audit entry from it: a console line on the
    // target host is gone with the next `up -d`, the audit log is not.
    onEnd?: (state: BootstrapState, reason: RegistrationEnd) => void;
  } = {}
): BootstrapLogin {
  const idle = (phase: BootstrapPhase): BootstrapLogin => ({
    stop: () => {},
    state: () => ({ phase, attempts: 0 })
  });
  if (!config.registrationUrl || !config.registrationToken) return idle("off");
  // The marker is the information that this host is already connected — and
  // thus the only one /health can give here without a single attempt.
  if (markerExists(config.stateFile, config.registrationUrl)) return idle("registered");

  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? ((message) => console.error(message));
  const clock = options.clock ?? realTime;
  const deadlineMs = options.deadlineMs ?? REGISTRATION_DEADLINE_MS;
  const hardLimitMs = options.hardLimitMs ?? REGISTRATION_HARD_LIMIT_MS;
  const begin = clock.now();
  let stopped = false;
  let scheduled: { cancel: () => void } | null = null;
  let attempts = 0;
  // Sum of the waiting times the other side demanded itself. It is subtracted
  // from the wall clock before checking against the deadline.
  let dueTotalMs = 0;
  let phase: BootstrapPhase = "running";

  const finish = (nextPhase: BootstrapPhase, reason: RegistrationEnd): void => {
    phase = nextPhase;
    // The callback must not drag the loop down with it: the audit log throws on
    // writing (audit.ts, deliberately), and an error here would otherwise end the
    // process as an unhandled rejection — because of a log entry about a
    // registration that operation does not even depend on.
    try {
      options.onEnd?.({ phase, attempts: attempts }, reason);
    } catch (error) {
      log(`[agent] end of bootstrap registration could not be recorded: ${error instanceof Error ? error.name : "Error"}`);
    }
  };

  const attempt = async (): Promise<void> => {
    if (stopped) return;
    attempts += 1;
    try {
      await registerBootstrapOnce(config, fetchImpl);
      log("[agent] bootstrap registration succeeded; the one-time token has been consumed.");
      finish("registered", "registered");
    } catch (error) {
      // Never log URL, token or response body: all three can carry bootstrap
      // metadata or secrets. The bare status may go out — it is also in every
      // reverse proxy log of the other side.
      const status = error instanceof RegistrationError ? error.status : undefined;
      const failedAs = status === undefined ? (error instanceof Error ? error.name : "Error") : `HTTP ${status}`;
      const totalMs = clock.now() - begin;
      const step = nextRegistrationStep({
        attempts,
        elapsedMs: totalMs - dueTotalMs,
        totalMs,
        status,
        dueMs: error instanceof RegistrationError ? error.dueMs : undefined,
        deadlineMs,
        hardLimitMs
      });
      if (!step.proceed) {
        const reasonText = {
          "rejected": "endpoint refuses",
          "deadline": `deadline of ${Math.round(deadlineMs / 60_000)} min expired`,
          "limit": `hard limit of ${Math.round(hardLimitMs / 60_000)} min reached`
        }[step.reason];
        log(
          `[agent] bootstrap registration given up after ${attempts} attempt${attempts === 1 ? "" : "s"} ` +
            `(last ${failedAs}, reason: ${reasonText}). ` +
            "The agent keeps running but is NOT registered with the main API. " +
            "Check DOCKER_AGENT_REGISTRATION_URL and -TOKEN and restart the container — " +
            "no marker was written, registration will start again afterwards."
        );
        finish("given-up", step.reason);
        return;
      }
      if (step.due) dueTotalMs += step.waitMs;
      log(
        `[agent] bootstrap registration not yet possible (${failedAs}); ` +
          `next attempt in ${Math.round(step.waitMs / 1000)} s` +
          `${step.due ? " (time given by the endpoint)" : ""}.`
      );
      scheduled = clock.schedule(() => void attempt(), step.waitMs);
    }
  };
  scheduled = clock.schedule(() => void attempt(), FIRST_ATTEMPT_MS);
  return {
    stop: () => {
      stopped = true;
      if (scheduled) scheduled.cancel();
    },
    state: () => ({ phase, attempts: attempts })
  };
}
