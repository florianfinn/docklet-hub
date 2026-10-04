import type {
  HostResources,
  ImageResource,
  NetworkResource,
  ResourceReadFailure,
  ResourceUser,
  StorageSummary,
  StorageUsage,
  VolumeResource
} from "contract";
import { EngineError } from "./engine-errors.js";

// The host resources for the storage overview (#10). Read only: every engine
// call here is a GET on a fixed path, and nothing in this file can name
// another one.
//
// Each section stands on its own engine call, so one failed call is reported
// in its section and the others stay readable. Usage comes from the container
// list; when that fails, `usedBy` is null instead of an empty list.

export const RESOURCE_PATHS = [
  "/system/df",
  "/images/json",
  "/volumes",
  "/networks",
  "/containers/json?all=1"
] as const;
export type ResourcePath = (typeof RESOURCE_PATHS)[number];

export type ResourceReader = (path: ResourcePath) => Promise<unknown>;

type Labels = Record<string, string> | null | undefined;

type RawResourceContainer = {
  Id?: string;
  Names?: string[];
  Image?: string;
  ImageID?: string;
  State?: string;
  Labels?: Labels;
  SizeRw?: number;
  Mounts?: Array<{ Type?: string; Name?: string }> | null;
  NetworkSettings?: { Networks?: Record<string, { NetworkID?: string } | null> | null } | null;
};

type RawImage = {
  Id?: string;
  RepoTags?: string[] | null;
  Size?: number;
  SharedSize?: number;
  Created?: number;
  Containers?: number;
};

type RawResourceVolume = {
  Name?: string;
  Driver?: string;
  Scope?: string;
  Labels?: Labels;
  UsageData?: { Size?: number; RefCount?: number } | null;
};

type RawNetwork = {
  Id?: string;
  Name?: string;
  Driver?: string;
  Scope?: string;
  Internal?: boolean;
  Labels?: Labels;
};

type RawSystemDf = {
  LayersSize?: number;
  Images?: RawImage[] | null;
  Containers?: RawResourceContainer[] | null;
  Volumes?: RawResourceVolume[] | null;
  BuildCache?: Array<{ Size?: number; InUse?: boolean; Shared?: boolean }> | null;
};

const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const ANONYMOUS_VOLUME_LABEL = "com.docker.volume.anonymous";
// Docker refuses to create user networks with these names.
const PREDEFINED_NETWORKS = new Set(["bridge", "host", "none"]);
const ANONYMOUS_VOLUME_NAME = /^[0-9a-f]{64}$/;

class UnreadableAnswerError extends Error {}

export function resourceReadFailure(error: unknown): ResourceReadFailure {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === "ETIMEDOUT") return "engine-timeout";
  if (error instanceof EngineError) return "engine-refused";
  if (typeof code === "string") return "engine-unreachable";
  return "unreadable";
}

function arrayOf<T>(value: unknown): T[] {
  if (!Array.isArray(value)) throw new UnreadableAnswerError("engine answer is not a list");
  return value as T[];
}

