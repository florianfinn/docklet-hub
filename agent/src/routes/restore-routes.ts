import { restoreStartRequestSchema, restorePreviewRequestSchema } from "contract";
import { audit } from "../runtime/state.js";
import { readJsonBody, parseRequest, rejectRequest, send, type ContainerRouteContext, type RouteContext } from "../runtime/http.js";
import { containerIdsForTarget, unavailableRoute } from "./contract-route-stubs.js";

export async function handleBackups(ctx: ContainerRouteContext): Promise<void> {
  await unavailableRoute(ctx, "backups", "backups", false, [ctx.containerId]);
}

export async function handleRestorePreview(ctx: RouteContext): Promise<void> {
  const parsed = parseRequest(restorePreviewRequestSchema, await readJsonBody(ctx.request));
  if (!parsed.ok) {
    rejectRequest(ctx, { action: "restore-preview", containerId: null, containerName: null }, parsed.rejection);
    return;
  }
  const ids = containerIdsForTarget(parsed.value.target);
  if (ids.length === 0) {
    audit.write({ action: "restore-preview", containerId: null, containerName: null,
      actor: ctx.actor, outcome: "denied", reason: "not-allowlisted" });
    send(ctx.response, 404, { error: "not-allowlisted" });
    return;
  }
  await unavailableRoute(ctx, "restore-preview", "restore", false, ids);
}

export async function handleRestoreStart(ctx: RouteContext): Promise<void> {
  const parsed = parseRequest(restoreStartRequestSchema, await readJsonBody(ctx.request));
  if (!parsed.ok) {
    rejectRequest(ctx, { action: "restore", containerId: null, containerName: null }, parsed.rejection);
    return;
  }
  await unavailableRoute(ctx, "restore", "restore", true, [parsed.value.expectedContainer.containerId]);
}
