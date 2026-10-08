// English texts of the feature `files` (#263). The reasons stand next to the
// German texts (`de.ts`); here is only the translation.
//
// ⚠️ `satisfies typeof deFiles` is on the literal because only an object
// literal is checked by TypeScript for EXCESS properties: without it this part
// could silently carry a key that does not exist in German.

import type { deFiles } from "./de";

export const enFiles = {
  filesBlockerSourceUnknown: "The selected source is unknown.",
  filesBlockerSourceProtected: "The source or a writable mount in this container is protected.",
  filesBlockerSourceShared: "Other containers use this source; access is read-only.",
  filesBlockerSourceOwnershipUnknown: "Exclusive ownership of this source cannot be confirmed.",
  filesBlockerSourceReadOnly: "This source is read-only.",
  filesBlockerBackupDirectoryProtected: "The backup directory cannot be accessed.",
  filesBlockerNotMounted: "This path is not mounted in the container.",
  filesBlockerAgentReadOnly: "The agent is in read-only mode.",
  filesBlockerNotAllowlisted: "This container is not allowlisted.",
  filesBlockerNameNotUsableAsDirectory: "The container name cannot be used as a directory.",
  filesBlockerInvalidComposeFileName: "The Compose file name is invalid.",
  filesBlockerComposeProjectNameMissingOrInvalid: "The Compose project name is missing or invalid.",
  filesBlockerProjectDirOutsideBasePath: "The project directory is outside the permitted base path.",
  filesBlockerSelfManagementLocked: "The agent cannot edit its own operating files.",
  filesBlockerComposeFileMissing: "The Compose file is missing.",
  filesBlockerComposeAnchorLabelsMissing: "The Compose labels do not identify the project.",
  filesBlockerComposeAnchorOutsideBasePath: "The Compose project is outside the permitted base path.",
  filesBlockerComposeAnchorFileAmbiguous: "The Compose file cannot be identified unambiguously.",
  filesBlockerDirectoryTaken: "The project directory is already in use.",
  filesBlockerStackServiceNotAllowlisted: "A service in this project is not allowlisted.",
  filesBlockerExternallyManaged: "This project is managed externally.",
  filesBlockerComposeHashMissing: "The expected Compose hash is missing.",
  filesBlockerConfirmationMissing: "A required confirmation is missing.",
  filesBlockerTooManyStreams: "Too many requests are active.",
  filesBlockerStackBusy: "Another operation is changing this project.",
  filesBlockerPathEmpty: "The path is empty.",
  filesBlockerPathAbsolute: "Only relative paths are permitted.",
  filesBlockerPathTraversal: "The path must remain inside the selected source.",
  filesBlockerPathInvalidCharacters: "The path contains invalid characters.",
  filesBlockerPathBlocked: "This file uses a protected editing route.",
  filesBlockerPathOutside: "The path is outside the selected source.",
  filesBlockerFileReplaced: "The file or directory was replaced during access.",
  filesBlockerNotReadable: "The source cannot be read.",
  filesBlockerNotWritable: "Ownership or permissions prevent writing.",
  filesBlockerWrongKind: "Only regular files and directories are supported.",
  filesBlockerNotATextFile: "This file is not valid UTF-8 text.",
  filesBlockerTooLarge: "The content exceeds the permitted byte limit.",
  filesBlockerAlreadyExists: "The destination already exists. Choose another name.",
  filesBlockerFileChangedExternally: "The file was changed externally.",
  filesBlockerExpectedHashMissing: "The expected content hash is missing.",
  filesBlockerBusy: "A change is already running for this project.",
  filesSourcesLabel: "Choose mount source",
  filesSourceProject: "Project",
  filesSourceExternal: "External bind mount",
  filesSourceVolume: "Named volume",
  filesSourceWritable: "Writable",
  filesSourceReadOnly: "Read only",

  containerTabFiles: "Files",

  // ── The file surface (web FTP), package B5 stage E5a (#5) ────────────────

  filesShareTitle: "No share has been chosen for this container yet.",
  filesShareBody:
    "Without a share there is no file access — the agent refuses every request, and rightly so: what is reachable is your decision, not the decision of this interface. Only what is listed here can be chosen: the bind mounts of this container below its project directory.",
  filesShareChoose: "Choose",
  filesSharePending: "Choosing …",
  filesShareDestination: "inside the container at {destination}",
  filesShareWritable: "mounted writable",
  filesShareReadOnly: "mounted read-only",
  filesShareRelease: "Release the share",
  filesCurrentShare: "Share: {share}",

  filesShareNoneTitle: "This container has no share that could be chosen.",
  filesShareNoneBody:
    "Only a bind mount below the project directory of this container qualifies as a share. This one has none — its data lives in a named volume, inside the image itself, or outside the project directory. That is a complete answer, not a fault.",

  filesColumnName: "Name",
  filesColumnKind: "Kind",
  filesColumnSize: "Size",
  filesColumnChanged: "Changed",
  filesColumnActions: "Actions",
  filesRootLabel: "Root of the share",
  filesUp: "One level up",
  filesEmpty: "This directory is empty.",
  filesDownload: "Download",

  filesTruncated:
    "This list is cut short: the directory holds more entries than the agent sends in one answer. What is missing here is therefore not gone.",

  filesDiagnosticsReadable: "readable",
  filesDiagnosticsNotReadable: "not readable",
  filesDiagnosticsDeletable: "rename and delete allowed",
  filesDiagnosticsNotDeletable: "rename and delete blocked",
  filesDiagnosticsUploadable: "writable inside the container",
  filesDiagnosticsNotUploadable: "read-only inside the container",
  filesDiagnosticsOwner: "owner {uid}:{gid}",
  filesDiagnosticsNone:
    "The agent could not judge this directory. That means: no answer — and not that nothing is allowed here.",

  fileKindFile: "File",
  fileKindDirectory: "Directory",
  fileKindSymlink: "Symlink",
  fileKindOther: "Other",

  fileValueNone: "—",

  fileErrorInvalidPath: "This path is not something the agent can work with.",
  fileErrorForbidden:
    "The agent refuses the access. It keeps the list of released containers itself; if this one is not in it, retrying does not help.",
  fileErrorNotFound: "This path no longer exists in the share.",
  fileErrorShareUnknown:
    "This path is not a bind mount of this container. Only what the candidate list holds can be chosen — and it may have changed since this page was loaded.",
  // The three „409" of this view get three sentences, not one: „no share
  // chosen", „this path is not one" and „the agent refused" are three different
  // situations.
  fileErrorShareUnset:
    "No share is chosen for this container any more. It was probably released while this page was open — reload, and the choice will be back.",
  fileErrorAgentConflict:
    "The agent refused this access. What it knows about this container no longer matches what the hub knows; after a reload things will look different.",
  fileErrorAgentUnreachable: "The agent of this host did not answer.",
  fileErrorAgentReadOnly: "This agent is set to read only. It writes nothing while the kill switch is down.",
  fileErrorTooManyStreams:
    "The agent is already running the maximum number of concurrent streams. Closing a log tab or finishing a download frees a slot.",
  fileErrorAgentTimeout: "The agent of this host took too long.",
  fileErrorUnknown: "The files could not be fetched.",

  // The number is deliberately absent: the limits belong to the agent and live
  // in its contract only.
  fileErrorTooLarge:
    "This file is larger than the agent accepts in one go. The limit lives with the agent, not in this interface.",

  // ── The text editor (package B5, stage E5b, #5) ──────────────────────────
  //
  // The conflict is the important case here. It means „somebody else changed
  // this file", not „it did not work" — and it offers two ways out, because
  // each of them costs something.
  filesEditOpen: "Edit",
  filesEditorClose: "Close editor",
  filesEditorLabel: "File contents",
  filesEditorSave: "Save",
  filesEditorSaving: "Saving …",
  filesEditorSaved: "Saved.",
  filesEditorConflictTitle: "This file has changed since it was loaded.",
  filesEditorConflictBody:
    "Someone or something else touched it while it was open here. Your text is still in the field below — you do not have to retype it. Either fetch the other version and discard your change, or save your version over theirs.",
  filesEditorConflictNoMerge:
    "This view does not show both versions side by side: on a conflict the agent reports THAT something changed, not what. To be sure, open the other version in a second tab.",

  // ── Upload ───────────────────────────────────────────────────────────────
  //
  // Whether it works does NOT depend on the agent's permissions but on whether
  // the container mounted this directory writable. And „no information" is not
  // the same as „no".
  filesUploadChoose: "Choose file",
  // Replaces the browser's own label, which cannot be set and appeared in
  // English inside the German interface.
  filesUploadNone: "No file chosen.",
  filesUploadSubmit: "Upload",
  filesUploadPending: "Uploading …",
  filesUploadDone: "„{name}“ has been uploaded.",
  filesUploadBlocked:
    "Nothing can be uploaded here: the container mounted this directory read-only. That is a statement about the container, not about the permissions of the agent.",
  filesUploadUnknown:
    "Whether uploads work here is unresolved — the agent could not assess this directory. The attempt still goes out; it is decided there.",

  // The numbers appear here but not in `fileErrorTooLarge` above: there they
  // would be literals in this file and a second truth beside the agent's
  // contract; here they are placeholders filled at runtime from the envelope of
  // `GET …/files` (#136).
  filesUploadTooLarge:
    "This file is {size}, and the agent accepts at most {limit} in one go. It is not sent at all.",
  filesUploadProgress: "{sent} of {total} sent.",
  filesUploadCancel: "Cancel",
  filesUploadAborted: "The upload was cancelled. The file stays chosen; uploading again starts from the beginning.",

  // ── Create, rename, delete ───────────────────────────────────────────────
  //
  // Deleting and renaming need write permission on the DIRECTORY, not on the
  // file.
  filesFolderCreate: "Create folder",
  filesFolderCreateName: "Name of the new folder",
  filesFolderCreatePending: "Creating …",
  filesRename: "Rename",
  filesRenameTitle: "Rename entry",
  filesRenameBody: "„{name}“ gets a new name. Its contents stay where they are.",
  filesRenameLabel: "New name",
  filesRenameSubmit: "Rename",
  filesRenamePending: "Renaming …",
  filesDelete: "Delete",
  filesDeleteTitle: "Really delete?",
  filesDeleteConfirm: "„{name}“ will be removed on the agent.",
  filesDeleteDetail:
    "This is the only action on this view that destroys data. The hub keeps no copy, the agent has no recycle bin, and there is no way back.",
  filesDeleteSubmit: "Delete permanently",
  filesDeletePending: "Deleting …",
  filesWriteBlocked:
    "This action is blocked for this source. Rename and delete require a source visible to the arm under its base path and write permission on the directory.",
  filesWriteUnknown:
    "Whether writing works here is unresolved — the agent could not assess this directory. The attempt still goes out; it is decided there.",
filesArchiveReplaceWarning: "If the source is not visible to the arm, saving replaces the file. Other hard links retain the old content; ACLs and extended attributes are lost. Visible sources are written in the same inode.",
  filesArchiveReplaceConfirm: "Saving replaces files that are not visible to the arm. Hard links are not updated; ACLs and extended attributes are lost. Confirm saving?",
} satisfies typeof deFiles;
