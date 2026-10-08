export type MaskRange = { id: string; label: string; start: number; end: number };
export const MASK = "••••••••";
export function maskProjection(value: string, ranges: readonly MaskRange[], revealed: ReadonlySet<string>) {
  let cursor = 0;
  let text = "";
  const spans: { start: number; end: number; rawStart: number; rawEnd: number }[] = [];
  for (const range of ranges.filter((entry) => !revealed.has(entry.id)).sort((a, b) => a.start - b.start)) {
    if (range.start < cursor || range.end < range.start || range.end > value.length) continue;
    text += value.slice(cursor, range.start);
    const start = text.length;
    text += MASK;
    spans.push({ start, end: text.length, rawStart: range.start, rawEnd: range.end });
    cursor = range.end;
  }
  return { text: text + value.slice(cursor), spans };
}
export function applyMaskedEdit(value: string, previous: ReturnType<typeof maskProjection>, next: string): string {
  let start = 0;
  while (start < previous.text.length && start < next.length && previous.text[start] === next[start]) start++;
  let end = previous.text.length;
  let nextEnd = next.length;
  while (end > start && nextEnd > start && previous.text[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
  if (previous.spans.some((span) => start < span.end && end > span.start || start === end && start > span.start && start < span.end)) return value;
  const rawPosition = (position: number) => position + previous.spans.filter((span) => span.end <= position)
    .reduce((offset, span) => offset + (span.rawEnd - span.rawStart) - (span.end - span.start), 0);
  return value.slice(0, rawPosition(start)) + next.slice(start, nextEnd) + value.slice(rawPosition(end));
}
export function textWithinLimit(value: string, maxBytes: number): boolean {
  const bytes = new TextEncoder().encode(value);
  return !value.includes("\0") && bytes.length <= maxBytes && new TextDecoder().decode(bytes) === value;
}
