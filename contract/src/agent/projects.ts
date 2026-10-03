import * as z from "zod/mini";

// Where a project's data lives (#128). `project` lies inside the project
// directory, `external` is a bind source elsewhere, `volume` an engine volume.
export const MOUNT_SOURCE_KINDS = ["project", "external", "volume"] as const;
export type MountSourceKind = (typeof MOUNT_SOURCE_KINDS)[number];

export const mountSourceSchema = z.object({
  service: z.string(),
  kind: z.enum(MOUNT_SOURCE_KINDS),
  // Normalized host path for binds, engine name for volumes, null if anonymous.
  source: z.nullable(z.string()),
  target: z.string(),
  readOnly: z.boolean(),
  // A volume declared `external` belongs to someone else and may be shared.
  shared: z.boolean()
});
export type MountSource = z.output<typeof mountSourceSchema>;
