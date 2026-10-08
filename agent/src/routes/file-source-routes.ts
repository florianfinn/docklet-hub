import { type ContainerRouteContext } from "../runtime/http.js";
import { unavailableRoute } from "./contract-route-stubs.js";

export async function handleFileSources(ctx: ContainerRouteContext): Promise<void> {
  await unavailableRoute(ctx, "file-sources", "file-sources", false, [ctx.containerId]);
}
