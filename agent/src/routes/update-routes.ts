import { updateRecovery } from "../runtime/update-recovery.js";
import { updatePreviewRequestSchema, updateStartRequestSchema, UPDATE_PRECHECK_TIMEOUT_MS } from "contract";
import { readJsonBody, parseRequest, rejectRequest, send, type RouteContext } from "../runtime/http.js";
import { updateRunner, authorizeUpdateSelection } from "../runtime/updates.js";
import { audit } from "../runtime/state.js";
import { UpdateBudget, UpdateFailure } from "../update-budget.js";
import { StackEndpointError } from "../stack-control.js";

export async function updateRoute(ctx: RouteContext, action: string, run: () => Promise<unknown>): Promise<void> {
  try {
    const result = await run();
    audit.write({ action, actor: ctx.actor, containerId: null, containerName: null, outcome: "allowed", reason: action === "update" ? "queued" : undefined });
    send(ctx.response, 200, result);
  }
  catch (error) {
    const reason = error instanceof UpdateFailure ? error.code : error instanceof StackEndpointError ? error.code : "internal-error";
    const status = error instanceof StackEndpointError ? error.status : error instanceof UpdateFailure ? 409 : 500;
    audit.write({ action, actor: ctx.actor, containerId: null, containerName: null, outcome: "denied", reason });
    send(ctx.response, status, { error: reason });
  }
}
export async function handleUpdatePreview(ctx: RouteContext): Promise<void> {
  const parsed = parseRequest(updatePreviewRequestSchema, await readJsonBody(ctx.request));
  if (!parsed.ok) { rejectRequest(ctx, { action: "update-preview", containerId: null, containerName: null }, parsed.rejection); return; }
  await updateRoute(ctx, "update-preview", async () => {
    const budget = new UpdateBudget(UPDATE_PRECHECK_TIMEOUT_MS);
    await Promise.all(parsed.value.services.map((service) => authorizeUpdateSelection(service, ctx.actor, budget)));
    if (parsed.value.services.some((s) => s.backup !== null)) throw new StackEndpointError(409, "backup-incomplete");
    return updateRunner.preview(parsed.value, ctx.actor, budget);
  });
}
export async function handleUpdateStart(ctx: RouteContext): Promise<void> {
  const parsed = parseRequest(updateStartRequestSchema, await readJsonBody(ctx.request));
  if (!parsed.ok) { rejectRequest(ctx, { action: "update", containerId: null, containerName: null }, parsed.rejection); return; }
  await updateRoute(ctx, "update", async () => {
    if (!updateRecovery.isReady()) throw new UpdateFailure("update-rollback-unavailable");
    const budget = new UpdateBudget(UPDATE_PRECHECK_TIMEOUT_MS);
    await Promise.all(parsed.value.services.map((service) => authorizeUpdateSelection(service, ctx.actor, budget)));
    if (parsed.value.services.some((s) => s.backup !== null)) throw new StackEndpointError(409, "backup-incomplete");
    return updateRunner.start(parsed.value, ctx.actor);
  });
}
