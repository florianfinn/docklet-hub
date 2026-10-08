import { MAX_COMPOSE_BYTES } from "contract";
import type { EditorAdapter } from "../../platform/editor/EditorShell";
import { highlightLines } from "./yaml-highlight";
import { CodeLine } from "./YamlCode";
export { envMaskRanges, composeMaskRanges } from "./editor-masks";
import { composeMaskRanges } from "./editor-masks";
export const composeEditorAdapter: EditorAdapter = {
  maxBytes: MAX_COMPOSE_BYTES, ranges: composeMaskRanges,
  highlight: (text) => highlightLines(text).map((pieces, index) => <CodeLine key={index} pieces={pieces} />)
};
