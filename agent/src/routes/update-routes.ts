import { updatePreviewRequestSchema, updateStartRequestSchema } from "contract";
import { readJsonBody, parseRequest, rejectRequest, type RouteContext } from "../runtime/http.js";
import { unavailableRoute } from "./contract-route-stubs.js";

export async function handleUpdatePreview(ctx: RouteContext): Promise<void> {
  const parsed = parseRequest(updatePreviewRequestSchema, await readJsonBody(ctx.request));
  if (!parsed.ok) {
    rejectRequest(ctx, { action: "update-preview", containerId: null, containerName: null }, parsed.rejection);
    return;
  }
  await unavailableRoute(ctx, "update-preview", "update", false,
    parsed.value.services.map((service) => service.expectedContainer.containerId));
}

export async function handleUpdateStart(ctx: RouteContext): Promise<void> {
  const parsed = parseRequest(updateStartRequestSchema, await readJsonBody(ctx.request));
  if (!parsed.ok) {
    rejectRequest(ctx, { action: "update", containerId: null, containerName: null }, parsed.rejection);
    return;
  }
  await unavailableRoute(ctx, "update", "update", true,
    parsed.value.services.map((service) => service.expectedContainer.containerId));
}
