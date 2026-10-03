// The door of `domain/hosts` in the web (#256): what more than one screen
// needs to know about the arms. From outside, only this file is imported.
//
// Since #267 the door also carries what the arms look like on every surface:
// the colour of a host (`hostDisplay`), its status mark, the counters of its
// card, the grid the overview, the container list and the hosts screen share,
// and the types of a host as the hub hands it out (a feature imports no other
// feature, so the types come through here).

export { useHosts, useHostListUpdate } from "./use-hosts";
export { hostDisplay } from "./host-palette";
export { HostStatusBadge, HostStatusDot } from "./host-status";
export { EMPTY_SUMMARY, summarize, total } from "./host-summary";
export type { HostCounters, HostSummary } from "./host-summary";
export { HOST_GRID_CLASS, HOST_SCREEN_CLASS } from "./host-grid";
export type { DockerHost, HostLoad } from "./host-types";
export { fetchHosts, fetchHubNetwork, setHubExternalEndpoint } from "./api";
export type { HubNetworkView } from "./api";
export { useHubNetwork } from "./use-hub-network";
