import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "use-intl";

import type { MarkView } from "contract";

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
import { deleteMark } from "./api";
import { describeDeleteMarkError } from "./mark-errors";

/**
 * Der Bestätigungsdialog vor dem Entfernen.
 *
 * ⚠️ ER IST NICHT HÖFLICHKEIT. `mark_assignment.mark_id` trägt
 * `ON DELETE CASCADE` (server/src/platform/db/migrations/007-marks.sql:134,
 * nachgesehen): mit der Marke verschwinden in einem Schritt alle ihre
 * Zuordnungen, an jedem Stack und an jedem Container. Genau das steht im Text
 * — wer es erst hinterher merkt, hat keinen Weg zurück.
 *
 * `Dialog` und nicht `window.confirm`, aus dem Grund, der in
 * `web/src/features/hosts/HostCard.tsx` steht: der Kasten des Browsers trägt
 * weder Schrift noch Farben dieser Oberfläche und stellt einen deutschen Satz
 * neben zwei englische Schaltflächen des Systems.
 */
export function RemoveMarkDialog({ mark, onRemoved }: { mark: MarkView; onRemoved: (markId: string) => void }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = () => {
    setBusy(true);
    setError(null);
    deleteMark(mark.id)
      .then(() => {
        setOpen(false);
        onRemoved(mark.id);
      })
      .catch(() => setError(describeDeleteMarkError(t)))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          data-testid={`remove-${mark.id}`}
        >
          <Trash2 aria-hidden="true" />
          {t("settingsMarkRemove")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t("settingsMarkRemoveTitle")}</DialogTitle>
          <DialogDescription>{t("settingsMarkRemoveConfirm", { mark: mark.name })}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
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
            onClick={remove}
            data-testid={`remove-confirm-${mark.id}`}
          >
            {busy ? t("loading") : t("settingsMarkRemove")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
