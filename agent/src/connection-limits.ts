import http from "node:http";

// Deadlines and connection caps of the TRANSPORT layer (R5, security review
// 2026-08).
//
// R3 caps the FUNCTIONAL streams: how many log, monitor and exec paths may be
// open at the same time (concurrency.ts). Below that lies a layer that knows
// none of those rules. A TCP connection that sends only half the header and
// then goes silent never reaches a route, is never counted and still holds a
// descriptor of the process that is the ONLY path to the socket. If that
// process fails, the whole management path is gone.
//
// Why this was not "just set some values": three of the agent's paths run
// long ON PURPOSE — the log and pull streams until the caller leaves,
// `monitor-events` as the main API's continuous stream, `exec` up to
// EXEC_MAX_DURATION_MS (30 minutes). A value chosen too small cuts exactly
// these paths, and in the middle of operation, without the cause being
// recognisable from the symptom. That is why a MEASUREMENT comes first instead
// of a guess.
//
// --- What the measurement showed --------------------------------------------
//
// Measured with Node 24; the runtime image runs node:22-alpine. All four
// knobs exist in both versions (`connectionsCheckingInterval` since 18.2),
// and the tests below prove the behaviour on the Node version they are
// currently running under — so the measurement is not the only promise but
// the justification.
//
//   Deadline           applies from … to                   Stream affected?
//   ------------------ ----------------------------------- -----------------
//   headersTimeout     first byte of the request to the     no
//                      last header line
//   requestTimeout     first byte of the request to the     no — the deadline
//                      end of the BODY                      ends as soon as
//                                                           the body is
//                                                           complete; the
//                                                           RESPONSE then runs
//                                                           on without a deadline
//   keepAliveTimeout   idle time BETWEEN two requests       no
//                      on the same connection
//   server.timeout     inactivity of the SOCKET, also       YES — a log stream
//                      during the response                  without output is
//                                                           exactly that
//
// The last row is the decisive one: the deadline that cuts the long-lived
// paths is NOT `requestTimeout` but `server.timeout`. Measured on a stream
// that ran for 1.5 seconds: with `requestTimeout = 400 ms` it ran through
// completely, with `server.timeout = 300 ms` it broke off after 302 ms —
// and a stream that outputs NOTHING AT ALL for 1.2 seconds (the normal case
// of a quiet log stream) survived requestTimeout as well.
//
// Two decisions follow from that:
//
//   1. `server.timeout` stays off (0, Node default) and is set explicitly
//      here, so the zero stands as a DECISION and not as an omission.
//   2. The `request.setTimeout(0)` per long-lived route that the
//      recommendation envisaged as a way out is dropped: it sets exactly this
//      socket deadline, which is never set here anyway. An exception list that
//      exempts nothing would be a second list to drift apart — R5 would have
//      acquired the same failure shape that route-policy.ts stands against.
//
// --- The second measurement finding: the resolution -------------------------
//
// Node does not check the two deadlines continuously but at an interval
// (`connectionsCheckingInterval`, default 30 seconds). In the trial a half
// header outlived the configured 150 ms twentyfold — not because the deadline
// was wrong, but because nobody looked. With the default,
// `headersTimeout = 15 s` would really mean "between 15 and 45 seconds".
// That is why the interval is set here as well; without it the number next to
// it would be a claim instead of a cap.

export type ConnectionLimits = {
  connectionsCheckingInterval: number;
  headersTimeout: number;
  requestTimeout: number;
  keepAliveTimeout: number;
  maxConnections: number;
};

// How often Node checks the open connections against the deadlines. Five
// seconds means: a hanging connection goes at most five seconds after its
// deadline. That is the resolution at which the numbers below hold at all —
// and cheap enough, because a pass only walks the list of open connections,
// which is bounded thanks to `maxConnections`.
const CHECK_INTERVAL_MS = 5_000;

// By this point the last header line must have arrived (Node default: 60 s).
//
// The agent has EXACTLY one legitimate caller: the main API over the
// WireGuard network. A header block fits into one or two segments there and
// arrives in milliseconds; fifteen seconds are three orders of magnitude of
// slack for a tunnel hiccup. The lower bound is set not by the technology but
// by distinguishability: a value in the range of seconds would also hit real
// requests while the tunnel is being re-established and could then no longer
// be told apart from a network problem as the cause.
const HEADER_LINE_DEADLINE_MS = 15_000;

// By this point the WHOLE request must have arrived, body included
// (Node default: 300 s, deliberately adopted here).
//
// The number does not come from gut feeling but from the largest body the
// agent accepts: Web-FTP allows 64 MiB (MAX_UPLOAD_BYTES, contract/src/agent/limits.ts).
// At 300 seconds that requires at least ~220 KB/s on the path
// browser → main API → agent. That is the limit below which an upload that
// should arrive would be cut off — a connection that cannot sustain it does
// not upload 64 MiB in this dashboard anyway.
//
// ⚠️ Node requires `headersTimeout <= requestTimeout` and otherwise throws when
// creating the server. The test pins down the relation so it does not only
// show up at startup.
const REQUEST_DEADLINE_MS = 300_000;

