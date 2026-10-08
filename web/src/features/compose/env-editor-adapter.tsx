import { MAX_COMPOSE_BYTES } from "contract";
import type { EditorAdapter } from "../../platform/editor/EditorShell";
import { MASK } from "../../platform/editor/masking";
import { envMaskRanges } from "./editor-masks";
export function parseEnvEditor(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) throw new Error("invalid-env-value");
    let raw = match[2];
    if (raw.startsWith("'") && !raw.endsWith("'")) throw new Error("invalid-env-value");
    if (!raw.startsWith("'") && !raw.startsWith('"')) { const comment = raw.search(/\s#/); if (comment >= 0) raw = raw.slice(0, comment).trimEnd(); }
    values[match[1]] = raw.startsWith('"') ? JSON.parse(raw) as string : raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
  }
  return values;
}
export function envEditorContent(entries: readonly { key: string; value?: string; empty: boolean }[]): string {
  return entries.map((entry) => `${entry.key}=${entry.value !== undefined ? JSON.stringify(entry.value) : entry.empty ? '""' : MASK}`).join("\n");
}
export const envEditorAdapter: EditorAdapter = {
  maxBytes: MAX_COMPOSE_BYTES,
  ranges: (content) => {
    const known = envMaskRanges(content);
    let offset = 0;
    for (const line of content.split("\n")) {
      const match = /^([\w]+)=••••••••$/.exec(line);
      if (match && !known.some((range) => range.label === match[1])) known.push({ id: match[1], label: match[1], start: offset + line.indexOf("=") + 1, end: offset + line.length });
      offset += line.length + 1;
    }
    return known;
  },
  highlight: (content) => content.split("\n").map((line, index) => {
    const separator = line.indexOf("=");
    return separator < 0 ? line || "\u200b" : <span key={index}><span className="editor-syntax-key">{line.slice(0, separator)}</span>{line.slice(separator)}</span>;
  })
};
export function envEditorChanges(content: string, entries: readonly { key: string; value?: string; empty: boolean }[]) {
  const values = parseEnvEditor(content);
  const previous = new Map(entries.map((entry) => [entry.key, entry]));
  const set: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === MASK && previous.has(key)) continue;
    if (value.includes(MASK)) throw new Error("invalid-env-value");
    const old = previous.get(key);
    if (!old || value !== old.value && !(old.empty && value === "")) set[key] = value;
  }
  return { set, remove: entries.filter((entry) => !(entry.key in values)).map((entry) => entry.key) };
}
