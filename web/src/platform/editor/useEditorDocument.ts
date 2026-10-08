import { useState } from "react";
import { textWithinLimit } from "./masking";
export type EditorContent = { content: string; hash: string };
export type Draft = { content: string; hash: string; base: string; conflict: string | null; saved: boolean; error: unknown };
const retainedDrafts = new Map<string, Draft>();
export function clearEditorDrafts(): void { retainedDrafts.clear(); }
export function useEditorDocument(target: string, loaded: EditorContent | undefined, maxBytes: number) {
  // Drafts stay in memory and are bound to the complete target identity.
  const [documents, setDocuments] = useState<Map<string, Draft>>(() => new Map());
  const stored = documents.get(target) ?? retainedDrafts.get(target);
  const initial: Draft = { content: loaded?.content ?? "", hash: loaded?.hash ?? "", base: loaded?.content ?? "", conflict: null, saved: false, error: null };
  const document = stored ?? initial;
  const patch = (change: Partial<Draft>) => setDocuments((current) => {
    const next = { ...(current.get(target) ?? retainedDrafts.get(target) ?? initial), ...change };
    if (next.content !== next.base) retainedDrafts.set(target, next); else retainedDrafts.delete(target);
    return new Map(current).set(target, next);
  });
  return {
    ...document, dirty: document.content !== document.base, hasDraft: stored !== undefined,
    valid: textWithinLimit(document.content, maxBytes),
    edit: (content: string) => patch({ content, saved: false }),
    discard: () => { retainedDrafts.delete(target); setDocuments((current) => { const next = new Map(current); next.delete(target); return next; }); },
    conflictWith: (hash: string) => patch({ conflict: hash }),
    failed: (error: unknown) => patch({ error }),
    savedAs: (content: string, hash: string) => patch({ content, hash, base: content, conflict: null, error: null, saved: true }),
    clearError: () => patch({ error: null, conflict: null, saved: false }),
    save: async (writer: (content: string, expectedHash: string) => Promise<{ hash: string }>, conflictHash: (error: unknown) => string | null, expectedHash = document.hash) => {
      if (!textWithinLimit(document.content, maxBytes) || !expectedHash) return false;
      patch({ error: null, conflict: null, saved: false });
      try {
        const saved = await writer(document.content, expectedHash);
        patch({ hash: saved.hash, base: document.content, conflict: null, saved: true });
        return true;
      } catch (error) {
        const conflict = conflictHash(error);
        patch(conflict ? { conflict } : { error });
        return false;
      }
    }
  };
}
