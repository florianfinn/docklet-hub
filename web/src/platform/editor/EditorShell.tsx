import { useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "use-intl";
import { Button } from "../ui/shadcn/button";
import { EditorCore } from "./EditorCore";
import { applyMaskedEdit, maskProjection, textWithinLimit, type MaskRange } from "./masking";

export type EditorAdapter = {
  maxBytes: number;
  ranges: (text: string) => readonly MaskRange[];
  highlight?: (text: string) => ReactNode[];
};
export function EditorShell({ value, onChange, adapter, label, testId, disabled = false, dirty = false, onReveal }: {
  value: string; onChange: (value: string) => void; adapter: EditorAdapter;
  label: string; testId?: string; disabled?: boolean; dirty?: boolean; onReveal?: (id: string) => Promise<void>;
}) {
  const t = useTranslations();
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  const [revealFailed, setRevealFailed] = useState(false);
  const [tooLarge, setTooLarge] = useState(false);
  const ranges = adapter.ranges(value);
  const projection = maskProjection(value, ranges, revealed);
  const valid = textWithinLimit(value, adapter.maxBytes);
  useEffect(() => {
    if (!dirty) return;
    const leaving = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, [dirty]);
  return <div className="flex h-full flex-col">
    {ranges.length === 0 ? null : <div className="flex flex-wrap gap-2 p-2">
      {ranges.map((range) => <Button key={range.id} size="sm" variant="outline" onClick={() => {
        const reveal = !revealed.has(range.id);
        void (reveal && onReveal ? onReveal(range.id) : Promise.resolve()).then(() => setRevealed((current) => {
        const next = new Set(current);
        if (next.has(range.id)) next.delete(range.id); else next.add(range.id);
        return next;
      })).catch(() => setRevealFailed(true));
      }}>{t(revealed.has(range.id) ? "editorHideValue" : "editorRevealValue", { key: range.label })}</Button>)}
    </div>}
    {revealFailed ? <p role="alert">{t("editorRevealFailed")}</p> : null}
    {tooLarge || !valid ? <p role="alert">{t("editorInvalidText")}</p> : null}
    {dirty ? <span className="sr-only">{t("editorDirty")}</span> : null}
    <EditorCore value={valid ? projection.text : ""} label={label} testId={testId} disabled={disabled || !valid}
      highlight={adapter.highlight} onChange={(next) => {
        const raw = applyMaskedEdit(value, projection, next);
        const accepted = textWithinLimit(raw, adapter.maxBytes);
        setTooLarge(!accepted);
        if (accepted) onChange(raw);
      }} />
  </div>;
}
