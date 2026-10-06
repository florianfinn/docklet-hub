// The derived configuration summary (S5b, §16.3).
//
// The YAML is not shown here. The question "is the server running, and how is
// it wired?" is answered with information that by construction CANNOT contain
// anything dangerous, instead of with a filtered full text.
//
// ⚠️ The most important exclusion is the HOST PATHS. They are a map of the
// server, which is why the hardening details have their own route.
//
// That is why this module is an ALLOWLIST and not a filter: it builds a new
// object from six named fields. What is not explicitly copied here cannot
// slip through — unlike a `delete raw.HostConfig`, which would silently start
// leaking with the next new engine field.
//
// Not included, each with its reason:
//   host paths of the binds    map of the server (see above)
//   env keys and values        the name alone is information (§16.2)
//   labels                     carry Traefik rules, occasionally credentials
//   command/entrypoint         reveal internal call paths
//   cap_add/devices/privileged naming attack surface means offering it
//   host ports of the bindings say which port is open on the host

import type { RawInspect } from "./engine.js";

export type DerivedConfig = {
  // Without digest: `nginx:1.27`, not `nginx:1.27@sha256:…`. The digest is an
  // internal version detail and belongs in the update view, not here.
  image: string;
  // ⚠️ Exclusively the CONTAINER side (`8080/tcp`). The host side of a port
  // binding says which port is open on the machine — that is the same class
  // of information as a host path.
  ports: string[];
  // `unless-stopped`, `always`, `on-failure`, `no`.
  restart: string;
  health: { defined: boolean; status: string | null };
  // Only the TARGETS in the container (`/data`), never the sources on the host.
  mountDestinations: string[];
  networks: string[];
};

// `nginx:1.27@sha256:abc…` -> `nginx:1.27`. A pure digest ref without a tag
// (`nginx@sha256:…`) stays as `nginx` — that is the more honest statement than
// an invented `:latest`.
export function withoutDigest(imageRef: string): string {
  const separator = imageRef.indexOf("@");
  return separator >= 0 ? imageRef.slice(0, separator) : imageRef;
}

export function derivedConfig(raw: RawInspect): DerivedConfig {
  // Two sources for the container side: `NetworkSettings.Ports` is only there
  // for a running container, `Config.ExposedPorts` also for a stopped one. The
  // union answers the question in both states.
  const ports = new Set<string>();
  for (const port of Object.keys(raw.Config?.ExposedPorts ?? {})) ports.add(port);
  for (const port of Object.keys(raw.NetworkSettings?.Ports ?? {})) ports.add(port);

  const mountTargets = (raw.Mounts ?? [])
    .map((mount) => mount.Destination ?? "")
    .filter((target) => target.length > 0);

  return {
    image: withoutDigest(raw.Config?.Image ?? raw.Image ?? ""),
    ports: [...ports].sort(),
    restart: raw.HostConfig?.RestartPolicy?.Name || "no",
    health: {
      defined: (raw.Config?.Healthcheck?.Test?.length ?? 0) > 0,
      status: raw.State?.Health?.Status ?? null
    },
    mountDestinations: [...new Set(mountTargets)].sort(),
    networks: Object.keys(raw.NetworkSettings?.Networks ?? {}).sort()
  };
}
