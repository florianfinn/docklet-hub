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
  composeQuestionHardening: "This draft introduces new hardening findings: {list}",
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
  composeSelectionInvalid: "The arm did not accept this file. It is no longer on its list; the list is reloaded."
} satisfies typeof deCompose;
