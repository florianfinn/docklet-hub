import { useFileSource } from "./source-context";
import { FolderPlus, Pencil, Trash2 } from "lucide-react";
import type { Messages } from "use-intl";
import { useState } from "react";
import { useTranslations } from "use-intl";

import { applyFileCommand, type FileListing, type WebftpEntry } from "./api";
import { Button } from "../../platform/ui/shadcn/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "../../platform/ui/shadcn/dialog";
import { Input } from "../../platform/ui/shadcn/input";
import { fileErrorKey } from "./file-errors";
import { childPath } from "./file-paths";

// Creating uses uploadable; rename/delete use their separate capability.
type Verdict = "allowed" | "blocked" | "unknown";

export function writeVerdict(listing: FileListing): Verdict {
  if (listing.diagnostics === null) return "unknown";
  return listing.diagnostics.deletable ? "allowed" : "blocked";
}

/**
 * Der gemeinsame Ablauf aller drei Handlungen.
 *
 * Nicht als Komponente, sondern als Hook: die drei unterscheiden sich im
 * Rumpf, den sie schicken, und im Satz daneben — nicht darin, wie sie warten,
 * scheitern und danach die Liste erneuern lassen.
 */
function useCommand(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<keyof Messages | null>(null);

  const run = (send: () => Promise<unknown>, finish?: () => void): void => {
    setBusy(true);
    setErrorKey(null);
    void send()
      .then(() => {
        finish?.();
        onDone();
      })
      .catch((error: unknown) => setErrorKey(fileErrorKey(error)))
      .finally(() => setBusy(false));
  };

  return { busy, errorKey, setErrorKey, run };
}

/** Der Fehlersatz einer Handlung — an derselben Stelle für alle drei. */
function CommandError({ errorKey, testId }: { errorKey: keyof Messages | null; testId: string }) {
  const t = useTranslations();
  if (errorKey === null) return null;
  return (
    <p className="text-[12px] text-destructive" data-testid={testId}>
      {t(errorKey)}
    </p>
  );
}

/**
 * Ein neuer Ordner IN DIESEM Verzeichnis.
 *
 * ⚠️ `path` IST DAS ZIELVERZEICHNIS UND `name` DER NEUE NAME — getrennt, weil
 * der Server sie durch zwei verschiedene Prüfungen des Agenten schickt. Ein
 * zusammengesetzter Pfad liefe an der Namensprüfung vorbei.
 */
export function CreateDirectory({
  hostId,
  containerId,
  listing,
  onDone
}: {
  hostId: string;
  containerId: string;
  listing: FileListing;
  onDone: () => void;
}) {
  const t = useTranslations();
  const sourceId = useFileSource();
  const verdict: Verdict = listing.diagnostics === null ? "unknown" : listing.diagnostics.uploadable ? "allowed" : "blocked";
  const [name, setName] = useState("");
  const { busy, errorKey, run } = useCommand(onDone);

  const blocked = verdict === "blocked";

  return (
    <div className="flex flex-col gap-1.5" data-testid="files-create-directory" data-verdict={verdict}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          disabled={blocked || busy}
          aria-label={t("filesFolderCreateName")}
          placeholder={t("filesFolderCreateName")}
          data-testid="files-create-directory-name"
          className="h-8 max-w-56 text-[13px]"
          onChange={(event) => setName(event.target.value)}
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={blocked || busy || name === ""}
          data-testid="files-create-directory-submit"
          onClick={() =>
            run(
              () => applyFileCommand(hostId, containerId, { action: "create-directory", path: listing.path, name }, sourceId),
              () => setName("")
            )
          }
        >
          <FolderPlus aria-hidden="true" className="size-3.5" />
          {busy ? t("filesFolderCreatePending") : t("filesFolderCreate")}
        </Button>
      </div>

      {blocked || listing.diagnostics?.deletable === false ? (
        <p role="alert" className="text-[12px] text-state-warn" data-testid="files-write-blocked">
          {t("filesWriteBlocked")}
        </p>
      ) : null}
      {verdict === "unknown" ? (
        <p role="alert" className="text-[12px] text-state-warn" data-testid="files-write-unknown">
          {t("filesWriteUnknown")}
        </p>
      ) : null}
      <CommandError errorKey={errorKey} testId="files-create-directory-error" />
    </div>
  );
}

