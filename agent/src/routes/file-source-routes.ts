import { fileSourcesResponseSchema } from "contract";
import { fileSources } from "../runtime/file-sources.js";
import { audit } from "../runtime/state.js";
import { send, type ContainerRouteContext } from "../runtime/http.js";
export async function handleFileSources(ctx: ContainerRouteContext): Promise<void> {
  const result = await fileSources(ctx.containerId, ctx.actor);
  if (!result.ok) { send(ctx.response, result.status, { error: result.reason }); return; }
  audit.write({ action: "file-sources", containerId: ctx.containerId, containerName: null,
    actor: ctx.actor, outcome: "allowed", reason: "sources-resolved" });
  send(ctx.response, 200, fileSourcesResponseSchema.parse({ sources: result.resolved.map((item) => item.source)
    .filter((source) => source.protection !== "backup") }));
}
