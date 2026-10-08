// Two-space indentation edits preserve selection and keyboard escape.
export const INDENT_WIDTH = 2;

export type Caret = {
  value: string;

  start: number;
  end: number;
};

export type IndentEdit = {

  from: number;

  to: number;

  text: string;

  start: number;
  end: number;
};

function startOfLine(value: string, index: number): number {
  if (index <= 0) return 0;
  return value.lastIndexOf("\n", index - 1) + 1;
}

function endOfLine(value: string, index: number): number {
  const next = value.indexOf("\n", index);
  return next === -1 ? value.length : next;
}

function blockOf(caret: Caret): { from: number; to: number } {
  const { value, start, end } = caret;
  const last = end > start && end === startOfLine(value, end) ? end - 1 : end;
  return { from: startOfLine(value, start), to: endOfLine(value, last) };
}

function leadingSpaces(line: string): number {
  let count = 0;
  while (count < line.length && line[count] === " ") count += 1;
  return count;
}

export function indentEdit(caret: Caret): IndentEdit {
  const { value, start, end } = caret;

  if (!value.slice(start, end).includes("\n")) {
    const column = start - startOfLine(value, start);
    const width = INDENT_WIDTH - (column % INDENT_WIDTH);
    const text = " ".repeat(width);
    return { from: start, to: end, text, start: start + width, end: start + width };
  }

  const block = blockOf(caret);
  const text = value
    .slice(block.from, block.to)
    .split("\n")
    .map((line) => (line === "" ? line : " ".repeat(INDENT_WIDTH) + line))
    .join("\n");
  return { from: block.from, to: block.to, text, start: block.from, end: block.from + text.length };
}

export function outdentEdit(caret: Caret): IndentEdit | null {
  const { value, start, end } = caret;
  const block = blockOf(caret);
  const lines = value.slice(block.from, block.to).split("\n");
  const removedPerLine = lines.map((line) => Math.min(leadingSpaces(line), INDENT_WIDTH));
  const removed = removedPerLine.reduce((sum, count) => sum + count, 0);
  if (removed === 0) return null;

  const text = lines.map((line, index) => line.slice(removedPerLine[index])).join("\n");
  if (start === end) {
    const place = Math.max(startOfLine(value, start), start - removedPerLine[0]);
    return { from: block.from, to: block.to, text, start: place, end: place };
  }

  return { from: block.from, to: block.to, text, start: block.from, end: block.from + text.length };
}