/** Ein Eintrag bekommt einen neuen Namen. */
function RenameEntry({
  hostId,
  containerId,
  listing,
  entry,
  disabled,
  onDone
}: {
  hostId: string;
  containerId: string;
  listing: FileListing;
  entry: WebftpEntry;
  disabled: boolean;
  onDone: () => void;
}) {
  const t = useTranslations();
  const sourceId = useFileSource();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(entry.name);
  const { busy, errorKey, setErrorKey, run } = useCommand(onDone);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setErrorKey(null);
        // Beim Öffnen steht der ALTE Name im Feld: umbenannt wird meistens
        // eine Endung oder ein Wort, nicht der ganze Name.
        if (next) setName(entry.name);
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          data-testid={`files-rename-${entry.name}`}
          className="text-[13px]"
        >
          <Pencil aria-hidden="true" className="size-3.5" />
          {t("filesRename")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t("filesRenameTitle")}</DialogTitle>
          {/* Der Name steht IN der Frage: der Dialog verdeckt die Zeile, aus
              der er kommt, und bei zwanzig Einträgen ist „dieser Eintrag"
              genau die Auskunft, die dann fehlt. */}
          <DialogDescription>{t("filesRenameBody", { name: entry.name })}</DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          aria-label={t("filesRenameLabel")}
          data-testid="files-rename-name"
          onChange={(event) => setName(event.target.value)}
        />
        <CommandError errorKey={errorKey} testId="files-rename-error" />
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("cancel")}
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={busy || name === "" || name === entry.name}
            data-testid="files-rename-submit"
            onClick={() =>
              run(
                () =>
                  applyFileCommand(hostId, containerId, {
                    action: "rename",
                    // ⚠️ Bei `rename` bezeichnet `path` den EINTRAG SELBST und
                    // nicht sein Verzeichnis — anders als bei
                    // `create-directory`. Deshalb `childPath`.
                    path: childPath(listing.path, entry.name),
                    name
                  }, sourceId),
                () => setOpen(false)
              )
            }
          >
            {busy ? t("filesRenamePending") : t("filesRenameSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Ein Eintrag wird entfernt — mit Rückfrage.
 *
 * ⚠️ DIE RÜCKFRAGE IST NICHT HÖFLICHKEIT. Das ist die einzige Handlung dieser
 * Fläche, die Daten des Betreibers vernichtet, und sie ist nicht
 * zurückzunehmen: der Hub hält keine Kopie, und der Arm hat keinen Papierkorb.
 */
function DeleteEntry({
  hostId,
  containerId,
  listing,
  entry,
  disabled,
  onDone
}: {
  hostId: string;
  containerId: string;
  listing: FileListing;
  entry: WebftpEntry;
  disabled: boolean;
  onDone: () => void;
}) {
  const t = useTranslations();
  const sourceId = useFileSource();
  const [open, setOpen] = useState(false);
  const { busy, errorKey, setErrorKey, run } = useCommand(onDone);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setErrorKey(null);
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          data-testid={`files-delete-${entry.name}`}
          className="text-[13px] text-destructive hover:text-destructive"
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
          {t("filesDelete")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t("filesDeleteTitle")}</DialogTitle>
          <DialogDescription>{t("filesDeleteConfirm", { name: entry.name })}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t("filesDeleteDetail")}</p>
        <CommandError errorKey={errorKey} testId="files-delete-error" />
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("cancel")}
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            data-testid="files-delete-submit"
            onClick={() =>
              run(
                () =>
                  applyFileCommand(hostId, containerId, {
                    action: "delete",
                    path: childPath(listing.path, entry.name)
                  }, sourceId),
                () => setOpen(false)
              )
            }
          >
            {busy ? t("filesDeletePending") : t("filesDeleteSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Rename/delete require their own capability, independent of uploads.
export function EntryActions({
  hostId,
  containerId,
  listing,
  entry,
  onDone
}: {
  hostId: string;
  containerId: string;
  listing: FileListing;
  entry: WebftpEntry;
  onDone: () => void;
}) {
  // Unknown diagnostics still defer to the agent.
  const blocked = writeVerdict(listing) === "blocked";

  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1" data-testid="files-entry-actions">
      <RenameEntry
        hostId={hostId}
        containerId={containerId}
        listing={listing}
        entry={entry}
        disabled={blocked}
        onDone={onDone}
      />
      <DeleteEntry
        hostId={hostId}
        containerId={containerId}
        listing={listing}
        entry={entry}
        disabled={blocked}
        onDone={onDone}
      />
    </span>
  );
}
