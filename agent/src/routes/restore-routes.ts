import { restoreStartRequestSchema, restorePreviewQuerySchema } from "contract";
import { queryObject } from "../request-keys.js";
import { readJsonBody, parseRequest, rejectRequest, type ContainerRouteContext, type RouteContext } from "../runtime/http.js";
import { unavailableRoute } from "./contract-route-stubs.js";

export async function handleBackups(ctx: ContainerRouteContext): Promise<void> {
  await unavailableRoute(ctx, "backups", "backups", false, [ctx.containerId]);
}

export async function handleRestorePreview(ctx: ContainerRouteContext): Promise<void> {
  const parsed = parseRequest(restorePreviewQuerySchema, queryObject(ctx.url));
  if (!parsed.ok) {
    rejectRequest(ctx, { action: "restore-preview", containerId: ctx.containerId, containerName: null }, parsed.rejection);
    return;
  }
  await unavailableRoute(ctx, "restore-preview", "restore", false, [ctx.containerId]);
}

export async function handleRestoreStart(ctx: RouteContext): Promise<void> {
  const parsed = parseRequest(restoreStartRequestSchema, await readJsonBody(ctx.request));
  if (!parsed.ok) {
    rejectRequest(ctx, { action: "restore", containerId: null, containerName: null }, parsed.rejection);
    return;
  }
  await unavailableRoute(ctx, "restore", "restore", true, [parsed.value.expectedContainer.containerId]);
}
