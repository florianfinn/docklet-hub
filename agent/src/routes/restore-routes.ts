import { StackEndpointError } from "../stack-control.js";
import { restoreStartRequestSchema, restorePreviewRequestSchema, UPDATE_PRECHECK_TIMEOUT_MS } from "contract";
import { readJsonBody, parseRequest, rejectRequest, type ContainerRouteContext, type RouteContext } from "../runtime/http.js";
import { restoreRunner } from "../runtime/restores.js";
import { backupStore } from "../runtime/backups.js";
import { updateRoute } from "./update-routes.js";
import { authorizeUpdateSelection } from "../runtime/updates.js";
import { engine, registry } from "../runtime/state.js";
import { stopIntentTarget } from "../stop-intent.js";
import { runtimeStateOf } from "../runtime-actions.js";
import { UpdateBudget, UpdateFailure } from "../update-budget.js";
import { updateRecovery } from "../runtime/update-recovery.js";

export async function handleBackups(ctx: ContainerRouteContext): Promise<void> {
  await updateRoute(ctx, "backups", async () => {
    if (!registry.get(ctx.containerId)) throw new StackEndpointError(404, "not-allowlisted");
    const raw = await engine.inspect(ctx.containerId); const target = stopIntentTarget(raw);
    if (!target) throw new UpdateFailure("backup-target-mismatch");
    const state = runtimeStateOf(raw);
    await authorizeUpdateSelection({ target, expectedContainer: { containerId: raw.Id, status: state.status, startedAt: state.startedAt },
      startDeadlineSeconds: 120, backup: null }, ctx.actor, new UpdateBudget(UPDATE_PRECHECK_TIMEOUT_MS));
    return { target, backups: await backupStore.list(target) };
  });
}
export async function handleRestorePreview(ctx: RouteContext): Promise<void> {
  const parsed = parseRequest(restorePreviewRequestSchema, await readJsonBody(ctx.request));
  if (!parsed.ok) { rejectRequest(ctx, { action: "restore-preview", containerId: null, containerName: null }, parsed.rejection); return; }
  await updateRoute(ctx, "restore-preview", () => restoreRunner.preview(parsed.value, ctx.actor));
}
export async function handleRestoreStart(ctx: RouteContext): Promise<void> {
  const parsed = parseRequest(restoreStartRequestSchema, await readJsonBody(ctx.request));
  if (!parsed.ok) { rejectRequest(ctx, { action: "restore", containerId: null, containerName: null }, parsed.rejection); return; }
  await updateRoute(ctx, "restore", async () => {
    if (!updateRecovery.isReady()) throw new UpdateFailure("state-changed");
    await authorizeUpdateSelection({ target: parsed.value.target, expectedContainer: parsed.value.expectedContainer,
      startDeadlineSeconds: parsed.value.startDeadlineSeconds, backup: null }, ctx.actor, new UpdateBudget(UPDATE_PRECHECK_TIMEOUT_MS));
    return restoreRunner.start(parsed.value, ctx.actor);
  });
}
