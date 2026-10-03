import type { HostView } from "contract";

// The shapes of a host as every host route hands it out. They come from the
// contract (`contract/src/api/hosts.ts`); this file lets `domain/hosts` pass
// them on through its door. Until #271 they came through `web/src/api/client.ts`.
export type { HostLoad } from "contract";

// One host as every host route hands it out. Since #247 this is no longer a
// hand-written copy of the server type but the schema in the contract, and
// `fetchHosts` parses the list against it. The meaning of each field —
// `state` beside `status`, `display` as the stored colour, `null` in
// `agentUpdate` and `lastSeenAt` — stands next to the schema.
export type DockerHost = HostView;
