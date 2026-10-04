import type { HostResources, HostResourcesView, ResourceUser } from "contract";

import { isSystemImage, isSystemProject } from "../../domain/containers/index.js";
import type { HostRouteAccessResult, HostRouteRequest, RouteWriting } from "../../domain/hosts/index.js";
import { AgentError, type AgentTarget, type RequestOptions } from "../../platform/agent-transport/protocol.js";
import type { RouteFailure } from "../../platform/http/route-failure.js";
import { fetchHostResources } from "./agent-client.js";

// The service of the feature `resources` (#10): the images, volumes and
// networks of one host, marked `system` where they belong to hub or agent.
// The mark uses the rule of the system containers, so a volume of the hub's
// database is marked like the database container itself.

export type ResourcesServiceDeps = {
  openHost: (request: HostRouteRequest, writing: RouteWriting) => Promise<HostRouteAccessResult>;
  fetchResources?: (target: AgentTarget, options: RequestOptions) => Promise<HostResources>;
};

export type ResourcesResult = { ok: true; resources: HostResourcesView } | { ok: false; failure: RouteFailure };

export type ResourcesService = {
  read: (request: HostRouteRequest) => Promise<ResourcesResult>;
};

function isSystemUser(user: ResourceUser): boolean {
  return isSystemImage(user.image) || (user.composeProject !== null && isSystemProject(user.composeProject));
}

function usedBySystem(usedBy: ResourceUser[] | null): boolean {
  return (usedBy ?? []).some(isSystemUser);
}

function ownedBySystem(composeProject: string | null): boolean {
  return composeProject !== null && isSystemProject(composeProject);
}

export function markSystemResources(resources: HostResources): HostResourcesView {
  const { images, volumes, networks } = resources;
  return {
    ...resources,
    images: images.ok
      ? {
          ok: true,
          items: images.items.map((image) => ({
            ...image,
            system: image.tags.some(isSystemImage) || usedBySystem(image.usedBy)
          }))
        }
      : images,
    volumes: volumes.ok
      ? {
          ok: true,
          items: volumes.items.map((volume) => ({
            ...volume,
            system: ownedBySystem(volume.composeProject) || usedBySystem(volume.usedBy)
          }))
        }
      : volumes,
    networks: networks.ok
      ? {
          ok: true,
          items: networks.items.map((network) => ({
            ...network,
            system: ownedBySystem(network.composeProject) || usedBySystem(network.usedBy)
          }))
        }
      : networks
  };
}

export function createResourcesService({ openHost, fetchResources = fetchHostResources }: ResourcesServiceDeps): ResourcesService {
  return {
    read: async (request) => {
      const opened = await openHost(request, "reads");
      if (!opened.ok) return opened;
      const { target, options, writable } = opened.access;
      // The route came with contract 10; an outdated arm does not know it and
      // would answer with a bare 404.
      if (!writable) {
        return {
          ok: false,
          failure: {
            kind: "problem",
            status: 409,
            error: "agent-outdated",
            message: "Der Agent dieses Arms ist zu alt für die Ressourcenübersicht. Sie braucht eine neuere Fassung."
          }
        };
      }
      try {
        return { ok: true, resources: markSystemResources(await fetchResources(target, options)) };
      } catch (error) {
        if (!(error instanceof AgentError)) throw error;
        return { ok: false, failure: { kind: "agent-error", error } };
      }
    }
  };
}
