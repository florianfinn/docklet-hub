// `zod/mini` and not `zod`: see `contract/README.md`.
import * as z from "zod/mini";

import {
  imageResourceSchema,
  networkResourceSchema,
  storageSummarySchema,
  volumeResourceSchema
} from "../agent/resources.js";

// The response of `GET /api/hosts/:hostId/resources` (#10): what the agent read,
// plus `system` per item. The hub sets it with the same rule that marks the
// containers of hub and agents, so the browser keeps no second copy of it.

const readFailureSchema = z.object({ ok: z.literal(false), reason: z.string() });

const systemFlag = { system: z.boolean() };

export const imageResourceViewSchema = z.extend(imageResourceSchema, systemFlag);
export type ImageResourceView = z.infer<typeof imageResourceViewSchema>;

export const volumeResourceViewSchema = z.extend(volumeResourceSchema, systemFlag);
export type VolumeResourceView = z.infer<typeof volumeResourceViewSchema>;

export const networkResourceViewSchema = z.extend(networkResourceSchema, systemFlag);
export type NetworkResourceView = z.infer<typeof networkResourceViewSchema>;

function sectionSchema<Item extends z.core.$ZodType>(item: Item) {
  return z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), items: z.array(item) }), readFailureSchema]);
}

export const hostResourcesViewSchema = z.object({
  readAt: z.string(),
  storage: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), summary: storageSummarySchema }), readFailureSchema]),
  usage: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true) }), readFailureSchema]),
  images: sectionSchema(imageResourceViewSchema),
  volumes: sectionSchema(volumeResourceViewSchema),
  networks: sectionSchema(networkResourceViewSchema)
});
export type HostResourcesView = z.infer<typeof hostResourcesViewSchema>;

export const hostResourcesResponseSchema = z.object({ resources: hostResourcesViewSchema });
export type HostResourcesResponse = z.infer<typeof hostResourcesResponseSchema>;
