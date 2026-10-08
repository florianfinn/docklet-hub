import { EditorConflict } from "../../platform/editor/EditorConflict";
import { useState, type ReactNode } from "react";
import { useTranslations } from "use-intl";
import { saveFileText } from "./api";
import { useFileText } from "./file-queries";
import { Button } from "../../platform/ui/shadcn/button";
import { Card } from "../../platform/ui/shadcn/card";
import { EditorShell } from "../../platform/editor/EditorShell";
import { useEditorDocument } from "../../platform/editor/useEditorDocument";
import { fileEditorAdapterFor } from "./editor-adapter";
import { fileChangedHash, fileErrorKey } from "./file-errors";
import { useFileSource } from "./source-context";
export function FileEditor({ hostId, containerId, path, onClose, onSaved, writable = true, sourceIdentity, syntaxPath }: {
  hostId: string; containerId: string; path: string; writable?: boolean; sourceIdentity?: string; syntaxPath?: string; onClose: () => void; onSaved: () => void;
}) {
  const t = useTranslations();
  const fileEditorAdapter = fileEditorAdapterFor(syntaxPath ?? path);
  const sourceId = useFileSource();
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);
  const text = useFileText(hostId, containerId, path, round, sourceId);
  const document = useEditorDocument(JSON.stringify([hostId, containerId, sourceIdentity ?? sourceId, path]), text.data, fileEditorAdapter.maxBytes);
  const save = (expectedHash: string) => {
    if (!writable || !document.valid || !expectedHash) return;
    setBusy(true);
    void document.save((content, hash) => saveFileText(hostId, containerId, path, content, hash, sourceId), fileChangedHash, expectedHash)
      .then((saved) => { if (saved) onSaved(); }).finally(() => setBusy(false));
  };
  const shell = (children: ReactNode) => <Card className="gap-3 border-card-line bg-body-face p-4" data-testid="files-editor">
    <div className="flex items-center justify-between gap-4">
      <p className="font-mono text-[13px] break-all" data-testid="files-editor-path">{path}</p>
      <Button type="button" size="sm" variant="ghost" data-testid="files-editor-close" disabled={busy} onClick={() => {
        if (!document.dirty || window.confirm(t("editorDiscardConfirm"))) { document.discard(); onClose(); }
      }}>{t("filesEditorClose")}</Button>
    </div>{children}
  </Card>;
  if (text.isError && !document.hasDraft) return shell(<p data-testid="files-editor-error">{t(fileErrorKey(text.error))}</p>);
  if (text.data === undefined && !document.hasDraft) return shell(<p>{t("loading")}</p>);
  return shell(<>
    {document.conflict === null ? null : <EditorConflict testId="files-editor" busy={busy}
      onReload={() => { document.discard(); setRound((current) => current + 1); }}
      onOverwrite={() => save(document.conflict!)}>
      <p>{t("filesEditorConflictTitle")}</p><p>{t("filesEditorConflictBody")}</p><p>{t("filesEditorConflictNoMerge")}</p>
    </EditorConflict>}
    {document.error === null ? null : <p data-testid="files-editor-error">{t(fileErrorKey(document.error))}</p>}
    <EditorShell key={JSON.stringify([hostId, containerId, sourceIdentity ?? sourceId, path])} value={document.content} onChange={document.edit}
      adapter={fileEditorAdapter} label={t("filesEditorLabel")} testId="files-editor-input" disabled={busy || !writable} dirty={document.dirty} />
    <div className="flex items-center gap-3">
      <Button size="sm" disabled={busy || !writable || !document.valid} data-testid="files-editor-save" onClick={() => save(document.hash)}>{t(busy ? "filesEditorSaving" : "filesEditorSave")}</Button>
      {document.saved ? <span data-testid="files-editor-saved">{t("filesEditorSaved")}</span> : null}
    </div>
  </>);
}