function size(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function sum(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
}

function composeProjectOf(labels: Labels): string | null {
  const project = labels?.[COMPOSE_PROJECT_LABEL];
  return typeof project === "string" && project !== "" ? project : null;
}

function userOf(container: RawResourceContainer): ResourceUser {
  return {
    name: (container.Names?.[0] ?? container.Id ?? "").replace(/^\//, ""),
    running: container.State === "running",
    image: container.Image ?? "",
    composeProject: composeProjectOf(container.Labels)
  };
}

type Usage = {
  images: Map<string, ResourceUser[]>;
  volumes: Map<string, ResourceUser[]>;
  // Keyed by network id and, for endpoints without one, by `name:<name>`.
  networks: Map<string, ResourceUser[]>;
};

function push(map: Map<string, ResourceUser[]>, key: string, user: ResourceUser): void {
  const users = map.get(key);
  if (users) users.push(user);
  else map.set(key, [user]);
}

function usageOf(containers: RawResourceContainer[]): Usage {
  const usage: Usage = { images: new Map(), volumes: new Map(), networks: new Map() };
  for (const container of containers) {
    const user = userOf(container);
    if (container.ImageID) push(usage.images, container.ImageID, user);
    for (const mount of container.Mounts ?? []) {
      if (mount.Type === "volume" && mount.Name) push(usage.volumes, mount.Name, user);
    }
    for (const [name, endpoint] of Object.entries(container.NetworkSettings?.Networks ?? {})) {
      push(usage.networks, endpoint?.NetworkID || `name:${name}`, user);
    }
  }
  return usage;
}

function byName<T extends { name: string }>(left: T, right: T): number {
  return left.name.localeCompare(right.name);
}

function imagesOf(raw: RawImage[], df: RawSystemDf | null, usage: Usage | null): ImageResource[] {
  const shared = new Map((df?.Images ?? []).map((image) => [image.Id ?? "", size(image.SharedSize)]));
  return raw
    .map((image) => {
      const id = image.Id ?? "";
      return {
        id,
        tags: (image.RepoTags ?? []).filter((tag) => tag !== "<none>:<none>"),
        sizeBytes: size(image.Size) ?? 0,
        sharedSizeBytes: shared.get(id) ?? null,
        createdAt: typeof image.Created === "number" ? new Date(image.Created * 1000).toISOString() : null,
        usedBy: usage ? (usage.images.get(id) ?? []) : null
      };
    })
    .sort((left, right) => (left.tags[0] ?? left.id).localeCompare(right.tags[0] ?? right.id));
}

function volumesOf(raw: RawResourceVolume[], df: RawSystemDf | null, usage: Usage | null): VolumeResource[] {
  const sizes = new Map((df?.Volumes ?? []).map((volume) => [volume.Name ?? "", size(volume.UsageData?.Size)]));
  return raw
    .map((volume) => {
      const name = volume.Name ?? "";
      return {
        name,
        driver: volume.Driver ?? "",
        scope: volume.Scope ?? "",
        anonymous: volume.Labels?.[ANONYMOUS_VOLUME_LABEL] !== undefined || ANONYMOUS_VOLUME_NAME.test(name),
        composeProject: composeProjectOf(volume.Labels),
        sizeBytes: sizes.get(name) ?? null,
        usedBy: usage ? (usage.volumes.get(name) ?? []) : null
      };
    })
    .sort(byName);
}

function networksOf(raw: RawNetwork[], usage: Usage | null): NetworkResource[] {
  return raw
    .map((network) => {
      const id = network.Id ?? "";
      const name = network.Name ?? "";
      const { Internal: isolated } = network;
      let usedBy: ResourceUser[] | null = null;
      if (usage) {
        const seen = new Set<string>();
        usedBy = [...(usage.networks.get(id) ?? []), ...(usage.networks.get(`name:${name}`) ?? [])].filter((user) => {
          if (seen.has(user.name)) return false;
          seen.add(user.name);
          return true;
        });
      }
      return {
        id,
        name,
        driver: network.Driver ?? "",
        scope: network.Scope ?? "",
        internalOnly: isolated === true,
        predefined: PREDEFINED_NETWORKS.has(name),
        composeProject: composeProjectOf(network.Labels),
        usedBy
      };
    })
    .sort(byName);
}

// The same arithmetic as `docker system df`: unused image bytes are the layer
// total minus the unique bytes of images a container uses.
export function storageSummaryOf(df: RawSystemDf): StorageSummary {
  const images = df.Images ?? [];
  const layers = size(df.LayersSize);
  const usedImageBytes = images
    .filter((image) => (image.Containers ?? 0) > 0)
    .reduce((total, image) => {
      const imageSize = size(image.Size);
      const sharedSize = size(image.SharedSize);
      return imageSize === null || sharedSize === null ? total : total + imageSize - sharedSize;
    }, 0);
  const containers = df.Containers ?? [];
  const volumes = df.Volumes ?? [];
  const cache = df.BuildCache ?? [];
  const usage = (count: number, sizeBytes: number | null, unusedBytes: number | null): StorageUsage => ({
    count,
    sizeBytes,
    unusedBytes
  });
  return {
    images: usage(images.length, layers, layers === null ? null : Math.max(0, layers - usedImageBytes)),
    containers: usage(
      containers.length,
      sum(containers.map((container) => size(container.SizeRw))),
      sum(containers.filter((container) => container.State !== "running").map((container) => size(container.SizeRw)))
    ),
    volumes: usage(
      volumes.length,
      sum(volumes.map((volume) => size(volume.UsageData?.Size))),
      sum(volumes.filter((volume) => volume.UsageData?.RefCount === 0).map((volume) => size(volume.UsageData?.Size)))
    ),
    buildCache: usage(
      cache.length,
      sum(cache.map((entry) => size(entry.Size))),
      sum(cache.filter((entry) => !entry.InUse && !entry.Shared).map((entry) => size(entry.Size)))
    )
  };
}

type Settled<T> = { ok: true; value: T } | { ok: false; reason: ResourceReadFailure };

async function settle<T>(read: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, reason: resourceReadFailure(error) };
  }
}

function section<Raw, Item>(raw: Settled<Raw>, build: (value: Raw) => Item[]) {
  if (!raw.ok) return { ok: false as const, reason: raw.reason };
  try {
    return { ok: true as const, items: build(raw.value) };
  } catch (error) {
    return { ok: false as const, reason: resourceReadFailure(error) };
  }
}

export async function readHostResources(read: ResourceReader, now: () => Date = () => new Date()): Promise<HostResources> {
  const [df, images, volumes, networks, containers] = await Promise.all([
    settle(async () => (await read("/system/df")) as RawSystemDf),
    settle(async () => arrayOf<RawImage>(await read("/images/json"))),
    settle(async () => arrayOf<RawResourceVolume>(((await read("/volumes")) as { Volumes?: unknown } | null)?.Volumes ?? [])),
    settle(async () => arrayOf<RawNetwork>(await read("/networks"))),
    settle(async () => arrayOf<RawResourceContainer>(await read("/containers/json?all=1")))
  ]);
  const usage = containers.ok ? usageOf(containers.value) : null;
  const dfValue = df.ok && df.value !== null && typeof df.value === "object" ? df.value : null;
  return {
    readAt: now().toISOString(),
    storage: dfValue
      ? { ok: true, summary: storageSummaryOf(dfValue) }
      : { ok: false, reason: df.ok ? "unreadable" : df.reason },
    usage: containers.ok ? { ok: true } : { ok: false, reason: containers.reason },
    images: section(images, (raw) => imagesOf(raw, dfValue, usage)),
    volumes: section(volumes, (raw) => volumesOf(raw, dfValue, usage)),
    networks: section(networks, (raw) => networksOf(raw, usage))
  };
}
