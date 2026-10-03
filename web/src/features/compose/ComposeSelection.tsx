import type { Messages } from "use-intl";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "use-intl";

import { Badge } from "../../platform/ui/shadcn/badge";
import { Button } from "../../platform/ui/shadcn/button";
import { Card } from "../../platform/ui/shadcn/card";
import { Label } from "../../platform/ui/shadcn/label";
import { RadioGroup, RadioGroupItem } from "../../platform/ui/shadcn/radio-group";
import { clearComposeSelection, selectComposeFile } from "./api";
import { anchorReasonKey, composeErrorKey, errorReason } from "./compose-errors";
import { useComposeCandidates } from "./compose-queries";

// The selection of a container's compose file by hand (#185). Ported from
// `web/src/screens/stack/compose/ComposeSelection.tsx` of the old layout
// (branch `claude/compose-selection`, base 6c3409a); the candidates are a query
// since #265, like every read of this feature.
//
// ⚠️ A CHOICE AND NO FREE PATH. The list comes from the arm, and it accepts
// only a path from it. There is no text field here: it would be an invitation
// the arm refuses anyway, and without that refusal a way to a traversal.
//
// ⚠️ THE WARNING STANDS BEFORE THE BUTTON AND NOT IN A CONFIRM. It names the
// concrete case: with more than one file in the labels it lists each of them.
// A `window.confirm` with the same text is a dialog one clicks away before
// reading it.
//
// ⚠️ THIS SURFACE ASKS ONLY ONCE IT IS MOUNTED. Every request writes an audit
// entry at the arm (`compose-candidates`); the compose tab mounts it on demand,
// or when no file was found.

export function ComposeSelection({
  hostId,
  containerId,
  containerName,
  onChanged,
  onClose
}: {
  hostId: string;
  containerId: string;
  containerName: string;
  /** After setting or clearing: fetch the file again. */
  onChanged: () => void;
  onClose?: () => void;
}) {
  const t = useTranslations();
  const candidates = useComposeCandidates(hostId, containerId);
  // `null`: the operator has not picked yet, and the selection in force (or the
  // first candidate) is the choice.
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionErrorKey, setActionErrorKey] = useState<keyof Messages | null>(null);

  const data = candidates.data ?? null;
  const choice = picked ?? data?.selectedFilePath ?? data?.candidates[0]?.filePath ?? null;

  const run = (action: () => Promise<void>): void => {
    setBusy(true);
    setActionErrorKey(null);
    action()
      .then(() => onChanged())
      .catch((error: unknown) => {
        setActionErrorKey(composeErrorKey(error));
        // A path the arm no longer offers: its list has changed, so it is asked
        // again instead of leaving the old one on screen.
        if (errorReason(error) === "invalid-compose-candidate") {
          setPicked(null);
          void candidates.refetch();
        }
      })
      .finally(() => setBusy(false));
  };

  return (
    <Card className="gap-3 p-4 text-[13px]" data-testid="compose-selection">
      <p className="font-medium">{t("composeSelectionTitle", { container: containerName })}</p>
      <p className="text-muted-foreground">{t("composeSelectionIntro")}</p>

      {candidates.isPending ? <p className="text-muted-foreground">{t("loading")}</p> : null}
      {candidates.error !== null ? <p className="text-destructive">{t(composeErrorKey(candidates.error))}</p> : null}

      {data !== null && !data.anchor.ok ? (
        <p className="text-muted-foreground" data-testid="compose-selection-anchor">
          {t(anchorReasonKey(data.anchor.reason))}
        </p>
      ) : null}

      {data !== null && data.candidates.length === 0 ? (
        <p className="text-muted-foreground" data-testid="compose-selection-none">
          {t("composeSelectionNone")}
        </p>
      ) : null}

      {data !== null && data.candidates.length > 0 ? (
        <>
          <RadioGroup
            aria-label={t("composeSelectionCandidatesLabel")}
            value={choice ?? ""}
            onValueChange={setPicked}
            className="gap-2"
          >
            {data.candidates.map((candidate, index) => (
              <div key={candidate.filePath} className="flex min-w-0 items-center gap-2">
                <RadioGroupItem id={`compose-candidate-${index}`} value={candidate.filePath} />
                <Label htmlFor={`compose-candidate-${index}`} className="min-w-0 flex-wrap gap-2 font-normal">
                  <span className="min-w-0 truncate font-mono">{candidate.filePath}</span>
                  <Badge variant="secondary">
                    {candidate.source === "label" ? t("composeSelectionSourceLabel") : t("composeSelectionSourceBase")}
                  </Badge>
                  {candidate.filePath === data.selectedFilePath ? (
                    <Badge data-testid="compose-selection-current">{t("composeSelectionCurrent")}</Badge>
                  ) : null}
                </Label>
              </div>
            ))}
          </RadioGroup>

          <div
            className="flex gap-2 rounded-md border border-state-warn/40 bg-state-warn/10 p-3"
            data-testid="compose-selection-warning"
          >
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-state-warn" />
            <div className="flex min-w-0 flex-col gap-2">
              <p>{t("composeSelectionWarning")}</p>
              {data.labelFilePaths.length > 1 ? (
                <>
                  <p>{t("composeSelectionWarningLayered", { count: data.labelFilePaths.length })}</p>
                  <ul className="flex flex-col gap-0.5" data-testid="compose-selection-label-files">
                    {data.labelFilePaths.map((path) => (
                      <li key={path} className="truncate font-mono">
                        {path}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          </div>
        </>
      ) : null}

      {actionErrorKey !== null ? <p className="text-destructive">{t(actionErrorKey)}</p> : null}

      <div className="flex flex-wrap gap-2">
        {data !== null && data.candidates.length > 0 ? (
          <Button
            size="sm"
            data-testid="compose-selection-confirm"
            disabled={busy || choice === null || choice === data.selectedFilePath}
            onClick={() => {
              if (choice !== null) run(() => selectComposeFile(hostId, containerId, choice));
            }}
          >
            {t("composeSelectionConfirm")}
          </Button>
        ) : null}
        {data?.selectedFilePath ? (
          <Button
            size="sm"
            variant="outline"
            data-testid="compose-selection-clear"
            disabled={busy}
            onClick={() => run(() => clearComposeSelection(hostId, containerId))}
          >
            {t("composeSelectionClear")}
          </Button>
        ) : null}
        {onClose ? (
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("composeSelectionClose")}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
