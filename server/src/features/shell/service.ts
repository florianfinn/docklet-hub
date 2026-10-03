import { HUB_PERMISSION_REVOKED, HUB_SESSION_CLOSED, HUB_STREAM_BROKEN } from "contract";

import { AgentError, type AgentTarget } from "../../platform/agent-transport/protocol.js";
import type {
  ContainerAccessRequest,
  ContainerAccessResult,
  HostAccess
} from "../../domain/hosts/index.js";
import type { RouteFailure } from "../../platform/http/route-failure.js";
import * as agentClient from "./agent-client.js";
import { readInputBytes } from "./input-bytes.js";
import { startPermissionWatch, type CurrentUser, type PermissionWatch, type Scheduler } from "./permission-watch.js";
import { SESSION_UNKNOWN_MESSAGE } from "./rejections.js";
import { clientViewOf, EXEC_MAX_SESSIONS_PER_USER, type ExecSession, type ExecSessionRegister } from "./session-register.js";
import { readTerminalSize } from "./terminal-size.js";

// The service of the feature `shell` (#260): everything between the HTTP route
// and the agent client — the life of a session. The route reads parameters,
// sets the status and writes the answer; whether a session may open, whom it
// belongs to, when it ends and what the browser is told at its end is decided
// here, and `service.test.ts` decides it without Express and without an agent.
//
// ⚠️ A SESSION STAYS TIED TO THE PERSON WHO OPENED IT. The id the browser knows
// is the hub's (`ExecSessionRegister`), the agent's never leaves the server
// (`clientViewOf`), and every call after the opening compares the person, the
// arm and the container of the PATH against the entry — never against the
// entry itself, which would compare it with itself.

export type ShellAgent = Pick<typeof agentClient, "startExec" | "sendInput" | "resize" | "closeExec">;

export type ShellServiceDeps = {
  /** The chain host → reachability → version → container, for a route that writes. */
  openContainer: (request: ContainerAccessRequest) => Promise<ContainerAccessResult>;
  hosts: Pick<HostAccess, "find" | "connect">;
  /**
   * The ONE register of this server process.
   *
   * ⚠️ HANDED IN AND NOT CREATED PER CALL. It is state in memory, and an
   * instance per request would be a register that never finds anything: the
   * stream route would enter its session, and the input route would see an
   * empty register and answer `session-unknown`. No test of a single route
   * sees that. `routes.ts` creates it once per registration, and a feature is
   * registered once per router.
   */
  register: ExecSessionRegister;
  schedule: Scheduler;
  agent?: ShellAgent;
  now?: () => number;
};

/** The stream to the browser, as `relayAgentStream` gives it to the route. */
export type ShellStream = {
  /** Aborted when the browser's connection closes. */
  signal: AbortSignal;
  /** The agent answered `200`: status and headers go out now. */
  open: () => void;
  /** Writes one event; the promise is the back-pressure. */
  write: (event: unknown) => Promise<void>;
};

export type ShellPlan =
  | { ok: false; failure: RouteFailure }
  | {
      ok: true;
      /**
       * Runs the session until it ends. Call it exactly once: the session is
       * already in the register, and `run` takes it out again.
       *
       * Throws what happens BEFORE the stream opened (an `AgentError` is a
       * status for the route, anything else a bug of the hub). What happens
       * after is a line in the stream, never a throw.
       */
      run: (input: { size: unknown; stream: ShellStream; currentUser: CurrentUser }) => Promise<void>;
    };

/** The outcome of the three short calls. */
export type ShellCallResult = { ok: true } | { ok: false; failure: RouteFailure };

type SessionLookup =
  | { kind: "ok"; session: ExecSession; agentSession: string; target: AgentTarget }
  /** The entry does not fit — one answer for all four situations. */
  | { kind: "session-unknown" }
  /** The session exists, the arm does not any more: it was removed meanwhile. */
  | { kind: "host-unknown"; session: ExecSession };

/** Which session, and who asks. `hostId` and `containerId` come from the PATH. */
export type SessionCall = { sessionId: string; userId: string; hostId: string; containerId: string };

