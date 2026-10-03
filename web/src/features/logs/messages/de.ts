// German texts of the feature `logs` (#258): the log view of a container,
// the "Logs" tab of a stack and the log settings panel. German is the
// source of the message type; `en.ts` closes with `satisfies typeof deLogs`.
//
// Put together with the texts of every other surface in
// `web/src/app/i18n/messages.ts`; `platform/` may not import a feature.

export const deLogs = {
  // Die Auswahl über dem Strom.
  stackLogsPickLabel: "Container in diesem Strom",
  // Seit dem 2026-09-29 ohne Obergrenze; bis dahin stand hier „Höchstens
  // vier“ samt Grund.
  stackLogsPickHint:
    "Jeder gewählte Container ist ein eigener Strom vom Arm. Ein Klick nimmt ihn heraus oder wieder hinein.",

  // Der Zustand des gemischten Stroms.
  stackLogsNoneSelected: "Kein Container gewählt. Sobald oben einer gewählt ist, erscheinen seine Zeilen hier.",
  stackLogsNoContainers: "Dieser Stack hat keinen Container, dessen Log sich hier lesen lässt.",
  stackLogsWaiting: "Die Ströme stehen. Noch hat keiner der gewählten Container etwas gesagt.",
  stackLogsLinesLabel: "Gemischter Log-Strom dieses Stacks",
  // Ein Fehler EINES Stroms, mit dem Dienst davor: bei vier offenen Strömen
  // sagt ein Satz ohne Namen nicht, welcher gemeint ist.
  stackLogsSourceProblem: "{service}: {message}",
  stackLogsSourceEnded: "{service}: Der Strom ist zu Ende. Der Container redet nicht mehr.",

  // ── Die Log-Ansicht (#5, Etappe H) ───────────────────────────────────────
  //
  // Das Bauteil `LogView` (web/src/features/logs/LogView.tsx) und sonst
  // nichts. Die Schlüssel der Container-Detailseite legt Etappe H3 an; hier
  // steht nur, was diese Ansicht selbst zeigt.
  //
  // ⚠️ FÜNF EIGENE FEHLERTEXTE UND KEIN „Es ist ein Fehler aufgetreten". Die
  // fünf Fälle, die der Hub VOR der ersten Zeile als Statuscode schickt, haben
  // je eine andere Antwort auf die Frage „und jetzt?" — ein gemeinsamer Satz
  // wäre für alle fünf keine Auskunft.
  // The fallback while the lazily loaded view arrives (#258).
  logViewLoading: "Die Log-Ansicht wird geladen …",
  logConnecting: "Der Strom wird geöffnet …",
  // ⚠️ Der Strom steht, und es kam noch keine Zeile: das ist ein GÜLTIGER
  // Zustand und kein Ladefehler. Ein ruhiger Container sagt nichts, und die
  // Ansicht darf daraus keine Störung machen.
  logWaiting: "Der Strom steht. Dieser Container hat noch nichts gesagt.",
  logEnded: "Der Strom ist zu Ende. Der Container redet nicht mehr.",
  // Ein Fehler, der IM Strom steht — nach der ersten Zeile ist keine andere
  // Form mehr möglich. Das ist der Rückfall für einen Grund, den weder
  // `FAILURE_KEY_BY_REASON` noch `HUB_FAILURE_KEY_BY_REASON` (`log-errors.ts`)
  // kennt; für die bekannten stehen eigene Sätze darunter.
  logStreamFailed: "Der Strom endete unerwartet ({reason}).",
  // Dieselbe Zeile ohne Grund (#176): keine Klammer statt einer erfundenen.
  logStreamFailedWithoutReason: "Der Strom endete unerwartet, ohne einen Grund zu nennen.",
  // Die vier Gründe des Agenten, seit v0.24.0 nach Ursache aufgelöst
  // (`dashboard-docker-agent#80`). Sie stehen einzeln da, weil der nächste
  // Schritt bei jedem ein anderer ist — genau dafür sind sie getrennt worden.
  //
  // ⚠️ Ein Abbruch ist NICHT mehr darunter. Er war bis v0.23.0 der häufigste
  // Grund und der Normalfall, und der Agent schickt dafür keine Fehlerzeile
  // mehr. Ein Satz, der ihn erklärt, wartete auf etwas, das nie eintrifft.
  logStreamFailedContainerGone: "Diesen Container gibt es nicht mehr. Er ist verschwunden, während das Log lief.",
  logStreamFailedEngineRefused: "Die Docker-Engine auf dem Arm hat das Log abgelehnt. Der Grund steht in seinem Audit-Log auf dem Zielhost.",
  logStreamFailedEngineUnreachable:
    "Die Verbindung des Arms zu seiner Docker-Engine ist gerissen. Meist läuft der Daemon gerade neu an — abwarten und erneut verbinden.",
  // Der verbliebene Sammelwert des Agenten. Er steht seit v0.24.0 nur noch für
  // das, was keiner der drei benannten Fälle ist.
  logStreamFailedUnreadable: "Der Arm konnte das Log nicht lesen. Die Ursache steht in seinem Audit-Log auf dem Zielhost.",
  // ⚠️ DER EINZIGE GRUND, DEN DER HUB SELBST SCHREIBT (#130). Er sagt etwas
  // anderes als die vier darüber: dort ist der Arm auf ein Problem gestoßen
  // und hat davon berichtet, hier ist die Leitung zwischen Hub und Arm mitten
  // im Strom abgerissen und niemand hat berichtet.
  logStreamFailedHubBroken:
    "Die Verbindung des Hubs zum Arm ist mitten im Log abgerissen. Der Arm selbst kann weiterlaufen — erneut verbinden.",
  logLineCount: "{count, plural, one {# Zeile} other {# Zeilen}}",
  logFilterLabel: "Zeilen filtern",
  logFilterPlaceholder: "Text, der in der Zeile steht",
  // ⚠️ DER SATZ, DER DEN FILTER ERKLÄRT, und er steht nicht zur Zierde da: der
  // Filter versteckt die ANZEIGE und nicht den Strom. Wer ihn für einen Filter
  // am Arm hält, wundert sich, warum die versteckte Zeile nach dem Leeren des
  // Feldes wieder da ist — sie war nie weg.
  logFilterHint:
    "Der Filter versteckt nur die Anzeige. Der Arm sendet weiter alles, und eine versteckte Zeile ist ohne neue Anfrage wieder da.",
  logFilterEmpty: "Keine der gehaltenen Zeilen enthält diesen Text.",
  logJumpToEnd: "Zum Ende springen",
  // ⚠️ DER WEG ZURÜCK AUS DEM FEHLER (#126), und er heißt WÖRTLICH wie der der
  // Shell (`shellReconnect`, `web/src/features/shell/messages/de.ts`): dieselbe Handlung an derselben
  // Stelle im Kopf des Menschen bekommt nicht zwei Wörter.
  logReconnect: "Neu verbinden",
  // Der Deckel. Die Zahl steht im Bauteil und reist als Platzhalter hierher —
  // eine zweite Zahl im Text wäre die, die beim nächsten Mal abweicht.
  logTrimmed: "Ältere Zeilen sind verworfen: die Ansicht hält höchstens {count} Zeilen.",
  logErrorInvalidTail: "Die angefragte Zeilenzahl liegt außerhalb von 1 bis 2000. Der Hub hat die Anfrage abgewiesen.",
  // ⚠️ Nennt die STELLE statt eine Ursache zu raten: der Arm hat abgelehnt, und
  // der häufigste Fall ist ein Container, der nicht in seiner Allowlist steht.
  logErrorForbidden:
    "Der Arm hat den Zugriff auf dieses Log abgelehnt. Häufigster Fall: der Container steht nicht in seiner Allowlist — etwa, weil er fremdverwaltet ist. Die Entscheidung steht im Protokoll des Arms.",
  logErrorAgentOutdated:
    "Der Agent dieses Arms spricht ein älteres Protokoll, sein Log käme leer an. Nach dem Umstieg auf die neue Fassung (Hinweis auf seiner Karte unter Hosts) ist es wieder da.",
  logErrorHostUnknown: "Diesen Arm gibt es nicht mehr. Vermutlich wurde er entfernt, während die Ansicht offen war.",
  // ⚠️ Eine ZAHL und keine Störung. Der Text sagt deshalb, was zu tun ist, statt
  // ein Scheitern zu melden.
  logErrorTooManyStreams:
    "Der Arm führt bereits so viele gleichzeitige Ströme, wie er zulässt. Ein geschlossener Log-Reiter gibt sofort einen Platz frei.",
  logErrorUnreachable: "Der Arm antwortet nicht. Der Hub konnte das Log nicht abholen.",
  logErrorUnknown: "Das Log konnte nicht geöffnet werden.",

  // Die Tafel „Logansicht" (#5, Etappe H). Sie trägt eine einzige Angabe: wie
  // viele Zeilen Vergangenheit eine Logansicht beim Öffnen zeigt. Die vier
  // erlaubten Werte selbst stehen nicht hier, sondern in
  // `LOG_TAIL_LINE_OPTIONS` (contract/src/api/settings.ts) — hier steht nur die eine
  // Form, in der eine solche Zahl vorgelesen wird.
  settingsLogsTitle: "Logansicht",
  settingsLogsHint:
    "Wie viele Zeilen Vergangenheit eine Logansicht beim Öffnen zeigt. Die Angabe gilt für alle Arme und für jeden Benutzer; mehr Zeilen heißen mehr Wartezeit, bis das erste Bild steht.",
  settingsLogsTailLinesLabel: "Zeilen beim Öffnen",
  // Ein Schlüssel mit Platzhalter und nicht vier feste Texte: die Auswahl baut
  // sich aus der Liste der erlaubten Werte, und eine fünfte Zahl dort bräuchte
  // hier nichts.
  settingsLogsTailLinesOption: "{count, plural, one {# Zeile} other {# Zeilen}}",
  settingsLogsTailLinesHint:
    "Mehr als 2000 Zeilen gibt es nicht: der Agent schneidet seinen Ausschnitt dort ab. Eine größere Zahl wäre eine Zusage, die die Gegenseite nicht hält.",
  settingsLogsSave: "Speichern",
  settingsLogsSaved: "gespeichert",
  settingsLogsFailed: "Die Zeilenzahl konnte nicht gespeichert werden.",
};
