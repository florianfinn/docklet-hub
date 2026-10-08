import Prism from "prismjs/components/prism-core.js";
import "prismjs/components/prism-yaml.js";

export type CodePiece = { text: string; kind: string | null };

export const HIGHLIGHT_BYTE_CAP = 64 * 1024;

export function flattenTokens(nodes: unknown, inherited: string | null, into: CodePiece[]): void {
  if (typeof nodes === "string") {
    if (nodes !== "") into.push({ text: nodes, kind: inherited });
    return;
  }
  if (Array.isArray(nodes)) {
    for (const node of nodes) flattenTokens(node, inherited, into);
    return;
  }
  if (typeof nodes !== "object" || nodes === null) return;
  const token = nodes as { type?: unknown; alias?: unknown; content?: unknown };
  const kind =
    typeof token.alias === "string"
      ? token.alias
      : typeof token.type === "string"
        ? token.type
        : inherited;
  flattenTokens(token.content, kind, into);
}

export function highlightLines(text: string): CodePiece[][] {
  const plain = (): CodePiece[][] =>
    text.split("\n").map((line) => (line === "" ? [] : [{ text: line, kind: null }]));

  if (new TextEncoder().encode(text).length > HIGHLIGHT_BYTE_CAP) return plain();

  let pieces: CodePiece[];
  try {
    pieces = [];
    flattenTokens(Prism.tokenize(text, Prism.languages.yaml), null, pieces);
  } catch {
    return plain();
  }

  const lines: CodePiece[][] = [[]];
  for (const piece of pieces) {
    const parts = piece.text.split("\n");
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) lines.push([]);
      if (parts[index] !== "") lines[lines.length - 1].push({ text: parts[index], kind: piece.kind });
    }
  }
  return lines.map(markVariables);
}

function markVariables(pieces: CodePiece[]): CodePiece[] {
  const line = pieces.map((piece) => piece.text).join("");
  const pattern = /\$\$|\$\{[A-Za-z_][A-Za-z0-9_]*[^}\n]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g;
  const ranges: { start: number; end: number }[] = [];
  let tokenIndex = 0;
  let tokenStart = 0;

  for (const match of line.matchAll(pattern)) {
    if (match[0] === "$$") continue;
    const start = match.index;
    while (tokenIndex < pieces.length && tokenStart + pieces[tokenIndex].text.length <= start) {
      tokenStart += pieces[tokenIndex].text.length;
      tokenIndex += 1;
    }
    if (pieces[tokenIndex]?.kind !== "comment") ranges.push({ start, end: start + match[0].length });
  }

  if (ranges.length === 0) return pieces;

  const marked: CodePiece[] = [];
  let position = 0;
  let rangeIndex = 0;
  for (const piece of pieces) {
    let used = 0;
    while (used < piece.text.length) {
      while (rangeIndex < ranges.length && ranges[rangeIndex].end <= position) rangeIndex += 1;
      const range = ranges[rangeIndex];
      const variable = range !== undefined && range.start <= position;
      const boundary = range === undefined ? Infinity : variable ? range.end : range.start;
      const length = Math.min(piece.text.length - used, boundary - position);
      marked.push({ text: piece.text.slice(used, used + length), kind: variable ? "variable" : piece.kind });
      used += length;
      position += length;
    }
  }
  return marked;
}

export function classOfKind(kind: string | null): string {
  switch (kind) {
    case "comment":
      return "text-muted-foreground";
    case "atrule":
    case "key":
      return "editor-syntax-key";
    case "string":
      return "editor-syntax-string";
    case "number":
    case "boolean":
    case "null":
    case "datetime":
      return "editor-syntax-literal";
    case "tag":
    case "important":
    case "directive":
      return "editor-syntax-special";
    case "anchor":
      return "editor-syntax-anchor";
    case "variable":
      return "editor-syntax-variable";
    case "punctuation":
      return "text-subtle-foreground";
    default:
      return "";
  }
}
