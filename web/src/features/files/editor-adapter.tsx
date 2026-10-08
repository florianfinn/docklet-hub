import { MAX_TEXT_BYTES } from "contract";
import type { EditorAdapter } from "../../platform/editor/EditorShell";
import { highlightLines } from "../../platform/editor/yaml-highlight";
import { CodeLine } from "../../platform/editor/CodeLine";
export const fileEditorAdapter: EditorAdapter = { maxBytes: MAX_TEXT_BYTES, ranges: () => [] };
export function fileEditorAdapterFor(path: string): EditorAdapter {
  if (/\.ya?ml$/i.test(path)) return { ...fileEditorAdapter, highlight: (text) => highlightLines(text).map((pieces, index) => <CodeLine key={index} pieces={pieces} />) };
  if (/(?:^|\/)\.env(?:\.[^/]*)?$/i.test(path)) return { ...fileEditorAdapter, highlight: (text) => text.split("\n").map((line, index) => {
    const match = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.]*)(\s*=.*)$/.exec(line);
    return match ? <span key={index}><span className="editor-syntax-key">{match[1]}</span>{match[2]}</span> : line || "\u200b";
  }) };
  return fileEditorAdapter;
}
