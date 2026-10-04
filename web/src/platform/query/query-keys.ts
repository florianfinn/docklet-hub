// Every query key of the web, in one file (#256).
//
// THE CONVENTION
//
// 1. A key is an array whose first element names the area, in English:
//    `["hosts"]`, `["settings"]`. The area is the hub resource the key reads,
//    not the screen that shows it; two screens showing the same resource share
//    its key and with it one request and one cache entry.
// 2. Everything that narrows comes after it, from broad to narrow:
//    `["hosts", "list"]`, `["hosts", hostId, "containers"]`. Invalidating a
//    prefix (`["hosts"]`) then reaches every narrower key below it, and that is
//    the reason for the order: one call refreshes a whole area.
// 3. Keys are only built here, through the functions below, never written as a
//    literal at a call site. A literal that differs by one letter is a second
//    cache entry that no invalidation reaches, and no check notices it.
//
// ⚠️ This file lives in `platform/` although it names areas of the hub. It
// holds names and no behaviour: it imports nothing from `domain/` or a feature
// and knows nothing about what a host is. One file for all keys is the point —
// keys spread over the features they belong to could not be checked against
// each other for a collision.
//
// Which write invalidates which key:
//
// - a new, removed or recoloured host writes into `hosts.list()` directly
//   (`domain/hosts`), because the hub answers with the changed host;
// - "measure again" on the hosts screen invalidates `hosts.all`, the list,
//   every arm's containers and every arm's agent update together;
// - an upload, a new folder, a rename, a delete or a saved text invalidates
//   `files.listings(…)`, every directory of that container, and leaves its
//   share alone (`features/files/file-queries.ts`);
// - choosing or releasing a share resets `files.container(…)`, the share, the
//   candidates and every directory together: after it, everything about that
//   container is open again.
//
// - the compose file, the `.env` and the dry run of a draft (`compose`) are
//   never invalidated: every read writes an entry into the audit log of the
//   arm, so they are asked once per opening, and the two ways to ask again
//   are an explicit reset ("reload") or a removal (after an apply, when the
//   container ids of the cached answer are gone), both in
//   `features/compose/compose-queries.ts`;
//
// - a created, changed or removed own mark is written into `marks.list()`
//   directly (`features/marks/mark-queries.ts`), because the hub answers with
//   the stored mark;
//
// - a stack hidden, a container's marks changed or a stack's marks changed on
//   the overview are written into `containers.overview()` directly
//   (`features/containers/overview-queries.ts`), because the hub answers with
//   the stored state; the switch "show hub and agents" is written into
//   `settings.containerView()` the same way, and every mount of the overview
//   asks the arms again;
//
// - the stats of a container (`metrics`) are never invalidated: the surface
//   polls them on the agent's clock (`features/metrics/metrics-queries.ts`);
//
// Areas still loading in a `useEffect` (stacks, the rest of the settings) get
// their key here when they move to a query.

export const queryKeys = {
  hosts: {
    /** Prefix of every key about hosts; invalidating it refreshes all of them. */
    all: ["hosts"] as const,
    /** `GET /api/hosts`. */
    list: () => ["hosts", "list"] as const,
    /** `GET /api/hosts/:id/containers`; contacts the arm under the caller. */
    containers: (hostId: string) => ["hosts", hostId, "containers"] as const,
    /** `GET /api/hosts/:id/agent-update`, the state of the watcher on one arm (#267). */
    agentUpdate: (hostId: string) => ["hosts", hostId, "agent-update"] as const
  },
  marks: {
    /** Prefix of every key about the own marks of the hub (#268). */
    all: ["marks"] as const,
    /** `GET /api/marks`, the stock the pick lists and the panel read. */
    list: () => ["marks", "list"] as const
  },
  containers: {
    /** `GET /api/overview`, every arm with its stacks; contacts the arms under the caller (#282). */
    overview: () => ["containers", "overview"] as const
  },
  metrics: {
    /** `GET …/containers/:id/stats`, the measurements of one container with their history; polled every ten seconds (#283). */
    containerStats: (hostId: string, containerId: string) => ["metrics", hostId, containerId, "stats"] as const
  },
  resources: {
    /** `GET …/hosts/:id/resources`, images, volumes and networks of one host; read once per visit (#10). */
    host: (hostId: string) => ["resources", hostId] as const
  },
  settings: {
    /** The `containers` part of `GET /api/settings`: whether hub and agents show in the lists (#282). */
    containerView: () => ["settings", "container-view"] as const,
    /** The `logs` part of `GET /api/settings`: how many lines a log view opens with (#271). */
    logs: () => ["settings", "logs"] as const,
    /** The `network` part of `GET /api/settings`: the address arms are given (#271). */
    hubNetwork: () => ["settings", "hub-network"] as const
  },
  account: {
    /** `GET /api/users`, the list of accounts; asked for an administrator only (#269). */
    users: () => ["account", "users"] as const
  },
  files: {
    /** Prefix of every key about the files of one container. */
    container: (hostId: string, containerId: string) => ["files", hostId, containerId] as const,
    /** `GET …/share`; `null` is the answer "nobody has chosen". */
    share: (hostId: string, containerId: string) => ["files", hostId, containerId, "share"] as const,
    /** `GET …/share-candidates`; names the bind mounts, so it is asked only without a share. */
    candidates: (hostId: string, containerId: string) => ["files", hostId, containerId, "candidates"] as const,
    /** Prefix of every directory of one container. */
    listings: (hostId: string, containerId: string) => ["files", hostId, containerId, "listing"] as const,
    /** `GET …/files?path=…`; `""` is the root of the share. */
    listing: (hostId: string, containerId: string, path: string) =>
      ["files", hostId, containerId, "listing", path] as const,
    /**
     * `GET …/file-text?path=…` for the editor, once per open (`round` counts
     * "reload and discard"). Outside the prefix `container` on purpose: choosing
     * a share resets that prefix, and the text under an open draft must not be
     * asked again behind its back (#271).
     */
    text: (hostId: string, containerId: string, path: string, round: number) =>
      ["file-text", hostId, containerId, path, round] as const
  },
  compose: {
    /** Prefix of the compose file of every stack of one arm. */
    files: (hostId: string) => ["compose", hostId, "file"] as const,
    /**
     * `GET …/compose` asked through the containers of one stack, in order;
     * `containerIds` is the list joined with `,`, as the answer depends on
     * which containers were candidates.
     */
    file: (hostId: string, containerIds: string) => ["compose", hostId, "file", containerIds] as const,
    /** `GET …/compose/candidates` of one container, the selection by hand (#185). */
    candidates: (hostId: string, containerId: string) => ["compose", hostId, containerId, "candidates"] as const,
    /** `GET …/compose/env`, masked; the plaintext is not a query. */
    env: (hostId: string, containerId: string) => ["compose", hostId, containerId, "env"] as const,
    /** `POST …/compose/preview`; the draft is part of the question. */
    preview: (hostId: string, containerId: string, draft: string) =>
      ["compose", hostId, containerId, "preview", draft] as const
  }
} as const;
