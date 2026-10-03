// Die Stufe einer Logzeile (Fehler, Warnung, Info, Debug), aus ihrem Text
// erraten.
//
// ⚠️ GERATEN, NICHT GELESEN. Docker kennt keine Stufe, nur stdout und stderr —
// und stderr heißt nicht Fehler: AdGuard Home schreibt sein ganzes Log nach
// stderr, auch `[info]`. Bis hierher stand deshalb jede Zeile von AdGuard rot
// da. Die Stufe steht im Text, in der Form, die der jeweilige Logger wählt;
// erkannt werden die verbreiteten, gemessen an den Zeilen der Arme am
// 2026-09-29:
//
//   `[error] dnsproxy: …`                 AdGuard Home
//   `[Info] RssSyncService: …`            radarr, sonarr, prowlarr
//   `… debug[Jobs]: …`                    overseerr (winston, nach dem ANSI-Abzug)
//   `level=warn msg=…`                    logfmt (Go)
//   `{"level":"error",…}`                 JSON-Logger
//   `[INF]` / `[WRN]` / `[ERR]`           Serilog
//
// Gesucht wird nur am Anfang der Zeile: weiter hinten ist „error" eher ein
// Wort der Nachricht („… with error: …") als ihre Stufe. Das erste Wort, das
// passt, gilt.

export type LogLevel = "error" | "warn" | "info" | "debug";

/** Wie weit vorn die Stufe stehen muss. Ein Zeitstempel und ein Name passen davor. */
const SEARCH_WINDOW = 160;

const LEVEL_BY_WORD: Record<string, LogLevel> = {
  fatal: "error",
  panic: "error",
  crit: "error",
  critical: "error",
  emerg: "error",
  error: "error",
  err: "error",
  eror: "error",
  ftl: "error",
  warning: "warn",
  warn: "warn",
  wrn: "warn",
  info: "info",
  inf: "info",
  notice: "info",
  debug: "debug",
  dbg: "debug",
  trace: "debug",
  trc: "debug",
  verbose: "debug",
  vrb: "debug"
};

// ⚠️ DAS WORT BRAUCHT EINE GRENZE AUF BEIDEN SEITEN, und zwar eine aus
// Satzzeichen oder Leerraum. Ohne sie träfe „inf" in „information" und „err"
// in „stderr".
const LEVEL_PATTERN = new RegExp(
  `(?:^|[\\s[(<|:"'=,])(${Object.keys(LEVEL_BY_WORD).join("|")})(?=$|[\\s\\])>|:"',.[])`,
  "i"
);

export type LevelMatch = { level: LogLevel; start: number; end: number };

/** Die Stufe und wo ihr Wort im (ANSI-freien) Text steht — oder `null`. */
export function detectLevel(plain: string): LevelMatch | null {
  const window = plain.slice(0, SEARCH_WINDOW);
  const match = LEVEL_PATTERN.exec(window);
  if (match === null) return null;
  const word = match[1];
  const start = match.index + match[0].length - word.length;
  return { level: LEVEL_BY_WORD[word.toLowerCase()], start, end: start + word.length };
}
