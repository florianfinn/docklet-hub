import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { Button } from "../ui/shadcn/button";
export function EditorConflict({ onReload, onOverwrite, busy = false, testId = "editor", children }: {
  onReload: () => void; onOverwrite: () => void; busy?: boolean; testId?: string; children?: ReactNode;
}) {
  const t = useTranslations();
  return <div role="alert" data-testid={`${testId}-conflict`} className="flex flex-col gap-2 text-state-warn">
    {children ?? <><p>{t("editorConflictTitle")}</p><p>{t("editorConflictBody")}</p></>}
    <div className="flex gap-2">
      <Button size="sm" disabled={busy} data-testid={`${testId}-conflict-reload`} onClick={onReload}>{t("editorConflictReload")}</Button>
      <Button size="sm" variant="destructive" disabled={busy} data-testid={`${testId}-conflict-overwrite`} onClick={onOverwrite}>{t("editorConflictOverwrite")}</Button>
    </div>
  </div>;
}
