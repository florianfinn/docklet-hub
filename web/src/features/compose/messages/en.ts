// English texts of the feature `compose` (#265). The reasons stand next to the
// German texts (`de.ts`); here is only the translation.
//
// ⚠️ `satisfies typeof deCompose` is on the literal because only an object
// literal is checked by TypeScript for EXCESS properties: without it this part
// could silently carry a key that does not exist in German.

import type { deCompose } from "./de";

export const enCompose = {
  // ── The compose tab of a stack (#35) ──────────────────────────────────────
  stackTabCompose: "Compose",

  composeNoContainer:
    "This stack currently has no container. The agent reads the compose file from the labels of a running container — without one, the hub cannot locate it.",
  composeServiceCount: "{count, plural, one {# service} other {# services}}",
  composeServiceCountDiffers: "{running} with a container · {inFile} in the file",
  composeUnreadable:
    "The agent found the stack but could not read its compose file. The content below would be empty — and an empty file is not the same as one nobody could read.",

  composeErrorHostUnknown: "The hub does not know this arm.",
  composeErrorUnreachable: "The arm did not answer. The file lives on it, not here.",
  composeErrorContainerUnknown: "The arm no longer runs this container.",
  composeErrorNotAllowlisted:
    "The arm refused: not every container of this stack is on its allowlist. The sync runs in the background — after the next tick this may look different.",
  composeErrorAgentTooOld: "This arm is too old for this surface.",
  composeErrorTooLarge: "The compose file exceeds the limit set by the agent.",
  composeErrorReadOnly: "This arm is set to read only. It applies nothing while the kill switch is down.",
  composeErrorTooManyStreams:
    "The arm is already running the maximum number of concurrent streams. Closing a log tab or finishing an apply frees a slot.",
  composeErrorGeneric: "The compose file could not be fetched.",
  composeErrorFileMissing:
    "The arm finds no compose file for this stack in its base path. Usually the compose labels of the containers point to another path to the same files (such as /mnt/user instead of /mnt/cache) or name more than one file. Running “docker compose up -d” from the directory inside the base path resets the labels.",
  composeErrorFileMissingSearched: "The arm looked in:",
  composeHubOwnStack:
    "This is the stack this hub itself runs in. It is only shown here: applying it from here would replace the hub in the middle of the operation. Change it on the host.",
  composeExternallyManaged:
    "A service of this stack is externally managed. The file is only shown here: its definition stays with its manager, which would reset a change made here on its next update. Start, stop, logs and shell remain available.",
  // The editor and the comparison (#35, stage E6a).
  composeEdit: "Edit",
  composeFileTabs: "Compose project files",
  composeEnvFileName: ".env",
  composeEnvReveal: "Show values",
  composeEnvHide: "Hide values",
  composeEnvMissing: "There is no .env next to this Compose file in the project directory.",
  composeEnvEmpty: "The .env contains no readable entries.",
  composeEnvParsedNote: "This view shows keys and values from the .env; comments and blank lines remain in the file.",
  composeEnvOwnStack: "The hub stack’s .env is blocked because it contains the hub’s credentials.",
  composeEditLabel: "Edit compose file",
  composeEditKeyboardHint:
    "Tab indents, Shift and Tab outdent. Press Escape and then Tab to leave the field.",
  composeEditKeyboardTitle: "Keyboard shortcuts",
  composeShowDiff: "Compare",
  composeBackToEdit: "Back to the text",
  composeReload: "Reload",
  composeDiscard: "Discard",
  composeDiscardConfirm:
    "The changes to this compose file are not stored anywhere yet and will be lost. Continue anyway?",
  composeUnsaved: "unsaved changes",

  composeDiffTitle: "What changes",
  composeDiffCount: "+{added} · −{removed}",
  composeDiffNone: "Nothing changed. The draft is character for character the loaded state.",
  composeDiffUnified: "Stacked",
  composeDiffSideBySide: "Side by side",
  composeDiffCapped:
    "The comparison is too large to be computed line by line. Below, the entire old state is shown as removed and the entire new one as added — that is a replacement, not a comparison.",
  // Preview, confirmations and applying (#35, stage E6b).
  composePreviewTitle: "What is about to happen",
  composePreviewByAgent: "computed by the arm",
  composePreviewByHub: "estimated by the hub — this arm is too old for the dry run",
  composePreviewInvalid: "This draft would not pass the check on the arm: {reason}",

  composeConfirmNew: "New services",
  composeConfirmNewNote:
    "A service that did not exist before is not created as a side effect of a text change. Each one is confirmed individually.",
  composeConfirmRemoved: "Services going away",
  composeConfirmRemovedNote: "Their containers are removed after the start.",
  composeConfirmImages: "Images that must be pulled first",
  composeConfirmImagesNote: "They are not on the host yet. Pulling can take a while and needs the network.",
  composeImagesUnknown:
    "Which images are missing on the host has not been determined. The arm will ask once it has checked the draft.",

  composeExistingViolations: "Hardening findings this stack already has",
  composeExistingViolationsNote: "They are shown for information. They do not block applying.",
  composeHardeningLater:
    "Whether this draft introduces NEW hardening findings is measured by the arm only after the start — nobody knows beforehand. Without confirmation it rolls back.",
  composeUncertainties:
    "The hub could not resolve everything: {list}. What the arm makes of it may differ.",

  composeStepsTitle: "The steps of this run",
  composeStepValidate: "Check draft",
  composeStepConfirm: "Match confirmations",
  composeStepPullImages: "Pull images",
  composeStepWrite: "Write file",
  composeStepStart: "Start",
  composeStepResolveContainers: "Resolve containers",
  composeStepHardening: "Check hardening",
  composeStepRemoveContainers: "Remove dropped containers",
  composeStepCleanUp: "Clean up",
  composeStepRollBack: "Roll back",
  composeApply: "Apply",
  composeApplyRunning: "Applying",
  composeApplySilent:
    "This arm reports no intermediate steps. It answers when it is done — that can take several minutes.",
  composeApplyLeaveNote:
    "Closing this panel does NOT stop the run. The arm keeps working; only the watching ends.",
  composeApplyStepsTrimmed: "Older steps have been dropped: this view holds at most {count} steps.",
  composeApplied: "Applied.",
  composeResyncFailed:
    "The allowlist sync did not complete ({status}). Until the next tick, further actions on this stack may be refused — that looks like a permission problem but is not one.",
  composeResyncFailedWithoutStatus:
    "Whether the allowlist sync completed is not known. Until the next tick, further actions on this stack may be refused — that looks like a permission problem but is not one.",
  composeApplyUnknown: "The outcome is unknown.",

  composeBlockerNoChange: "Nothing changed.",
  composeBlockerInvalid: "The draft would not pass the check.",
  composeBlockerServices: "{count} still to confirm.",
  composeBlockerRemoved: "{count} still to confirm.",
  composeBlockerImages: "{count, plural, one {# image} other {# images}} still to confirm.",
  composeBlockerStale:
    "A confirmation no longer matches the draft. The comparison has been recomputed — please tick the boxes again.",

  composeQuestionTitle: "The arm asks back",
  composeQuestionServices: "New services: {added}. Going away: {removed}.",
  composeQuestionImages: "These images are not on the host and will be pulled: {list}",
  composeQuestionHardening:
    "{count, plural, one {This draft introduces a new hardening finding} other {This draft introduces # new hardening findings}}. The agent only takes it once every finding is confirmed one by one.",
  composeQuestionChangedElsewhere:
    "The file has changed since it was loaded. The draft is still in the editor — reloading shows the other state.",
  composeQuestionStartFailed: "The stack did not come up: {detail}",
  composeQuestionContainerMissing: "After the start, not all containers could be resolved: {detail}",
  composeQuestionInvalidDraft: "The arm considers the draft unusable: {detail}",
  composeQuestionAnchorStale:
    "The container this stack is addressed through is no longer released on the arm — usually an apply has replaced it. Nothing was written. Open the stack again from the overview and put the draft back in there.",
  composeQuestionImageRefUnreadable:
    "The arm cannot read the image reference „{ref}“ as it results from the draft. Nothing was written. Correct the reference in the draft and apply again.",
  composeNotRolledBack:
    "It did NOT roll back. The new file is on the host, and the stack is not running as before.",
  composeRolledBack: "The arm rolled back: file and stack are as they were.",
  composeAnswerAndRetry: "Confirm and apply again",

  // ── The selection by hand (#185) ──────────────────────────────────────────
  composeErrorAnchorOutsideBase:
    "The compose labels of the containers point to a directory outside the base path of the arm, such as /mnt/user instead of /mnt/cache. If the same file lies inside the base path, it can be assigned by hand below.",
  composeErrorAnchorAmbiguous:
    "The compose labels of the containers name more than one file, or none directly in the project directory. Which one applies can be set by hand below.",
  composeErrorAnchorLabelsMissing:
    "The compose labels of the containers are incomplete. The arm cannot assign them to a compose project.",
  composeSelectionOpen: "Assignment",
  composeSelectionTitle: "Compose file for {container}",
  composeSelectionIntro:
    "The arm only offers files it found itself: from the compose labels of the container and from the project directory in its base path. The choice then lives on the arm and applies until it is removed.",
  composeSelectionCandidatesLabel: "Offered files",
  composeSelectionSourceLabel: "from the labels",
  composeSelectionSourceBase: "in the base path",
  composeSelectionCurrent: "assigned",
  composeSelectionNone:
    "The arm offers no file for this container. Neither the labels nor the project directory in the base path lead to a compose file it may manage.",
  composeSelectionWarning:
    "The assigned file replaces the anchor from the labels for this container. The editor shows it, and applying starts the stack with it.",
  composeSelectionWarningLayered:
    "The labels name {count, plural, one {# file} other {# files}}. The running configuration is the overlay of all of them. The editor edits exactly one file, and applying starts with exactly that one: whatever came from the others (networks, volumes, environment) is dropped. Nothing is deleted; the other containers of the project keep running.",
  composeSelectionConfirm: "Assign file",
  composeSelectionClear: "Remove assignment",
  composeSelectionClose: "Close",
  composeSelectionSkipped: "For these containers the arm found no file of their own:",
  composeSelectionInvalid: "The arm did not accept this file. It is no longer on its list; the list is reloaded.",

  // ── New hub-owned project (#3) ────────────────────────────────────────────
  composeQuestionExternalSources:
    "The project mounts directories outside its project folder. The arm asks to confirm each source: {list}",
  projectNewAction: "New project",
  projectNewTitle: "New project on {host}",
  projectNewDescription:
    "The project gets its own folder under the arm''s base path and its own compose file. Several services share this folder.",
  projectNameLabel: "Name",
  projectNameHint:
    "Name of the project and its folder: 2 to 63 letters, digits, dots, hyphens and underscores, starting with a letter or digit.",
  projectCheck: "Check",
  projectPreviewStale: "Name or draft changed since the check.",
  projectDirectory: "Project folder:",
  projectConfirmServices: "These services are created",
  projectSources: "Data sources",
  projectSourceProject: "project folder",
  projectSourceExternal: "external",
  projectSourceVolume: "volume",
  projectSourceAnonymous: "anonymous",
  projectSourceReadOnly: "read-only",
  projectSourceShared: "shared",
  projectConfirmExternal: "Confirm external sources",
  projectConfirmExternalNote:
    "These directories lie outside the project folder. The container gets access to them; removal and file access treat them separately.",
  projectCreate: "Create project",
  projectCreating:
    "The arm creates and starts the project. Pulling images can take several minutes; closing does not stop it.",
  projectCreated: "The project is created.",
  projectRestartLooping: "{count, plural, one {# service is} other {# services are}} restarting repeatedly.",
  projectResyncWarning:
    "The arm''s allowlist is not reconciled yet. Until the next reconciliation it refuses actions on the new containers.",
  projectDirectoryLeft:
    "A container wrote files into the project folder. The folder therefore stays and keeps the name taken.",
  projectAnswerAndRetry: "Confirm and create again",
  projectBlockerStale: "The confirmations no longer match the check. Checking again resets them.",
  projectBlockerName: "Enter a name first.",
  projectBlockerCheck: "Run the check first.",
  projectBlockerExternal:
    "{count, plural, one {# external source is} other {# external sources are}} not confirmed yet.",
  projectErrorDirectoryTaken: "A folder with this name is already taken.",
  projectErrorNameInvalid: "This name cannot be used as a project and folder name.",
  projectErrorLocked: "This folder is locked against self-management.",
  // ── Hardening findings with explanation (#8) ──────────────────────────────
  hardeningSeverityDelegationLock: "Controls the host",
  hardeningSeverityWarning: "Warning",
  hardeningSeverityNotice: "Notice",
  hardeningSeverityUnknown: "Unknown",
  hardeningService: "service {service}",
  hardeningConfirmFinding: "Confirm finding on service {service}",
  hardeningDelegationLockNote:
    "A container with a “controls the host” finding can in practice be used like the host itself. The agent allows mutating actions on it only through internal access and logs them separately; externally they stay locked.",
  hardeningRuleDockerSocket: "Docker socket mounted",
  hardeningRuleDockerSocketText:
    "Through the Docker socket the container can start further containers, including privileged ones with the host file system. That amounts to root access to the host.",
  hardeningRuleSelfMount: "Management directory mounted",
  hardeningRuleSelfMountText:
    "The mount reaches a directory that carries the operation of the agent or hub, such as secrets and keys. A parent directory like / counts just the same. The container could rewrite the management itself.",
  hardeningRuleVolumeUnresolved: "Volume cannot be checked",
  hardeningRuleVolumeUnresolvedText:
    "Docker returned no details for this named volume. Whether it points at a host path is not established, so the agent treats it like a critical mount.",
  hardeningRulePrivileged: "Privileged mode",
  hardeningRulePrivilegedText:
    "privileged: true gives the container every capability and every host device and switches off AppArmor and seccomp. Escaping to the host then needs no further flaw.",
  hardeningRuleHostNamespace: "Host namespace shared",
  hardeningRuleHostNamespaceText:
    "With pid, ipc or network in host mode the container shares that namespace with the host. It sees its processes, shared memory or network interfaces and can act on them.",
  hardeningRuleSensitivePath: "System directory mounted",
  hardeningRuleSensitivePathText:
    "The mount opens an operational or system directory of the host such as /etc, /root, /proc, /run or /var/lib/docker. Even read-only it exposes configuration and credentials.",
  hardeningRuleOutsideBase: "Mount outside the project directories",
  hardeningRuleOutsideBaseText:
    "The source does not lie below a project directory in the agent''s base path. The container reaches data that no project manages.",
  hardeningRuleOutsideUniverse: "Mount in another project''s directory",
  hardeningRuleOutsideUniverseText:
    "This container is protected; only sources below its own project directory are intended for it.",
  hardeningRuleCapability: "Dangerous capability",
  hardeningRuleCapabilityText:
    "An added Linux capability such as SYS_ADMIN, NET_ADMIN or SYS_PTRACE widens what the container may do to the host kernel.",
  hardeningRuleDevice: "Device passed through",
  hardeningRuleDeviceText: "The container accesses a host device directly, such as a graphics unit.",
  hardeningRuleUnconfined: "AppArmor or seccomp disabled",
  hardeningRuleUnconfinedText: "A protection profile that limits the container''s system calls is switched off.",
  hardeningRuleNoNewPrivileges: "no-new-privileges missing",
  hardeningRuleNoNewPrivilegesText: "Processes in the container can gain additional rights through setuid programs.",
  hardeningRuleCapDrop: "Capabilities not dropped",
  hardeningRuleCapDropText: "Without cap_drop: ALL the container keeps Docker''s full default set.",
  hardeningRuleLimits: "Resource limit missing",
  hardeningRuleLimitsText: "Without a limit for memory, CPU or processes the container can exhaust the host.",
  hardeningRuleLogging: "Log without size limit",
  hardeningRuleLoggingText: "json-file without max-size lets the log grow without bound until the disk is full.",
  hardeningRuleUnknownText: "The hub does not know this rule. The finding is shown as the agent reports it.",
  hardeningConfirmNote:
    "Exactly this list is confirmed. If the next attempt brings a further finding, the agent asks again; its protection rules stay unchanged.",
  hardeningConfirmMissing:
    "{count, plural, one {# finding is} other {# findings are}} not yet confirmed one by one."
} satisfies typeof deCompose;
