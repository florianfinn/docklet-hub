// Where the data of a project lives, read from the normalized output of
// `docker compose config` (#128). Relative bind sources are already resolved
// there, so the listed path is the one Docker will mount.

import type { MountSource } from "contract";
import { isInsideBase } from "./compose.js";
import { normalizePath } from "./hardening.js";

type ConfigVolume = {
  type?: unknown;
  source?: unknown;
  target?: unknown;
  read_only?: unknown;
};

type ConfigVolumeDefinition = { name?: unknown; external?: unknown };

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function mountSourcesOf(config: unknown, services: readonly string[], projectDir: string): MountSource[] {
  const root = (config ?? {}) as {
    services?: Record<string, { volumes?: unknown }>;
    volumes?: Record<string, ConfigVolumeDefinition | null>;
  };
  const definitions = root.volumes ?? {};
  const sources: MountSource[] = [];
  for (const service of services) {
    const volumes = root.services?.[service]?.volumes;
    if (!Array.isArray(volumes)) continue;
    for (const raw of volumes as ConfigVolume[]) {
      const target = text(raw?.target);
      if (!target) continue;
      const readOnly = raw.read_only === true;
      const source = text(raw.source);
      if (raw.type === "bind" && source) {
        const hostPath = normalizePath(source);
        const inProject = hostPath === normalizePath(projectDir) || isInsideBase(hostPath, projectDir);
        sources.push({ service, kind: inProject ? "project" : "external", source: hostPath, target, readOnly, shared: false });
      } else if (raw.type === "volume") {
        const definition = source ? definitions[source] : undefined;
        const external = definition?.external === true;
        sources.push({
          service,
          kind: "volume",
          // Anonymous volumes have no source; named ones carry the engine name.
          source: source ? (text(definition?.name) ?? source) : null,
          target,
          readOnly,
          shared: external
        });
      }
    }
  }
  return sources;
}

// The distinct external bind sources that need their own confirmation.
export function externalSourcesOf(sources: readonly MountSource[]): string[] {
  return [
    ...new Set(sources.filter((entry) => entry.kind === "external" && entry.source).map((entry) => entry.source as string))
  ].sort();
}
