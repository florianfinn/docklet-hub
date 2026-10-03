import { useState } from "react";
import { useTranslations } from "use-intl";

import { MARK_NAME_MAX, type MarkView } from "contract";

import { MarkChip } from "../../platform/ui/marks";
import { Button } from "../../platform/ui/shadcn/button";
import { Input } from "../../platform/ui/shadcn/input";
import { updateMark } from "./api";
import { describeSaveMarkError } from "./mark-errors";
import { StyleSelect, ToneSelect, draftOf, isSame, type MarkDraft } from "./mark-fields";
import { RemoveMarkDialog } from "./RemoveMarkDialog";

/** Eine Zeile der Liste: die Marke, ihre drei Felder, Speichern und Entfernen. */
export function MarkRow({
  mark,
  editable,
  onSaved,
  onRemoved
}: {
  mark: MarkView;
  editable: boolean;
  onSaved: (mark: MarkView) => void;
  onRemoved: (markId: string) => void;
}) {
  const t = useTranslations();
  const [draft, setDraft] = useState<MarkDraft>(() => draftOf(mark));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ⚠️ Der Entwurf folgt dem gespeicherten Stand nur über den SCHLÜSSEL der
  // Zeile: `MarksPanel` gibt jeder Zeile `key={mark.id}`, ein neuer Stand aus
  // dem Server erzeugt also keine neue Zeile, und der Entwurf bleibt stehen.
  // Das ist gewollt — ein `useEffect`, der ihn nachzöge, überschriebe das,
  // was der Betreiber gerade tippt.

  const changed = !isSame(draft, draftOf(mark));
  const trimmed = draft.name.trim();

  const save = () => {
    if (trimmed === "") {
      setError(t("settingsMarkNameEmpty"));
      return;
    }
    setBusy(true);
    setError(null);
    updateMark(mark.id, { name: trimmed, hue: draft.hue, style: draft.style })
      .then((saved) => {
        // Übernommen wird die MARKE, die der Server zurückgibt, und nicht das,
        // was gesendet wurde — dafür antwortet die Route mit ihr. Kürzt der
        // Server den Namen, steht sein Stand auf dem Schirm und nicht die
        // Absicht des Browsers.
        setDraft(draftOf(saved));
        onSaved(saved);
      })
      .catch((cause: unknown) => setError(describeSaveMarkError(t, cause)))
      .finally(() => setBusy(false));
  };

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border bg-card px-3 py-2.5"
      data-testid={`mark-row-${mark.id}`}
    >
      {/* Die Vorschau. Sie zeigt den ENTWURF und nicht den gespeicherten
          Stand: wer einen Ton wählt, sieht ihn, bevor er speichert. */}
      {/* `max-w-[8rem]` deckelt die Vorschau: ein langer Name (bis 40 Zeichen
          sind erlaubt) schöbe sonst die Felder daneben aus der Zeile. Der
          Name selbst steht ungekürzt im Feld daneben. */}
      <MarkChip
        className="max-w-[8rem]"
        mark={{ ...draft, id: mark.id, name: trimmed === "" ? mark.name : trimmed }}
      />

      {editable ? (
        <>
          <Input
            value={draft.name}
            maxLength={MARK_NAME_MAX}
            aria-label={t("settingsMarkNameFor", { mark: mark.name })}
            data-testid={`mark-name-${mark.id}`}
            className="h-8 w-[11rem]"
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          />
          <ToneSelect
            draft={draft}
            label={t("settingsMarkHueFor", { mark: mark.name })}
            onChange={(hue) => setDraft((current) => ({ ...current, hue }))}
          />
          <StyleSelect
            draft={draft}
            label={t("settingsMarkStyleFor", { mark: mark.name })}
            onChange={(style) => setDraft((current) => ({ ...current, style }))}
          />
          {/* ⚠️ Die zwei Knöpfe stehen in EINER Gruppe mit `ml-auto`, und das
              ist am Bild entschieden: ohne sie brach „Entfernen" in jeder
              Zeile allein auf eine zweite Zeile um (gemessen am 2026-09-06 am
              gebauten Bildschirm: 806 px Inhalt in 772 px Platz). Als Gruppe
              rechts umbrechen beide zusammen — und im Normalfall bricht nichts
              mehr um. */}
          <span className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              // ⚠️ Der Knopf ist stumm, solange nichts zu speichern ist, und
              // NICHT ausgegraut, weil es nichts zu tun gäbe: hier gibt es etwas
              // zu tun, sobald ein Zeichen anders ist. Das ist der Unterschied
              // zu einem toten Knopf aus D3 — dieser wird lebendig, ohne dass
              // der Betreiber woanders hin muss.
              disabled={busy || !changed}
              onClick={save}
              data-testid={`mark-save-${mark.id}`}
            >
              {busy ? t("loading") : t("settingsMarkSave")}
            </Button>
            <RemoveMarkDialog mark={mark} onRemoved={onRemoved} />
          </span>
        </>
      ) : null}

      {error ? (
        <span role="alert" className="text-[13px] text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
