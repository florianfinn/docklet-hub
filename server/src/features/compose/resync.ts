import type { HostCycleOutcome, HostRecord } from "../../domain/hosts/index.js";
import type { Actor } from "../../platform/agent-transport/protocol.js";

export type ResyncHost = (record: HostRecord, actor: Actor) => Promise<HostCycleOutcome>;

export type ResyncReport = { status: string; error: string | null };

/**
 * The registry reconciliation after a write, as data. It must not fail the
 * write: the file is written and the stack runs. Absent means "not wired".
 */
export async function resyncAfterWrite(
  resyncHost: ResyncHost | undefined,
  host: HostRecord,
  actor: Actor
): Promise<ResyncReport> {
  if (!resyncHost) return { status: "skipped", error: null };
  try {
    const outcome = await resyncHost(host, actor);
    return { status: outcome.status, error: outcome.error };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
