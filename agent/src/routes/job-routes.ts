import { agentJobRequestSchema, agentJobsQuerySchema } from "contract";
import { queryObject } from "../request-keys.js";
import { parseRequest, rejectRequest, send, type RouteContext } from "../runtime/http.js";
import { agentJobs } from "../runtime/updates.js";
import { audit } from "../runtime/state.js";
import { gate } from "../runtime/gate.js";
import { containerIdsForTarget } from "./contract-route-stubs.js";
import { updateRoute } from "./update-routes.js";
import { StackEndpointError } from "../stack-control.js";

export async function handleJobs(ctx: RouteContext): Promise<void> {
  const query: Record<string, unknown> = queryObject(ctx.url);
  if (typeof query.target === "string") {
    try { query.target = JSON.parse(query.target); }
    catch { rejectRequest(ctx, { action: "jobs", containerId: null, containerName: null }, { error: "invalid-request", field: "target" }); return; }
  }
  const parsed = parseRequest(agentJobsQuerySchema, query);
  if (!parsed.ok) { rejectRequest(ctx, { action: "jobs", containerId: null, containerName: null }, parsed.rejection); return; }
  ctx.response.setHeader("Cache-Control", "no-store");
  audit.write({ action: "jobs", actor: ctx.actor, containerId: null, containerName: null, outcome: "allowed" });
  send(ctx.response, 200, agentJobs.list(parsed.value));
}
export async function handleJob(ctx: RouteContext, match: RegExpMatchArray, cancel: boolean): Promise<void> {
  const parsed = parseRequest(agentJobRequestSchema, { jobId: decodeURIComponent(match[1]) });
  const action = cancel ? "job-cancel" : "job-progress";
  if (!parsed.ok) { rejectRequest(ctx, { action, containerId: null, containerName: null }, parsed.rejection); return; }
  ctx.response.setHeader("Cache-Control", "no-store");
  await updateRoute(ctx, action, async () => {
    const progress = agentJobs.get(parsed.value.jobId);
    if (!progress) throw new StackEndpointError(404, "update-job-unknown");
    if (!cancel) return { progress };
    for (const target of agentJobs.targets(progress.jobId)!) {
      const ids = containerIdsForTarget(target);
      if (ids.length !== 1) throw new StackEndpointError(409, "state-changed");
      const result = await gate(ids[0], { action: progress.kind === "update" ? "update" : "restore", mutating: true, actor: ctx.actor });
      if (!result.ok) throw new StackEndpointError(result.status, result.reason.split(":")[0]);
    }
    if (!agentJobs.cancel(progress.jobId)) throw new StackEndpointError(409,
      progress.kind === "update" ? "update-cancel-too-late" : "restore-cancel-too-late");
    return { jobId: progress.jobId, accepted: true };
  });
}
