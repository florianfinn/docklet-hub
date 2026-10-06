import type { HostResources } from "contract";
import { readHostResources } from "../resources.js";
import { engine, audit } from "../runtime/state.js";
import { send, RouteContext } from "../runtime/http.js";

// --- Host resources (#10) ----------------------------------------------------
//
// Like `/host-containers`, the answer names every image, volume
// and network of the host, including containers outside the allowlist. It
// reads and changes nothing.
//
// Concurrent callers share one read: `/system/df` walks every volume on disk,
// and a second walk in parallel would only double that load.
let inFlight: Promise<HostResources> | null = null;

function sharedRead(): Promise<HostResources> {
  if (!inFlight) {
    inFlight = readHostResources((path) => engine.readResource(path)).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

function countOf(section: { ok: true; items: unknown[] } | { ok: false }): string {
  return section.ok ? String(section.items.length) : "-";
}

export async function handleResources(ctx: RouteContext): Promise<void> {
  const { response, actor } = ctx;
  const resources = await sharedRead();
  audit.write({
    action: "resources",
    containerId: null,
    containerName: null,
    actor,
    outcome: "allowed",
    reason: `images=${countOf(resources.images)} volumes=${countOf(resources.volumes)} networks=${countOf(resources.networks)}`
  });
  response.setHeader("cache-control", "no-store");
  send(response, 200, resources);
}
