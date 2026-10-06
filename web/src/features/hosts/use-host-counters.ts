import { useQueries, useQueryClient } from "@tanstack/react-query";

import { retainHostContainers, summarize, type DockerHost, type HostCounters } from "../../domain/hosts";
import { fetchHostContainers } from "./api";
import { queryKeys } from "../../platform/query/query-keys";

// The container counters of each card, one query per arm (#256).
//
// One query per arm and not one for the whole screen: a silent arm keeps only
// its own card waiting, and the others show their numbers as soon as their
// agent has answered.

// Which states are worth asking the agent about.
//
// ⚠️ `pending` and `offline` ARE NOT ASKED AT ALL. That is not saving
// requests but the right answer: with `pending` the agent does not exist yet
// (the record waits for its registration), with `offline` it does not answer.
// A request there would run into a timeout and leave the card "loading" long
// after it is clear that no number will come.
//
// `outdated` is asked: the hub blocks WRITING routes there, not reading ones
// (§3) — the agent still counts its containers.
const COUNTABLE: DockerHost["status"][] = ["online", "outdated"];

export type HostCountersResult = {
  counters: Record<string, HostCounters>;
  /** When the newest of these answers arrived, in ms; `0` before the first. */
  updatedAt: number;
};

export function useHostCounters(hosts: DockerHost[]): HostCountersResult {
  const client = useQueryClient();
  return useQueries({
    queries: hosts.map((host) => ({
      queryKey: queryKeys.hosts.containers(host.id),
      queryFn: async () => retainHostContainers(await fetchHostContainers(host.id), client.getQueryData(queryKeys.hosts.containers(host.id))),
      enabled: COUNTABLE.includes(host.status)
    })),
    combine: (results) => {
      const counters: Record<string, HostCounters> = {};
      let updatedAt = 0;
      hosts.forEach((host, index) => {
        const result = results[index];
        updatedAt = Math.max(updatedAt, result.dataUpdatedAt);
        if (!COUNTABLE.includes(host.status) && result.data === undefined) {
          counters[host.id] = { state: "unavailable" };
        } else if (result.data !== undefined) {
          counters[host.id] =
            result.data.containers === null
              ? { state: "unavailable" }
              : { state: "ready", summary: summarize(result.data.containers), load: result.data.load };
        } else if (result.isError) {
          // A failure here is not a failure of the screen: the card stays with
          // name, kind and state, only without numbers. Whoever wants to see
          // the list of hosts must not lose it because one arm is silent.
          counters[host.id] = { state: "unavailable" };
        } else {
          counters[host.id] = { state: "loading" };
        }
      });
      return { counters, updatedAt };
    }
  });
}
