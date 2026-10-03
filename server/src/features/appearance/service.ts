import type { HostThemePreset } from "contract";
import type { Pool } from "pg";

import { probeAgent, setHostDisplay, toHostView, type HostRecord } from "../../domain/hosts/index.js";

// The service of the feature `appearance` (#268): what `PUT /hosts/:hostId/display`
// decides between reading the request and writing the answer. The route reads
// the parameters, sets the status and writes the answer; `service.test.ts`
// checks the rest without Express, without Postgres and without an agent.
//
// The global theme needs no service: it is one check and one write, and the
// route says it in two lines.
//
// ⚠️ The outcome is a value with a `kind`, never a status code. Which status a
// `kind` becomes is the route's table; the service knows no HTTP.

export type HostView = ReturnType<typeof toHostView>;

export type SetHostColorResult = { kind: "ok"; host: HostView } | { kind: "host-unknown" };

/** What the colour of an arm calls out; injectable for `service.test.ts`. */
export type AppearanceDeps = {
  setHostDisplay: (hostId: string, display: HostThemePreset) => Promise<HostRecord | null>;
  probeAgent: typeof probeAgent;
};

export function appearanceDeps(pool: Pool): AppearanceDeps {
  return { setHostDisplay: (hostId, display) => setHostDisplay(pool, hostId, display), probeAgent };
}

/**
 * Stores hue and ink of an arm and answers with its view.
 *
 * ⚠️ The state is read AGAIN, as in `GET /hosts`: a `null` as health would turn
 * every coloured arm in the answer into "offline". An arm in the state `pending`
 * is not asked — its tunnel is not up yet.
 */
export async function setHostColor(
  deps: AppearanceDeps,
  hostId: string,
  display: HostThemePreset
): Promise<SetHostColorResult> {
  const record = await deps.setHostDisplay(hostId, display);
  if (!record) return { kind: "host-unknown" };
  const health = record.state === "pending" ? null : await deps.probeAgent(record.agentUrl, { timeoutMs: 3_000 });
  return { kind: "ok", host: toHostView(record, health) };
}
