import { agentJobRequestSchema, agentJobsQuerySchema } from "contract";
import { config, registry, audit } from "../runtime/state.js";
import { queryObject } from "../request-keys.js";
import { parseRequest, rejectRequest, send, type RouteContext } from "../runtime/http.js";
import { unavailableRoute } from "./contract-route-stubs.js";

export async function handleJobs(ctx: RouteContext): Promise<void> {
  const query: Record<string, unknown> = queryObject(ctx.url);
  if (typeof query.target === "string") {
    try { query.target = JSON.parse(query.target); }
    catch {
      rejectRequest(ctx, { action: "jobs", containerId: null, containerName: null }, { error: "invalid-request", field: "target" });
      return;
    }
  }
  const parsed = parseRequest(agentJobsQuerySchema, query);
  if (!parsed.ok) {
    rejectRequest(ctx, { action: "jobs", containerId: null, containerName: null }, parsed.rejection);
    return;
  }
  await unavailableRoute(ctx, "jobs", "jobs", false);
}

export async function handleJob(ctx: RouteContext, match: RegExpMatchArray, cancel: boolean): Promise<void> {
  const parsed = parseRequest(agentJobRequestSchema, { jobId: decodeURIComponent(match[1]) });
  const action = cancel ? "job-cancel" : "job-progress";
  if (!parsed.ok) {
    rejectRequest(ctx, { action, containerId: null, containerName: null }, parsed.rejection);
    return;
  }
  if (cancel) {
    // Without stored job targets, any observer entry prevents proving write access.
    const denial = config.readOnly ? { status: 503, error: "agent-read-only" }
      : registry.knownIds().some((id) => registry.isObserveOnly(id)) ? { status: 403, error: "observe-only" } : null;
    if (denial) {
      audit.write({ action, containerId: null, containerName: null, actor: ctx.actor,
        outcome: "denied", reason: denial.error });
      send(ctx.response, denial.status, { error: denial.error });
      return;
    }
  }
  await unavailableRoute(ctx, action, action, cancel);
}
