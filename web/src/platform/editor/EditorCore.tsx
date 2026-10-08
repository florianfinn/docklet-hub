import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useId, useRef } from "react";
import { useTranslations } from "use-intl";

import type { ReactNode } from "react";
import { indentEdit, outdentEdit, type IndentEdit } from "./indent";

const LAYER = "font-mono text-[12.5px] leading-[1.55] px-3 py-3";

export type EditorCoreProps = {
  value: string;
  onChange: (value: string) => void;

  disabled?: boolean;
  label: string;
  testId?: string;
  highlight?: (value: string) => ReactNode[];
};

export function EditorCore({ value, onChange, disabled = false, label, testId, highlight }: EditorCoreProps) {
  const t = useTranslations();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const paintRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const exitArmed = useRef(false);
  const nextSelection = useRef<{ start: number; end: number } | null>(null);

  const lines = highlight ? highlight(value) : value.split("\n").map((line) => line || "\u200b");
  const syncScroll = (): void => {
    const area = areaRef.current;
    if (!area) return;
    if (paintRef.current) {
      paintRef.current.scrollTop = area.scrollTop;
      paintRef.current.scrollLeft = area.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = area.scrollTop;
  };
  useEffect(() => {
    syncScroll();
    const place = nextSelection.current;
    nextSelection.current = null;
    if (place && areaRef.current) areaRef.current.setSelectionRange(place.start, place.end);
  }, [value]);

  const applyEdit = (area: HTMLTextAreaElement, edit: IndentEdit): void => {
    area.setSelectionRange(edit.from, edit.to);
    let inserted: boolean;
    try {
      inserted = document.execCommand("insertText", false, edit.text);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      area.setRangeText(edit.text, edit.from, edit.to, "end");
      onChange(area.value);
    }
    area.setSelectionRange(edit.start, edit.end);
    nextSelection.current = { start: edit.start, end: edit.end };
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Escape") {
      exitArmed.current = true;
      return;
    }
    if (event.key !== "Tab") {
      exitArmed.current = false;
      return;
    }
    if (exitArmed.current) {
      exitArmed.current = false;
      return;
    }

    const area = event.currentTarget;
    const caret = { value: area.value, start: area.selectionStart, end: area.selectionEnd };
    const edit = event.shiftKey ? outdentEdit(caret) : indentEdit(caret);
    if (edit === null) return;

    event.preventDefault();
    applyEdit(area, edit);
  };

  return (
    <div className="relative flex h-full min-h-64 overflow-hidden">
      <div
        ref={gutterRef}
        aria-hidden="true"
        className={`${LAYER} shrink-0 select-none overflow-hidden border-r border-border bg-card text-right text-subtle-foreground`}
      >
        {lines.map((_, index) => (
          <div key={index}>{index + 1}</div>
        ))}
      </div>

      <div className="relative flex-1">

        <pre
          ref={paintRef}
          aria-hidden="true"
          className={`${LAYER} pointer-events-none absolute inset-0 overflow-hidden whitespace-pre`}
        >
          {lines.map((pieces, index) => (
            <div key={index}>
              {pieces}
            </div>
          ))}
        </pre>

        <textarea
          ref={areaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onScroll={syncScroll}
          disabled={disabled}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label={label}
          aria-describedby={hintId}
          onKeyDown={onKeyDown}
          data-testid={testId}
          className={`${LAYER} relative h-full w-full resize-none overflow-auto whitespace-pre bg-transparent text-transparent caret-foreground outline-none`}
        />

        <p id={hintId} className="sr-only">
          {t("editorKeyboardHint")}
        </p>
      </div>
    </div>
  );
}
