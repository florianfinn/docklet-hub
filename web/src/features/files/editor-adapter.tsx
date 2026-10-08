import { MAX_TEXT_BYTES } from "contract";
import type { EditorAdapter } from "../../platform/editor/EditorShell";
import { highlightLines } from "../../platform/editor/yaml-highlight";
import { CodeLine } from "../../platform/editor/CodeLine";
export const fileEditorAdapter: EditorAdapter = { maxBytes: MAX_TEXT_BYTES, ranges: () => [], highlight: (text) => highlightLines(text).map((pieces, index) => <CodeLine key={index} pieces={pieces} />) };
