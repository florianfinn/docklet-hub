import { isMap, isSeq, isScalar, parseDocument } from "yaml";
import type { MaskRange } from "../../platform/editor/masking";
const sensitive = /PASSWORD|SECRET|TOKEN|KEY/i;
export function envMaskRanges(text: string): MaskRange[] {
  const result: MaskRange[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const match = /^(?:\s*export\s+)?\s*([\w.]+)\s*=\s*(.*)$/.exec(line);
    if (match && sensitive.test(match[1]) && match[2]) {
      const start = line.indexOf("=") + 1;
      result.push({ id: match[1], label: match[1], start: offset + start, end: offset + line.length });
    }
    offset += line.length + 1;
  }
  return result;
}
export function composeMaskRanges(text: string): MaskRange[] {
  const ranges: MaskRange[] = [];
  const visit = (node: unknown, location: string) => {
    if (isMap(node)) for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : "";
      if (key === "environment") {
        if (isMap(pair.value)) for (const entry of pair.value.items) {
          const name = isScalar(entry.key) ? String(entry.key.value) : "";
          if (sensitive.test(name) && isScalar(entry.value) && entry.value.range) {
            ranges.push({ id: `${location}.${name}`, label: name, start: entry.value.range[0], end: entry.value.range[1] });
          }
        }
        if (isSeq(pair.value)) for (const entry of pair.value.items) {
          if (!isScalar(entry) || !entry.range || typeof entry.value !== "string") continue;
          const name = entry.value.split("=")[0];
          const raw = text.slice(entry.range[0], entry.range[1]);
          const equals = raw.indexOf("=");
          if (sensitive.test(name) && equals >= 0) {
            const quoted = raw.startsWith('"') || raw.startsWith("'");
            ranges.push({ id: `${location}.${name}`, label: name, start: entry.range[0] + equals + 1, end: entry.range[1] - (quoted ? 1 : 0) });
          }
        }
      } else visit(pair.value, `${location}.${key}`);
    }
    else if (isSeq(node)) node.items.forEach((entry, index) => visit(entry, `${location}.${index}`));
  };
  try { visit(parseDocument(text).contents, ""); } catch { /* Partial drafts stay editable. */ }
  // Partial YAML must not expose a value while the operator is typing.
  let environmentIndent: number | null = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    const indent = line.length - line.trimStart().length;
    if (/^\s*environment\s*:/.test(line)) environmentIndent = indent;
    else if (line.trim() && environmentIndent !== null && indent <= environmentIndent) environmentIndent = null;
    if (environmentIndent !== null) {
      const match = /^\s*(?:-\s*)?([\w.]+)\s*[:=]\s*(.*)$/.exec(line);
      if (match && sensitive.test(match[1]) && match[2]) {
        const start = offset + line.length - match[2].length;
        const end = offset + line.length;
        if (!ranges.some((range) => range.start <= start && range.end > start)) ranges.push({ id: `partial.${offset}.${match[1]}`, label: match[1], start, end });
      }
    }
    offset += line.length + 1;
  }
  return ranges;
}
