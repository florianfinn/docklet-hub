import { useState } from "react";
import { useTranslations } from "use-intl";

import { MARK_NAME_MAX, type MarkView } from "contract";

import { Button } from "../../platform/ui/shadcn/button";
import { Input } from "../../platform/ui/shadcn/input";
import { Label } from "../../platform/ui/shadcn/label";
import { createMark } from "./api";
import { describeCreateMarkError } from "./mark-errors";
import { StyleSelect, ToneSelect, type MarkDraft } from "./mark-fields";

/** Das Feld für die erste und für jede weitere Marke. */
export function NewMarkForm({ onCreated }: { onCreated: (mark: MarkView) => void }) {
  const t = useTranslations();
  const [draft, setDraft] = useState<MarkDraft>({ name: "", hue: "neutral", style: "label" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ⚠️ Der Vorgabewert `neutral`/`label` ist NICHT abgeschrieben, sondern
  // `DEFAULT_MARK_THEME` aus `presets.ts` — er steht hier trotzdem als
  // Literal, weil der Zustand einen Startwert braucht und ein Import des
  // Objekts denselben zwei Werten einen zweiten Namen gäbe. Der Typ hält
  // beides zusammen: eine Stufe, die es nicht gibt, ist ein Typfehler.

  const create = () => {
    const name = draft.name.trim();
    if (name === "") {
      setError(t("settingsMarkNameEmpty"));
      return;
    }
    setBusy(true);
    setError(null);
    createMark({ name, hue: draft.hue, style: draft.style })
      .then((created) => {
        onCreated(created);
        // Das Feld leert sich, die STUFEN bleiben stehen: wer drei Marken in
        // Türkis anlegt, wählt den Ton einmal.
        setDraft((current) => ({ ...current, name: "" }));
      })
      .catch((cause: unknown) => setError(describeCreateMarkError(t, cause)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-dashed border-border px-3 py-3">
      <span className="text-[13px] font-medium">{t("settingsMarkNew")}</span>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mark-new-name" className="text-[12px] font-normal text-muted-foreground">
            {t("settingsMarkName")}
          </Label>
          <Input
            id="mark-new-name"
            value={draft.name}
            maxLength={MARK_NAME_MAX}
            placeholder={t("settingsMarkNamePlaceholder")}
            data-testid="mark-new-name"
            className="h-8 w-[12rem]"
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            onKeyDown={(event) => {
              // Die Eingabetaste im Namensfeld legt an. Ohne sie müsste die
              // Hand für jede Marke von der Tastatur zur Maus.
              if (event.key === "Enter" && !busy) create();
            }}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-muted-foreground">{t("settingsMarkHue")}</span>
          <ToneSelect
            draft={draft}
            label={t("settingsMarkHue")}
            onChange={(hue) => setDraft((current) => ({ ...current, hue }))}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-muted-foreground">{t("settingsMarkStyle")}</span>
          <StyleSelect
            draft={draft}
            label={t("settingsMarkStyle")}
            onChange={(style) => setDraft((current) => ({ ...current, style }))}
          />
        </div>

        <Button type="button" size="sm" disabled={busy} onClick={create} data-testid="mark-add">
          {busy ? t("loading") : t("settingsMarkAdd")}
        </Button>
      </div>

      {error ? (
        <span role="alert" className="text-[13px] text-destructive" data-testid="mark-new-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
