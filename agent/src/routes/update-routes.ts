import { updateStartRequestSchema } from "contract";
import { audit, registry } from "../runtime/state.js";
import { stackProjectFromRegistry, StackEndpointError } from "../runtime/stack.js";
import { readJsonBody, parseRequest, rejectRequest, send, type ContainerRouteContext, type RouteContext } from "../runtime/http.js";
import { unavailableRoute } from "./contract-route-stubs.js";

export async function handleUpdatePreview(ctx: ContainerRouteContext): Promise<void> {
  await unavailableRoute(ctx, "update-preview", "update", false, [ctx.containerId]);
}

export async function handleProjectUpdatePreview(ctx: RouteContext, match: RegExpMatchArray): Promise<void> {
  // Like stack context, the path names a registry anchor, never a host directory.
  try {
    const project = stackProjectFromRegistry(decodeURIComponent(match[1]));
    const entries = registry.entriesForCompose(project.projectDir, project.projectName, project.composeFileName);
    const ids = [...new Set([project.anchorEntry.containerId, ...entries.map((entry) => entry.containerId)])];
    await unavailableRoute(ctx, "update-preview", "update", false, ids);
  } catch (error) {
    if (!(error instanceof StackEndpointError)) throw error;
    audit.write({ action: "update-preview", containerId: decodeURIComponent(match[1]), containerName: null,
      actor: ctx.actor, outcome: "denied", reason: error.code });
    send(ctx.response, error.status, { error: error.code });
  }
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
