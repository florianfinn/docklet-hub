// English texts of the feature `hosts` (#267). The reasons stand next to the
// German texts (`de.ts`); here is only the translation.
//
// ⚠️ `satisfies typeof deHosts` is on the literal because only an object
// literal is checked by TypeScript for EXCESS properties: without it this part
// could silently carry a key that does not exist in German.

import type { deHosts } from "./de";

export const enHosts = {
  hostKindLocal: "local",
  hostKindInternal: "internal",
  hostKindExternal: "external",
  hostKindUnknown: "Unknown kind: {kind}",
  // Die Host-Verwaltung (Phase 4a). Vier erhobene Zustände aus §3 der Doku:
  // `pending` (Datensatz `pending`, sein Agent existiert noch nicht), `online`
  // und `offline` (beide `registered`) sowie `outdated` — der letzte sperrt
  // schreibende Routen und bekommt deshalb eine eigene, deutlich andere Farbe
  // als `offline` (`web/src/domain/hosts/host-status.tsx`).
  hostsTitle: "Hosts",
  hostsRefresh: "Check again",
  hostsRefreshBusy: "Checking …",
  hostAgentVersionLabel: "Agent version",
  hostTunnelAddressLabel: "Tunnel address",
  hostKindFieldLabel: "Type",
  hostsManagedCount: "{count} managed",
  hostCreateAction: "Add host",
  hostCreateTitle: "Create host",
  hostCreateDescription:
    "A new host gets an archive with its credentials. It can only be downloaded once in this form — the dialog shows it right here.",
  hostNameLabel: "Name",
  hostKindOptionInternal: "internal",
  hostKindOptionExternal: "external",
  hostDockerGidLabel: "Docker group ID of the target host",
  hostDockerGidHint:
    "The group that owns the Docker socket on the target host. It goes into the package this host receives — without it, its agent will not start. Read it there with:",
  hostDockerGidCommand: "stat -c %g /var/run/docker.sock",
  hostDockerGidPlaceholder: "e.g. 996",
  hostDockerGidInvalid: "The group ID is a whole number from 0 up. On the target host, “stat -c %g /var/run/docker.sock” names it.",
  hostBindBasePathLabel: "Working directory of the target host",
  hostBindBasePathHint:
    "The agent may create and read bind mounts below this path. The CONFIG FILES column of this command shows where the target host keeps its compose projects:",
  hostBindBasePathCommand: "docker compose ls",
  hostEndpointOverrideLabel: "Hub address for this arm",
  hostEndpointOverrideHint:
    "Normally left empty. The arm builds the tunnel to this hub and needs its address as seen from outside — that address lives in the hub’s environment and applies to every arm alike. Fill this in only if this particular arm reaches the hub under a different address than the others, for instance from another network. Without a port, the hub’s port applies.",
  hostEndpointOverridePlaceholder: "empty = the hub’s address",
  hostEndpointTarget: "This arm will dial the hub here:",
  hostEndpointRequiredHint:
    "Required for this arm. The address the hub would otherwise hand over is a private one — nothing reaches it from another network, and its tunnel would never come up. Enter the name or IP under which this hub is reachable from outside. Without a port, the port of the hub applies.",
  hostEndpointRequired: "An external arm needs the address under which it reaches this hub from outside.",
  hostEndpointRememberHint:
    "Remember as the address of this hub. Every further external arm then gets it automatically, and changing it later means changing it in one place. Uncheck if it should apply to this one arm only.",
  hostCreateSubmit: "Create",
  hostErrorNameTaken: "The name is already taken.",
  hostErrorPoolExhausted: "The tunnel network is full — no room for another host.",
  hostErrorInvalidInput: "The input is not usable.",
  hostCreateFailed: "The host could not be created.",
  hostArchiveDownload: "Download archive",
  hostArchiveReload: "Reload archive",
  hostArchiveHint: "Every click rotates the key pair, agent secret, and token anew. A running agent with the old archive is locked out in the process.",
  hostArchiveReadyHint: "The archive is ready. It can only be downloaded in this form right now — clicking again generates a new one and invalidates the old one.",
  hostArchiveStepUnpackTitle: "Create the directory and unpack the archive",
  hostArchiveStepUnpack:
    "Create a directory on the target host and unpack the archive into it. The place must survive a reboot — it holds the private key and the agent secret, and there is no second copy.",
  hostArchiveStepPermissionsTitle: "Protect the secrets",
  hostArchiveStepPermissions:
    "Take away everyone else’s read access to .env and wg0.conf. Both carry secrets; whoever can read them can impersonate this host.",
  hostArchiveStepPermissionsCommand: "sudo chmod 600 .env wg0.conf",
  hostArchiveStepStartTitle: "Start the agent",
  hostArchiveStepStart:
    "Start the stack in that directory. The agent then enrols with this hub on its own — the card here shows it as online after a click on “Check again”. The README in the archive names the counter-checks in case it does not.",
  hostArchiveStepStartCommand: "sudo docker compose up -d",
  hostArchiveReloadTitle: "Reload the archive?",
  hostArchiveReloadConfirm:
    "This generates a new archive for “{name}” and invalidates the current one. The agent running there will no longer reach the hub — it needs the new package.",
  hostArchiveReloadDetail:
    "There is no undo: key pair, agent secret, and token are drawn anew, and the old archive is kept nowhere afterwards. If the arm is running and you only wanted a copy of the archive, cancel here.",
  hostArchiveReloadSubmit: "Download new archive",
  hostRemove: "Remove",
  hostRemoveTitle: "Remove host",
  hostRemoveConfirm: "Really remove this host? The agent on it keeps running, but afterward will no longer reach anyone.",
  hostRemoveFailed: "The host could not be removed.",
  hostRemoveLocalError: "The local host cannot be removed.",

  hostAgentUpdate: "Update agent to v{version}",
  hostAgentUpdateCurrent: "Agent up to date (v{version})",
  hostAgentUpdateTitle: "Update agent?",
  hostAgentUpdateConfirm: "The watcher on {name} pulls v{version}, verifies signature and version, and only then swaps the agent.",
  hostAgentUpdateDetail:
    "The host is unreachable for a few seconds during the swap. If the new agent does not start, the watcher rolls back to the running version.",
  hostAgentUpdateSubmit: "Update now",
  hostAgentUpdateRunning: "The watcher is swapping the agent …",

  hostAgentUpdateOk: "The agent now runs {version}.",
  hostAgentUpdateUnchanged: "Nothing swapped: the host already runs this image.",
  hostAgentUpdateAborted: "Aborted before anything was swapped: {reason}",
  hostAgentUpdateRolledBack: "The new agent did not start; the watcher rolled back: {reason}",
  hostAgentUpdateFailed: "The swap failed and needs a look: {reason}",
  hostAgentUpdateOutcomeUnknown: "The watcher reports “{outcome}”: {reason}",
  hostAgentUpdateNoReason: "no details",
  hostAgentUpdateTimeout: "No answer from the host after ten minutes. Is its watcher running?",

  hostAgentUpdateBusy: "An update is already running on this host.",
  hostAgentUpdateReadOnly: "This host is set to read-only and accepts no update.",
  hostAgentUpdateUnavailable: "No watcher update is pending for this host. Measure again.",
  hostAgentUpdateStartFailed: "The update could not be started.",
  hostAgentUpdateStartRejected: "The update could not be started (host: “{reason}”).",

  hostAgentUpdateManual:
    "v{version} is available. This agent does not accept a target yet — this step is manual once: set this line in the host''s .env, then run “sudo docker compose up -d”.",
  hostAgentUpdateManualLine: "DOCKER_AGENT_IMAGE={imageRef}",

  hostMigrationTitle: "This host needs the agent of this hub",
  hostMigrationBody:
    "This host''s agent is older than what this hub understands — it keeps running, but the shell, file changes and compose stay locked until it has been moved, and reading may fail on the old protocol. The step is done once, by hand, on the host.",
  hostMigrationStepImage: "Set this line in the host''s .env:",
  hostMigrationStepRestart: "Then restart the stack:",
  hostMigrationRestartCommand: "sudo docker compose up -d",

  timeAtAgo: "{at} ({ago})",
  hostLastSeenLabel: "Last reachable",
  hostLastSeenNever: "never",
  hostLastUpdateLabel: "Last agent update",
  hostLastUpdateNone: "none via the watcher yet",
  hostLastUpdateUnknownTime: "time unknown",
  hostsMeasuredAt: "Measured at {at}"
} satisfies typeof deHosts;