export type ShellService = {
  planSession: (request: ContainerAccessRequest) => Promise<ShellPlan>;
  sendInput: (call: SessionCall, body: unknown) => Promise<ShellCallResult>;
  resize: (call: SessionCall, body: unknown) => Promise<ShellCallResult>;
  close: (call: SessionCall) => Promise<ShellCallResult>;
};

function problem(status: number, error: string, message: string): { ok: false; failure: RouteFailure } {
  return { ok: false, failure: { kind: "problem", status, error, message } };
}

// ⚠️ ONE ANSWER FOR FOUR SITUATIONS — unknown, foreign, wrong arm, not yet
// coupled — mirrored from the agent: a different answer per situation would
// let valid session ids be confirmed through the message
// (`rejections.ts`, `SESSION_UNKNOWN_MESSAGE`).
const sessionUnknown = (): { ok: false; failure: RouteFailure } =>
  problem(404, "session-unknown", SESSION_UNKNOWN_MESSAGE);

export function createShellService(deps: ShellServiceDeps): ShellService {
  const { register, schedule } = deps;
  const agent: ShellAgent = deps.agent ?? agentClient;
  const now = deps.now ?? Date.now;

  /**
   * The session of a call, and the way to its arm — without answering.
   *
   * ⚠️ IT DOES NOT RUN `openContainer`, and that is measured, not taste: that
   * chain asks the arm for its WHOLE container list and the agent writes an
   * audit entry for it. At the stream route that is once per session and
   * right; at `input` it would be once per KEYSTROKE. And it would buy
   * nothing: arm and container were fixed when the session opened and `check`
   * holds them against the path; an agent that is too old cannot become newer
   * without restarting (which ends the session); and a container that is gone
   * takes its exec session with it, and the agent answers `session-unknown`
   * itself. What remains is the way to the arm.
   */
  async function lookupSession(call: SessionCall): Promise<SessionLookup> {
    const access = register.check(call.sessionId, {
      userId: call.userId,
      // ⚠️ FROM THE PATH AND NOT FROM THE ENTRY.
      hostId: call.hostId,
      containerId: call.containerId
    });
    if (!access.ok) return { kind: "session-unknown" };

    // The type checker does not know what `check` has proved: a session without
    // an agent id falls into the same branch as an unknown one.
    const agentSession = access.session.agentSession;
    if (agentSession === null) return { kind: "session-unknown" };

    const host = await deps.hosts.find(call.hostId);
    if (!host) return { kind: "host-unknown", session: access.session };

    // Through the same door as everywhere: `domain/hosts` alone decides which
    // secret belongs to this arm (#77, #251).
    return { kind: "ok", session: access.session, agentSession, target: await deps.hosts.connect(host) };
  }

  /**
   * An `AgentError` at a short call is an answer for the route to translate;
   * anything else is a bug of the hub and goes up.
   */
  async function callAgent(call: () => Promise<void>): Promise<ShellCallResult> {
    try {
      await call();
      return { ok: true };
    } catch (error) {
      if (!(error instanceof AgentError)) throw error;
      return { ok: false, failure: { kind: "agent-error", error } };
    }
  }

  async function run(
    session: ExecSession,
    target: AgentTarget,
    input: { size: unknown; stream: ShellStream; currentUser: CurrentUser }
  ): Promise<void> {
    const { stream } = input;
    const abort = session.abort;

    // The life of the session hangs on the browser's connection. Without this
    // the shell keeps running when the tab is closed and occupies one of the
    // FOUR session places of the arm until the agent seals it after 30
    // minutes; four abandoned tabs and nobody gets a terminal on that arm.
    //
    // ⚠️ TWO SOURCES FOR THE SAME ABORT, AND THE LAST LINE DEPENDS ON WHICH ONE
    // IT WAS (#173). When the connection to the browser closes, nobody listens
    // any more, and the stream is silent. When the HUB aborts (`close` on
    // demand, the sweep), the connection stands, and the browser learns that
    // the shell ended on request and did not break.
    const onBrowserGone = (): void => abort.abort();
    if (stream.signal.aborted) onBrowserGone();
    else stream.signal.addEventListener("abort", onBrowserGone, { once: true });

    /** The last line when the stream stops without `end`, or `null` if nobody listens. */
    const closingReason = (): string | null => {
      if (stream.signal.aborted) return null;
      return abort.signal.aborted ? HUB_SESSION_CLOSED : HUB_STREAM_BROKEN;
    };

    // One holder and no free variables: both fields are set in callbacks, and
    // a `let` would keep its first narrowing for the type checker.
    const state: { watch: PermissionWatch | null; opened: boolean } = { watch: null, opened: false };

    try {
      const outcome = await agent.startExec(
        target,
        session.containerId,
        {
          // The signed-in person, at all four calls: `actor` is a barrier here
          // and not a trace — the agent compares it strictly, and two callers
          // with `null` would count as the same.
          actor: { kind: "user", id: session.userId },
          // ⚠️ `readTerminalSize` and not `Number(body.cols ?? 80)`: `{"cols":"x"}`
          // would give `NaN`, which `JSON.stringify` writes as `null`. Clamping
          // is the agent's, not ours.
          ...readTerminalSize(input.size),
          signal: abort.signal,
          onOpen: () => {
            state.opened = true;
            stream.open();
            // ⚠️ THE BEAT STARTS HERE AND NOT EARLIER. Until `open` an error can
            // still be a status code; a beat that struck before would write a
            // stream line into a response that is none yet.
            state.watch = startPermissionWatch({
              schedule,
              userId: session.userId,
              currentUser: input.currentUser,
              onRevoked: () => {
                // ⚠️ THE ORDER IS THE POINT. The line first — after `abort()`
                // the stream is gone and the browser would see an answer that
                // just stops. Then abort, then remove; the response ends when
                // `startExec` returns.
                void stream.write({ kind: "error", reason: HUB_PERMISSION_REVOKED });
                abort.abort();
                register.remove(session.id);
              }
            });
          },
          onStart: (start) => {
            // Couple first, then tell: until coupled the session takes no
            // input, and a browser that types on the `start` line would run
            // into `session-unknown` for its own session.
            register.couple(session.id, start.agentSession);
            // ⚠️ `clientViewOf` and no hand-built object: "the agent's session
            // id never leaves the server" is a function a test can hold.
            void stream.write({ kind: "start", ...clientViewOf(session) });
          }
        },
        (text) => stream.write({ kind: "output", text })
      );

      // The beat has spoken already: the rest is silent. The revocation aborts
      // the stream and `startExec` then reports `unterminated` — a second
      // `error` line would turn a clear message into a vague one.
      if (state.watch?.revoked()) return;

      if (outcome.kind === "unterminated") {
        // ⚠️ THE AGENT SAYS NOTHING MORE HERE. Two of its four exits have no last
        // line; WHICH caller aborted only the hub knows, and `closingReason`
        // reads it from its own signal. A browser that still listens gets a
        // closing line, otherwise it waits for an end that never comes.
        const reason = closingReason();
        if (reason !== null) void stream.write({ kind: "error", reason });
        return;
      }
      void stream.write({ kind: "end", exitCode: outcome.exitCode });
    } catch (error) {
      // Before the stream opened the status is still open: the route answers.
      if (!state.opened) throw error;
      // Too late for a status code. The outcome is a line in the stream, if
      // any belongs there: a body that breaks without the hub's doing is
      // `agent-stream-broken`, as with the log stream (#130).
      const reason = closingReason();
      if (reason !== null) void stream.write({ kind: "error", reason });
    } finally {
      // ⚠️ THE BEAT IS CLEARED, AND HERE (see `intervalSchedule`).
      state.watch?.stop();
      stream.signal.removeEventListener("abort", onBrowserGone);
      // ⚠️ HERE AND NOT ONLY IN THE SWEEP. The sweep is the fallback and runs
      // only when someone opens a new session; if nobody does, a corpse
      // survives until then, counts against the limit, and its id stays a
      // valid key for a shell that no longer exists.
      register.remove(session.id);
    }
  }

  return {
    planSession: async (request) => {
      // ⚠️ `"writes"`: a shell is the most writing access this hub knows. An
      // arm whose agent is too old answers `409 agent-outdated` — BEFORE the
      // agent is called, because a lock that holds only afterwards locked
      // nothing.
      const opened = await deps.openContainer(request);
      if (!opened.ok) return opened;
      const { host, container, target } = opened.access;

      const at = now();
      // ⚠️ THE SWEEP STANDS BEFORE THE COUNT. The count decides a refusal in a
      // moment; counted on an unswept register it would refuse a person for
      // two sessions of which one has been dead for half an hour.
      register.sweep(at);
      if (register.countFor(request.userId, host.id) >= EXEC_MAX_SESSIONS_PER_USER) {
        // ⚠️ BEFORE THE AGENT IS TOUCHED. A limit that holds only after the call
        // has opened the session there already and counts against the arm's
        // cap, which it is meant to protect. Count and entry have no `await`
        // between them, so two requests cannot both pass the count.
        return problem(
          429,
          "own-session-limit",
          `Auf diesem Arm sind schon ${EXEC_MAX_SESSIONS_PER_USER} eigene Shells offen. ` +
            "Eine davon schließen, dann geht die nächste auf."
        );
      }

      const session = register.open({
        hostId: host.id,
        containerId: container.id,
        // ⚠️ THE NAME COMES FROM THE HUB'S OWN CONTAINER LIST and not from the
        // agent's `start` line, although that carries it too: a second truth
        // about one value, which could drift apart unnoticed.
        containerName: container.name,
        userId: request.userId,
        abort: new AbortController(),
        now: at
      });
      return { ok: true, run: (input) => run(session, target, input) };
    },

    sendInput: async (call, body) => {
      const found = await lookupSession(call);
      // Also "the arm is gone" is `session-unknown` here. A session on a removed
      // arm is none any more, and an own code would reveal that it existed —
      // the very information the barrier prevents. Only `close` treats it
      // differently, for another reason.
      if (found.kind !== "ok") return sessionUnknown();

      const bytes = readInputBytes(body);
      if (bytes === null) {
        return problem(
          400,
          "invalid-input",
          "Der Rumpf dieser Route ist `{ \"data\": \"<base64>\" }`. Ein fehlendes, nicht zeichenkettiges " +
            "oder nicht kanonisch kodiertes Feld wird abgelehnt und nicht als leere Eingabe durchgelassen."
        );
      }
      // Raw bytes out: `sendInput` takes a `Uint8Array` and encodes itself, so
      // that no caller can forget it.
      return callAgent(() =>
        agent.sendInput(found.target, found.agentSession, bytes, { actor: { kind: "user", id: call.userId } })
      );
    },

    resize: async (call, body) => {
      const found = await lookupSession(call);
      if (found.kind !== "ok") return sessionUnknown();
      // ⚠️ `readTerminalSize` and no check of our own. Clamping is the agent's
      // (8…500 × 4…300); a clamp here would be a second truth about a foreign
      // limit. A value too large is not refused either: the size is display and
      // no decision about rights, and a `400` in the middle of typing would be
      // the worse answer.
      const size = readTerminalSize(body);
      return callAgent(() =>
        agent.resize(found.target, found.agentSession, size, { actor: { kind: "user", id: call.userId } })
      );
    },

    close: async (call) => {
      const found = await lookupSession(call);
      // ⚠️ THE CHECK OF THE SESSION HOLDS HERE TOO. Without it person B would
      // close the shell of person A as soon as an id comes into their hands —
      // the one lock that `close` does NOT lose.
      if (found.kind === "session-unknown") return sessionUnknown();

      // ⚠️ FROM HERE `close` ALWAYS ANSWERS OK, and that is the measured
      // difference to the other three. At the agent the kill switch hits `input`
      // and `size`, not `close`. For the hub that means: its own entry
      // disappears and the answer is ok, even if the arm is removed, outdated
      // or silent and even if the call fails there. A session that cannot be
      // closed is the worse state — it counts against the own limit, and the
      // operator cannot reach it any more.
      register.remove(found.session.id);
      // The own stream ends too, otherwise the output would run into a
      // connection nobody keeps books for. What the sweep does, on demand.
      found.session.abort.abort();

      if (found.kind === "host-unknown") return { ok: true };
      // ⚠️ SWALLOWED AND NOT REPORTED: the entry is removed and the stream
      // ended, so for the hub the session is closed. At the agent it runs at
      // most until its own maximum, the better of two bad states.
      await callAgent(() =>
        agent.closeExec(found.target, found.agentSession, { actor: { kind: "user", id: call.userId } })
      );
      return { ok: true };
    }
  };
}