// Idle time between two requests on the same connection (Node default: 5 s,
// deliberately adopted here).
//
// Five seconds cover the bundle of requests that an opened container view
// triggers, without holding a forgotten socket for long. The number stands
// here not because it is supposed to change but so that it is FIXED: it is
// part of the descriptor budget, and a default that a future Node version
// shifts would be a silent change to exactly that budget.
//
// As measured, the socket closes about one second later than the number says —
// Node grants the caller a grace period so it can honour the announced
// `Keep-Alive: timeout=5` first.
const IDLE_DEADLINE_MS = 5_000;

// What an accepted connection costs in descriptors in the worst case: the
// socket itself and a second one for whatever opens behind it — the engine
// connection of a log or pull stream, the descriptor of a followed log file,
// the socket of an exec session.
const DESCRIPTORS_PER_CONNECTION = 2;

// What the process needs independently of connections: the audit log, the
// registry and monitor files, the periodic stats collector, the pipes of the
// `docker compose` child processes, its own registration with the main API. A
// generous item, because the mistake in the other direction would be
// expensive: whoever pushes the budget to the edge loses not a connection but
// the audit log or the Compose call.
const DESCRIPTOR_RESERVE = 128;

// Below this number the cap would be the wrong protection. R3 allows 8 reading
// streams, 4 monitor streams and 4 exec sessions at the same time — a
// connection cap below that would let the agent fail at its OWN limit before
// the host's limit even came into view, and the 429 (`too-many-streams`) that
// would have explained it would never come about.
export const MIN_CONNECTIONS = 16;

// Above this, the descriptor is no longer the bottleneck. The agent serves one
// caller; five hundred simultaneous connections are not an operation to
// enable but one you want to see bounded.
export const MAX_CONNECTIONS = 512;

// The process's soft descriptor limit (RLIMIT_NOFILE), or `null`.
//
// Deliberately from the diagnostic report instead of an environment variable:
// the budget the agent runs in is set by the container and not by whatever
// someone wrote in at deploy time. `null` means "not readable" — on a
// developer machine without POSIX limits, or when the report lists the value
// as "unlimited".
export function softDescriptorLimit(
  report: () => unknown = () => process.report?.getReport() ?? null
): number | null {
  try {
    const data = report() as { userLimits?: { open_files?: { soft?: unknown } } } | null;
    const soft = data?.userLimits?.open_files?.soft;
    if (typeof soft !== "number" || !Number.isFinite(soft) || soft <= 0) return null;
    return soft;
  } catch {
    // The report is a diagnostic interface, not a load-bearing one. If it
    // fails, the agent does not fail with it — it takes the fallback value.
    return null;
  }
}

// The connection cap, derived from the descriptor budget instead of from a
// number picked by feel.
//
// If the budget is not readable, the upper bound applies: a budget you cannot
// see cannot be divided — and a cap that turned out too small would be the
// more expensive mistake here, because it narrows the only path to the socket
// without needing an attacker for it.
export function maxConnectionsFrom(softLimit: number | null): number {
  if (softLimit === null) return MAX_CONNECTIONS;
  const sustainable = Math.floor((softLimit - DESCRIPTOR_RESERVE) / DESCRIPTORS_PER_CONNECTION);
  return Math.min(MAX_CONNECTIONS, Math.max(MIN_CONNECTIONS, sustainable));
}

export const CONNECTION_LIMITS: ConnectionLimits = {
  connectionsCheckingInterval: CHECK_INTERVAL_MS,
  headersTimeout: HEADER_LINE_DEADLINE_MS,
  requestTimeout: REQUEST_DEADLINE_MS,
  keepAliveTimeout: IDLE_DEADLINE_MS,
  maxConnections: maxConnectionsFrom(softDescriptorLimit())
};

// The agent's HTTP server — created with the limits, not fitted with them
// afterwards.
//
// ⚠️ `connectionsCheckingInterval` ONLY works via `createServer`. Set as a
// property afterwards it has no effect: the server takes the interval from the
// constructor value once at `listen`. That is exactly why this is a factory and
// not a `setLimits(server)` — the quietest way to lose this protection would
// be a function called after creation that can no longer set exactly that one
// value.
export function createServer(
  handler: http.RequestListener,
  limits: ConnectionLimits = CONNECTION_LIMITS
): http.Server {
  const server = http.createServer(
    {
      connectionsCheckingInterval: limits.connectionsCheckingInterval,
      headersTimeout: limits.headersTimeout,
      requestTimeout: limits.requestTimeout,
      keepAliveTimeout: limits.keepAliveTimeout
    },
    handler
  );
  server.maxConnections = limits.maxConnections;
  // ⚠️ The zero is the decision, not the omission: `server.timeout` is the
  // ONLY deadline that hits a running response (see measurement above).
  // Whoever sets it cuts log, pull and exec paths — and after inactivity, that
  // is, exactly when a log stream has nothing to report.
  server.timeout = 0;
  return server;
}

// One line for the startup log. Which limits apply should be readable from
// the container log and not from the source — the derived connection cap
// depends on the host's budget and therefore appears nowhere else.
export function describeLimits(limits: ConnectionLimits = CONNECTION_LIMITS): string {
  return (
    `headers ${limits.headersTimeout / 1000}s, ` +
    `request ${limits.requestTimeout / 1000}s, ` +
    `keep-alive ${limits.keepAliveTimeout / 1000}s, ` +
    `max connections ${limits.maxConnections}`
  );
}
