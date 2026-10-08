import { useState } from "react";
import { useTranslations } from "use-intl";
import { ApiError, errorCode } from "../../platform/http/transport";
import { Button } from "../../platform/ui/shadcn/button";
import { EditorShell } from "../../platform/editor/EditorShell";
import { EditorConflict } from "../../platform/editor/EditorConflict";
import { useEditorDocument } from "../../platform/editor/useEditorDocument";
import { composeErrorKey } from "./compose-errors";
import { useProjectEnv, useRevealEnv } from "./compose-queries";
import { envEditorAdapter, envEditorChanges, envEditorContent, parseEnvEditor } from "./env-editor-adapter";
import { saveProjectEnv } from "./api";
import { MASK } from "../../platform/editor/masking";
function conflictHash(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  try {
    const body = JSON.parse(error.message) as { reason?: string; error?: string; actualHash?: string };
    return body.reason === "file-changed-externally" || body.error === "file-changed-externally" ? body.actualHash ?? null : null;
  } catch { return null; }
}
export function EnvView({ hostId, containerId }: { hostId: string; containerId: string }) {
  const t = useTranslations();
  const masked = useProjectEnv(hostId, containerId);
  const reveal = useRevealEnv(hostId, containerId);
  const [busy, setBusy] = useState(false);
  const [revealedByTarget, setRevealedByTarget] = useState<Record<string, Record<string, string>>>({});
  const env = masked.data;
  const documentTarget = JSON.stringify([hostId, containerId, env?.projectDir, ".env"]);
  const revealedValues = revealedByTarget[documentTarget] ?? {};
  const entries = env?.entries.map((entry) => Object.prototype.hasOwnProperty.call(revealedValues, entry.key) ? { ...entry, value: revealedValues[entry.key] } : entry) ?? [];
  const document = useEditorDocument(documentTarget, env ? { content: envEditorContent(entries), hash: env.envHash ?? (env.filePresent ? "" : "absent") } : undefined, envEditorAdapter.maxBytes);
  const failure = reveal.error ?? masked.error;
  if (failure && !document.hasDraft) return <p className="p-4 text-sm text-destructive">{t(errorCode(failure) === "hub-own-stack" ? "composeEnvOwnStack" : composeErrorKey(failure))}</p>;
  if (!env) return <p className="p-4">{t("loading")}</p>;
  const save = (expectedHash: string) => {
    setBusy(true);
    void document.save(async (content, hash) => {
      const changes = envEditorChanges(content, entries);
      return saveProjectEnv(hostId, containerId, { ...changes, expectedEnvHash: hash === "absent" ? null : hash });
    }, conflictHash, expectedHash).finally(() => setBusy(false));
  };
  return <div className="flex min-h-[40vh] flex-col gap-2 p-3">
    {!env.filePresent ? <p>{t("composeEnvMissing")}</p> : null}
    {document.conflict === null ? null : <EditorConflict testId="env-editor" busy={busy}
      onReload={() => { document.discard(); reveal.reset(); void masked.refetch(); }}
      onOverwrite={() => save(document.conflict!)} />}
    {document.error === null ? null : <p role="alert">{t(composeErrorKey(document.error))}</p>}
    <div data-testid="compose-env-content">
      <EditorShell key={documentTarget} value={document.content} onChange={document.edit} adapter={envEditorAdapter} label={t("composeEnvFileName")}
        testId="env-editor" dirty={document.dirty} disabled={busy} onReveal={async (id) => {
          const plaintext = await reveal.mutateAsync();
          const selected = plaintext.entries.find((entry) => entry.key === id);
          if (!selected || selected.value === undefined) throw new Error("reveal-unavailable");
          setRevealedByTarget((current) => ({ ...current, [documentTarget]: { ...current[documentTarget], [id]: selected.value! } }));
          if (document.hasDraft) {
            const values = parseEnvEditor(document.content);
            if (values[id] === MASK) values[id] = selected.value;
            document.edit(envEditorContent(Object.entries(values).map(([key, value]) => ({ key, value, empty: !value }))));
          }
        }} />
    </div>
    <Button size="sm" disabled={busy || !document.dirty || !document.valid || !document.hash} data-testid="env-editor-save" onClick={() => save(document.hash)}>{t(busy ? "editorSaving" : "editorSave")}</Button>
    {document.saved ? <p>{t("editorSaved")}</p> : null}
    <p className="text-xs text-muted-foreground">{t("composeEnvParsedNote")}</p>
  </div>;
}
