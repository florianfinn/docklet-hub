import { speaksAgentContract, type AgentHealth, type HostAccess, type HostRecord } from "../../domain/hosts/index.js";
import { parseTail, streamLogs, type LogLine, type LogStreamOptions } from "./agent-client.js";
import { normalizeLogTailLines, type LogSettings } from "./store.js";

// The service of the feature `logs` (#254): everything between the HTTP route
// and the agent client. The route reads parameters, sets the status and writes
// the answer; which `tail` applies and which host is meant is decided here,
// and the tests decide it without Express (`service.test.ts`).

export type LogsServiceDeps = {
  hosts: Pick<HostAccess, "find" | "connect">;
  // The health of an arm: the route passes the observed probe of the host
  // cycle, the same one the shell asks.
  probe: (record: HostRecord) => Promise<AgentHealth>;
  // The stored setting, as functions and not a pool: the service tests run
  // without Postgres, and the route passes `readLogSettings(pool)`.
  readSettings: () => Promise<LogSettings>;
  writeSettings: (settings: LogSettings) => Promise<LogSettings>;
};

/** The options of one log stream; `tail` is the service's decision. */
export type ContainerLogStreamOptions = Omit<LogStreamOptions, "tail">;

/**
 * What a request for a container log comes to before anything is streamed.
 *
 * ⚠️ Every failure is decided BEFORE the agent is asked, so the route can
 * still answer them with a status. `stream` connects to the agent only when
 * called, inside the stream relay, where a failure before `open` is a status
 * as well.
 */
export type ContainerLogPlan =
  | { ok: false; error: "invalid-tail" | "host-unknown" | "agent-outdated" }
  | {
      ok: true;
      tail: number;
      stream: (options: ContainerLogStreamOptions, onLine: (line: LogLine) => void | Promise<void>) => Promise<void>;
    };

export type LogsService = {
  planContainerLog: (request: { hostId: string; containerId: string; tail: unknown }) => Promise<ContainerLogPlan>;
  readSettings: () => Promise<LogSettings>;
  // `{ ok: false }` for anything that is not one of the four allowed numbers.
  updateSettings: (tailLines: unknown) => Promise<{ ok: true; settings: LogSettings } | { ok: false }>;
};

export function createLogsService(deps: LogsServiceDeps): LogsService {
  return {
    planContainerLog: async ({ hostId, containerId, tail: requested }) => {
      // ⚠️ The sent value first, then (only if there is none) the stored
      // setting. Checking the query parameter costs nothing; reading
      // `log_settings` is a database query, and a connection to the agent
      // even more so. An invalid value triggers neither.
      let tail: number;
      if (requested === undefined) {
        // A missing `tail` is no gap: the operator answered the question with
        // the global setting (step G, #5), and a caller need not repeat it.
        tail = (await deps.readSettings()).tailLines;
      } else {
        const parsed = parseTail(requested);
        // ⚠️ No silent fall back to the setting for an invalid value: that
        // would acknowledge a request that was never made.
        if (parsed === null) return { ok: false, error: "invalid-tail" };
        // ⚠️ Every valid integer 1..2000 passes, even one that is none of the
        // four values of the setting (`LOG_TAIL_LINE_OPTIONS`). The four are
        // what the SURFACE offers, not the contract this route allows; the
        // agent itself only caps with `Math.min(tail, MAX_LOG_TAIL_LINES)` in
        // `resolveLogTail` (`agent/src/log-tail.ts`).
        tail = parsed;
      }

      const host = await deps.hosts.find(hostId);
      if (!host) return { ok: false, error: "host-unknown" };

      // ⚠️ An arm below `CONTRACT_VERSION` speaks the stream words from before
      // #278 (`zeile` instead of `line`). The reader drops every such line, and
      // the surface showed an open log in which the container had "said
      // nothing yet", while it kept writing. Refused with a status instead,
      // before the agent is asked. Only the contract counts here: an older
      // version with the current contract streams fine, and an arm that does
      // not answer stays the case of the stream relay.
      const health = await deps.probe(host);
      if (health.reachable && !speaksAgentContract(health.contractVersion)) {
        return { ok: false, error: "agent-outdated" };
      }

      return {
        ok: true,
        tail,
        stream: async (options, onLine) =>
          streamLogs(await deps.hosts.connect(host), containerId, { ...options, tail }, onLine)
      };
    },
    readSettings: () => deps.readSettings(),
    updateSettings: async (tailLines) => {
      const parsed = normalizeLogTailLines(tailLines);
      if (!parsed.ok) return { ok: false };
      return { ok: true, settings: await deps.writeSettings({ tailLines: parsed.value }) };
    }
  };
}
