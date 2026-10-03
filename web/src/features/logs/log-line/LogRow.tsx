import { memo, type CSSProperties } from "react";

import type { LogLine } from "../api";
import { parseAnsi, stripAnsi, type AnsiSegment } from "./ansi";
import { detectLevel, type LevelMatch, type LogLevel } from "./log-level";

// Eine Zeile des Log-Felds — geteilt vom Log-Reiter des Containers und dem
// Protokoll des Stacks.
//
// ⚠️ FARBE TRÄGT DREI AUSKÜNFTE UND KEINE VIERTE (Vorbild: Dozzle, Wunsch des
// Betreibers vom 2026-09-29): die Stufe als Streifen am linken Rand und am
// Wort selbst, der Dienst in seiner eigenen Farbe, und die Farben, die der
// Dienst selbst in seine Zeile geschrieben hat. Der Kanal (stdout/stderr)
// färbt die Zeile NICHT mehr rot: AdGuard Home schreibt sein ganzes Log nach
// stderr, und ein Feld, in dem jede Zeile rot ist, sagt über keine etwas.
// stderr bleibt am Merkmal `data-stream` stehen und zeigt sich als blasser
// Streifen, wo keine Stufe erkannt wurde.
//
// ⚠️ `memo` IST HIER KEINE FEINHEIT. Jede neue Zeile zeichnet das Feld neu, und
// das Feld hält bis zu 5000 Zeilen; ohne `memo` liefe die ANSI-Zerlegung für
// alle 5000 bei jeder einzelnen, die ankommt. Die Zeilenobjekte bleiben im
// Zustand dieselben, und `memo` erkennt sie daran wieder.

const LEVEL_COLOR: Record<LogLevel, string> = {
  error: "var(--state-down)",
  warn: "var(--state-warn)",
  info: "var(--terminal-ansi-blue)",
  debug: "var(--subtle-foreground)"
};

const STDERR_MARK = "color-mix(in oklch, var(--state-down) 45%, transparent)";

/**
 * Der Zeitstempel, gekürzt auf Millisekunden und mit Leerzeichen statt `T`.
 *
 * ⚠️ GEKÜRZT UND NICHT UMGERECHNET. Die Zeitzone bleibt die des Arms (UTC, das
 * `Z` steht dabei); in eine andere umgerechnet wäre er eine zweite Wahrheit
 * neben jedem `docker logs`. Der volle Wert mit Nanosekunden steht in
 * `dateTime` und im `title`.
 */
export function shortTime(ts: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(ts);
  if (match === null) return ts;
  const fraction = (match[3] ?? "").padEnd(3, "0").slice(0, 3);
  return `${match[1]} ${match[2]}.${fraction}Z`;
}

/**
 * Hebt das Wort der Stufe hervor — aber nur, wo der Dienst selbst keine Farbe
 * gesetzt hat. Seine eigene gewinnt.
 */
function markLevel(segments: AnsiSegment[], level: LevelMatch | null): AnsiSegment[] {
  if (level === null) return segments;
  const result: AnsiSegment[] = [];
  let offset = 0;
  for (const segment of segments) {
    const from = offset;
    const to = offset + segment.text.length;
    offset = to;
    if (to <= level.start || from >= level.end || segment.style.fg !== null) {
      result.push(segment);
      continue;
    }
    const cutStart = Math.max(level.start, from) - from;
    const cutEnd = Math.min(level.end, to) - from;
    if (cutStart > 0) result.push({ text: segment.text.slice(0, cutStart), style: segment.style });
    result.push({
      text: segment.text.slice(cutStart, cutEnd),
      style: { ...segment.style, fg: LEVEL_COLOR[level.level], bold: true }
    });
    if (cutEnd < segment.text.length) result.push({ text: segment.text.slice(cutEnd), style: segment.style });
  }
  return result;
}

function segmentStyle(segment: AnsiSegment): CSSProperties | undefined {
  const { fg, bg, bold, dim, italic, underline } = segment.style;
  if (fg === null && bg === null && !bold && !dim && !italic && !underline) return undefined;
  return {
    color: fg ?? undefined,
    backgroundColor: bg ?? undefined,
    fontWeight: bold ? 600 : undefined,
    opacity: dim ? 0.7 : undefined,
    fontStyle: italic ? "italic" : undefined,
    textDecoration: underline ? "underline" : undefined
  };
}

type LogRowProps = {
  line: LogLine;
  /** `log-line` im Container, `stack-log-line` im Stack — die Tests lesen daran. */
  testId: string;
  /**
   * Nur im Stack: der Dienst und seine Farbe. Zwei Zeichenketten und kein
   * Objekt — ein neues Objekt je Zeichnung hebelte `memo` aus.
   */
  service?: string;
  serviceColor?: string;
};

export const LogRow = memo(function LogRow({ line, testId, service, serviceColor }: LogRowProps) {
  const segments = parseAnsi(line.text);
  const level = detectLevel(segments.length === 1 ? segments[0].text : stripAnsi(line.text));
  const mark = level !== null ? LEVEL_COLOR[level.level] : line.stream === "stderr" ? STDERR_MARK : "transparent";
  return (
    <div
      className="flex gap-2 whitespace-pre-wrap break-all border-l-2 py-px pl-1.5"
      style={{
        borderLeftColor: mark,
        backgroundColor:
          level?.level === "error" ? "color-mix(in oklch, var(--state-down) 9%, transparent)" : undefined
      }}
      data-testid={testId}
      data-stream={line.stream}
      data-level={level?.level ?? "none"}
      data-service={service}
    >
      <time
        dateTime={line.ts}
        title={line.ts}
        className="shrink-0 text-subtle-foreground"
        data-testid="log-line-time"
      >
        {shortTime(line.ts)}
      </time>
      {service === undefined ? null : (
        <span className="w-28 shrink-0 truncate font-medium" style={{ color: serviceColor }} title={service}>
          {service}
        </span>
      )}
      <span className="min-w-0 text-foreground" data-testid="log-line-text">
        {markLevel(segments, level).map((segment, index) => (
          <span key={index} style={segmentStyle(segment)}>
            {segment.text}
          </span>
        ))}
      </span>
    </div>
  );
});
