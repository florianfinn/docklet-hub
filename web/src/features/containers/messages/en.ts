// English texts of the feature `containers` (#282). Closes with
// `satisfies typeof deContainers`: a key that is missing here or stands once
// too many fails the type check.

import type { deContainers } from "./de";

export const enContainers = {
  // Die Übersicht (D6): Stacks je Host, dazu die Container ohne Stack. Die
  // Begründung, warum hier dreizehn Schlüssel weniger stehen als bis D5,
  // steht in de.ts.
  overviewTitle: "Overview",
  overviewSearchPlaceholder: "Search containers",
  overviewFilterAll: "all",
  overviewFilterRunning: "running",
  overviewFilterUnhealthy: "unhealthy",
  overviewFilterStopped: "stopped",
  overviewNoMatches: "No container matches the search and filter.",
  overviewWithoutStack: "without stack",
  overviewHiddenStacks: "hidden · {count, plural, one {# stack} other {# stacks}}",
  stackMenuOpen: "Open stack",
  stackMenuHide: "Hide",
  stackMenuShow: "Show again",
  stackHideFailed: "Stack {project} could not be changed.",
  overviewExternallyManaged: "externally managed",
  externalManagedByUnraid:
    "Unraid creates these containers from its templates. The hub shows and controls them; Unraid handles updates and recreation.",
  externalManagedByOther: "{manager} manages these containers. The hub shows and controls them; {manager} handles updates and recreation.",
  stackOpen: "Open stack {project}",
  stackContainersCount: "Stack · {count, plural, one {# container} other {# containers}}",
  containerStateOk: "running",
  containerStateWarn: "unhealthy",
  containerStateDown: "down",
  containerStateUnknown: "Unknown state: {state}",
  containersEmptyTitle: "No containers in the allowlist",
  containersEmptyBody:
    "The agent only shows containers listed in its allowlist. A freshly set up agent has an empty allowlist — so this response is correct, not empty because something is missing.",
  containersTitle: "Containers",
  settingsContainerViewTitle: "Hub and agents",
  settingsContainerViewHint:
    "The hub with its database and, on every host, the agent, WireGuard and watcher are the same containers everywhere. They are therefore hidden in the overview and the container view; the “Hub & agents” tab always lists them.",
  settingsContainerViewShow: "Show in overview and container view",
  settingsContainerViewSaved: "saved",
  settingsContainerViewFailed: "The setting could not be saved.",
  containersOnlySystem:
    "{count, plural, one {# hub and agent container} other {# hub and agent containers}} hidden — show them under Settings › Containers.",
  systemContainersTitle: "Hub and agent containers",
  systemContainersHint:
    "Everything the control plane runs itself — on the hub and on every host. Logs, shell, files and marks work here just like in the container view."
} satisfies typeof deContainers;
