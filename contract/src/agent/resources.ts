import * as z from "zod/mini";

// The host resources the agent reads for the storage overview (#10): images,
// volumes and networks with their users, and the engine's disk usage. Every
// section is read on its own, so a failed engine call names its section and
// leaves the others readable.

/** Why one section could not be read. A newer agent may send other keys. */
export const RESOURCE_READ_FAILURES = [
  "engine-timeout",
  "engine-unreachable",
  "engine-refused",
  "unreadable"
] as const;
export type ResourceReadFailure = (typeof RESOURCE_READ_FAILURES)[number];

const readFailureSchema = z.object({ ok: z.literal(false), reason: z.string() });

/** A container that uses a resource. Only the facts the hub needs to sort it. */
export const resourceUserSchema = z.object({
  name: z.string(),
  running: z.boolean(),
  image: z.string(),
  composeProject: z.nullable(z.string())
});
export type ResourceUser = z.output<typeof resourceUserSchema>;

// `usedBy` is null when the container list could not be read: unknown usage
// must not look like "unused".
export const imageResourceSchema = z.object({
  id: z.string(),
  tags: z.array(z.string()),
  sizeBytes: z.nullable(z.number()),
  sharedSizeBytes: z.nullable(z.number()),
  createdAt: z.nullable(z.string()),
  usedBy: z.nullable(z.array(resourceUserSchema))
});
export type ImageResource = z.output<typeof imageResourceSchema>;

export const volumeResourceSchema = z.object({
  name: z.string(),
  driver: z.string(),
  scope: z.string(),
  anonymous: z.boolean(),
  composeProject: z.nullable(z.string()),
  sizeBytes: z.nullable(z.number()),
  usedBy: z.nullable(z.array(resourceUserSchema))
});
export type VolumeResource = z.output<typeof volumeResourceSchema>;

export const networkResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  driver: z.string(),
  scope: z.string(),
  // Docker's `Internal`: no route out of the network.
  internalOnly: z.boolean(),
  // Docker's own networks `bridge`, `host` and `none`.
  predefined: z.boolean(),
  composeProject: z.nullable(z.string()),
  usedBy: z.nullable(z.array(resourceUserSchema))
});
export type NetworkResource = z.output<typeof networkResourceSchema>;

/** One line of the engine's disk usage. Sizes are null where the engine gave none. */
export const storageUsageSchema = z.object({
  count: z.number(),
  sizeBytes: z.nullable(z.number()),
  unusedBytes: z.nullable(z.number())
});
export type StorageUsage = z.output<typeof storageUsageSchema>;

export const storageSummarySchema = z.object({
  images: storageUsageSchema,
  containers: storageUsageSchema,
  volumes: storageUsageSchema,
  buildCache: storageUsageSchema
});
export type StorageSummary = z.output<typeof storageSummarySchema>;

function sectionSchema<Item extends z.core.$ZodType>(item: Item) {
  return z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), items: z.array(item) }), readFailureSchema]);
}

export const hostResourcesSchema = z.object({
  readAt: z.string(),
  storage: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), summary: storageSummarySchema }), readFailureSchema]),
  usage: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true) }), readFailureSchema]),
  images: sectionSchema(imageResourceSchema),
  volumes: sectionSchema(volumeResourceSchema),
  networks: sectionSchema(networkResourceSchema)
});
export type HostResources = z.output<typeof hostResourcesSchema>;
