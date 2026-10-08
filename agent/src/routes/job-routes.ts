import { agentJobRequestSchema, agentJobsQuerySchema } from "contract";
import { queryObject } from "../request-keys.js";
import { parseRequest, rejectRequest, type RouteContext } from "../runtime/http.js";
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
  // Until the job store resolves targets, cancellation fails closed in gate().
  await unavailableRoute(ctx, action, action, cancel, cancel ? [null] : []);
}
