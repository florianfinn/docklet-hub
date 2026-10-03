// English texts of the feature `logs` (#258). The reasons stand next to the
// German texts (`de.ts`); here is only the translation.
//
// `satisfies typeof deLogs`: only on an object literal does TypeScript
// check for excess properties.

import type { deLogs } from "./de";

export const enLogs = {
  stackLogsPickLabel: "Containers in this stream",
  stackLogsPickHint: "Every selected container is a stream of its own from the arm. A click takes it out or back in.",

  stackLogsNoneSelected: "No container selected. As soon as one is selected above, its lines appear here.",
  stackLogsNoContainers: "This stack has no container whose log can be read here.",
  stackLogsWaiting: "The streams are open. None of the selected containers has said anything yet.",
  stackLogsLinesLabel: "Merged log stream of this stack",
  stackLogsSourceProblem: "{service}: {message}",
  stackLogsSourceEnded: "{service}: The stream has ended. The container is no longer talking.",

  // ── Die Log-Ansicht (#5, Etappe H) ───────────────────────────────────────
  //
  // Dieselben Schlüssel wie in `de.ts`. ⚠️ Kein Apostroph in einem Wert: der
  // Wächter `languages` weist ein einzelnes Anführungszeichen ab, und in ICU
  // ist es zugleich das Fluchtzeichen. Deshalb steht unten „does not" und
  // nirgends die zusammengezogene Form.
  logViewLoading: "Loading the log view …",
  logConnecting: "Opening the stream …",
  logWaiting: "The stream is open. This container has not said anything yet.",
  logEnded: "The stream has ended. The container is no longer talking.",
  logStreamFailed: "The stream ended unexpectedly ({reason}).",
  logStreamFailedWithoutReason: "The stream ended unexpectedly without naming a reason.",
  logStreamFailedContainerGone: "This container no longer exists. It disappeared while the log was running.",
  logStreamFailedEngineRefused:
    "The Docker engine on the arm refused the log. The reason is in its audit log on the target host.",
  logStreamFailedEngineUnreachable:
    "The arm lost its connection to its Docker engine. Usually the daemon is restarting — wait and reconnect.",
  logStreamFailedUnreadable: "The arm could not read the log. The cause is in its audit log on the target host.",
  logStreamFailedHubBroken:
    "The connection from the hub to the arm broke mid-log. The arm itself may still be running — reconnect.",
  logLineCount: "{count, plural, one {# line} other {# lines}}",
  logFilterLabel: "Filter lines",
  logFilterPlaceholder: "Text contained in the line",
  logFilterHint:
    "The filter only hides the display. The arm keeps sending everything, and a hidden line is back without a new request.",
  logFilterEmpty: "None of the held lines contains this text.",
  logJumpToEnd: "Jump to the end",
  logReconnect: "Reconnect",
  logTrimmed: "Older lines have been dropped: this view holds at most {count} lines.",
  logErrorInvalidTail: "The requested number of lines is outside 1 to 2000. The hub rejected the request.",
  logErrorForbidden:
    "The arm refused access to this log. Most common case: the container is not on its allowlist — for example because it is managed elsewhere. The decision is in the log of the arm.",
  logErrorAgentOutdated:
    "The agent of this arm speaks an older protocol, so its log would arrive empty. Once it has moved to the new version (see the note on its card under Hosts) the log is back.",
  logErrorHostUnknown: "This arm no longer exists. It was most likely removed while this view was open.",
  logErrorTooManyStreams:
    "The arm is already running as many concurrent streams as it allows. Closing one log tab frees a slot right away.",
  logErrorUnreachable: "The arm does not answer. The hub could not fetch the log.",
  logErrorUnknown: "The log could not be opened.",

  // Die Tafel „Logansicht" (#5, Etappe H) — dieselben Schlüssel wie in
  // `de.ts`. Kein Apostroph in einem Wert: der Wächter `languages` weist ein
  // einzelnes Anführungszeichen ab, und in ICU ist es zugleich das
  // Fluchtzeichen.
  settingsLogsTitle: "Log view",
  settingsLogsHint:
    "How many lines of history a log view shows when it opens. The setting applies to every arm and every user; more lines mean a longer wait until the first picture stands.",
  settingsLogsTailLinesLabel: "Lines on opening",
  settingsLogsTailLinesOption: "{count, plural, one {# line} other {# lines}}",
  settingsLogsTailLinesHint:
    "There is nothing above 2000 lines: the agent cuts its excerpt there. A larger number would be a promise the other side does not keep.",
  settingsLogsSave: "Save",
  settingsLogsSaved: "saved",
  settingsLogsFailed: "The number of lines could not be saved.",
} satisfies typeof deLogs;
