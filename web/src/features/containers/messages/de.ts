// German texts of the feature `containers` (#282): the overview and the
// container list (title, search, filter chips, empty states), the context menu
// of a stack row, the state of a container and of its manager, and the two
// panels of the settings (the switch "show hub and agents" and the tab
// "Hub & Agenten"). German is the source of the message type; `en.ts` closes
// with `satisfies typeof deContainers`.
//
// Put together with the texts of every other surface in
// `web/src/app/i18n/messages.ts`; `platform/` may not import a feature.
//
// ⚠️ THE COUNTERS, THE EMPTY LIST AND THE LOAD ERROR ARE NOT HERE.
// `hostsCount`, `hostContainersCount`, `hostRunningCount`, `hostsEmpty`,
// `containersFailed` and `stackRunningOf` stay in `platform/i18n/messages/`:
// the stack page and the container page show them too, and neither may import
// this feature.
//
// ⚠️ A FLAT LITERAL, NO GROUP `containers: { … }`. `web/tests/languages.test.mjs`
// reads the top level of a flat literal; a second level would be invisible to
// it, and its assertions would fall away without a test going red.

export const deContainers = {
  backupSelection: "Optionale Datensicherung",
  backupModeStop: "Container stoppen",
  backupModeLive: "Live",
  backupLiveWarning: "Live-Kopien können inkonsistente Dateien enthalten. Weitere Schreiber werden nicht gestoppt.",
  backupConsistencyWarning: "Eine Dateikopie garantiert keine konsistente Datenbanksicherung. Ein Image-Rollback stellt keine Daten zurück.",
  backupSharedWarning: "Geteilte Quelle: Andere Nutzer können während der Sicherung weiter schreiben. Restore ist gesperrt.",
  backupBytes: "{bytes} Bytes",
  backupRefreshPreview: "Sicherungsauswahl prüfen",
  restoreAction: "Daten wiederherstellen",
  restoreTitle: "Daten für {target} wiederherstellen",
  restoreArchiveLinkWarning: "Beim Restore über die Docker-Archiv-API können Links ausgelassen werden. Die ausgelassenen Einträge werden in den privaten Metadaten des Agenten vermerkt.",
  restoreDescription: "Restore überschreibt vorhandene Daten der gewählten Ziele und stoppt den Container. Danach wird sein vorheriger Laufzustand wiederhergestellt.",
  restoreBackup: "Sicherung",
  restoreEmpty: "Keine vollständige Sicherung vorhanden.",
  restorePreview: "Restore-Vorschau",
  restoreConfirm: "Überschreiben bestätigen und wiederherstellen",
  restoreCompleted: "Daten wiederhergestellt.",
  restoreFailed: "Restore fehlgeschlagen.",
  restoreFailure: "Restore-Fehler: {reason}",
  restoreResumeFailure: "Wiederanlauffehler: {reason}",
  restoreState: "Containerzustand: {state}",
  restoreProgress: "Restore: {phase}",
  restoreCancelBoundary: "Nach Entpackbeginn kann der Auftrag nicht mehr abgebrochen werden.",
  restorePhaseStop: "stoppen",
  restorePhaseExtract: "entpacken",
  restorePhaseResume: "Vorzustand wiederherstellen",
  backupReasonProtected: "Die Quelle oder ein Unterpfad ist geschützt.",
  backupReasonSize: "Der Sicherungsumfang ist unbekannt.",
  backupReasonShared: "Geteilte Quellen dürfen nicht wiederhergestellt werden.",
  backupReasonOwnership: "Die Zuordnung der Quelle ist unklar.",
  backupReasonReadOnly: "Die Quelle ist nur lesbar.",
  backupReasonUnknown: "Die Quelle ist nicht mehr verfügbar.",
  backupReasonSpace: "Es fehlt Platz für die Sicherung und die feste Reserve.",
  backupReasonCopy: "Die Sicherung konnte nicht vollständig kopiert werden.",
  backupReasonDeadline: "Die Frist für die Datenkopie wurde überschritten.",
  backupReasonMissing: "Die vollständige Sicherung wurde nicht gefunden.",
  backupReasonTarget: "Sicherung und aktuelles Ziel stimmen nicht überein.",
  backupReasonMount: "Der gesicherte Mount stimmt nicht mit dem aktuellen Mount überein.",
  backupReasonExtract: "Das Archiv konnte nicht sicher entpackt werden.",
  backupReasonPath: "Das Archiv oder ein Zielpfad ist unsicher.",
  backupReasonCancelLate: "Entpacken hat bereits begonnen; Abbruch ist gesperrt.",
  backupReasonStop: "Der Stopp wurde nicht bestätigt.",
  backupReasonResume: "Der vorherige Laufzustand konnte nicht wiederhergestellt werden.",
  backupReasonLive: "Live-Sicherung kann inkonsistente Dateien enthalten.",

  updateAction: "Update",
  updateActionFor: "Update für {target}",
  updateForeign: "Das Update gehört dem externen Verwalter.",
  updateErrorGeneric: "Die Aktion konnte nicht abgeschlossen werden. Bitte den Stand neu laden.",
  updateStartDeadline: "Startfrist in Sekunden",
  updateSave: "Speichern",
  updateProgress: "{service}: {phase}",
  updateAbort: "Auftrag abbrechen",
  updateCancelBoundary: "Der Austausch hat begonnen. Prüfung und gegebenenfalls Rollback werden abgeschlossen.",
  updateFailure: "Update-Fehler: {reason}",
  updateRollbackFailure: "Rollback-Fehler: {reason}",
  updateConfirmTitle: "Update für {target} bestätigen",
  updateConfirmDescription: "Die aufgeführten Services werden auf das angebotene Image aktualisiert. Scheitert das Update, werden das vorherige Image, die vorherige Definition und der vorherige Laufzustand wiederhergestellt.",
  updateCurrentDigest: "Bisheriger Digest: {digest}",
  updateOfferedDigest: "Angebotener Digest: {digest}",
  updateUnknown: "Nicht ermittelbar",
  updateDeadlineSeconds: "Startfrist: {seconds} Sekunden",
  updateDataWarning: "Image-Rollback stellt keine Nutzerdaten und keine Datenbankschemata zurück.",
  updateRollbackImage: "Rückweg auf Image-ID: {image}",
  updateConfirm: "Update starten",
  updatePhaseQueued: "Wartet auf laufenden Vorgang",
  updatePhasePrecheck: "Vorbedingungen prüfen",
  updatePhasePull: "Image ziehen",
  updatePhaseBackup: "Daten sichern",
  updatePhaseExchange: "Container austauschen",
  updatePhaseVerify: "Ergebnis prüfen",
  updatePhaseRollback: "Vorherigen Zustand wiederherstellen",
  updatePhaseResume: "Laufzustand wiederherstellen",
  updatePhaseCompleted: "Abgeschlossen",
  updateOutcomeUnchanged: "Digest unverändert",
  updateOutcomeUpdated: "Update erfolgreich",
  updateOutcomeCancelled: "Update abgebrochen",
  updateOutcomeFailed: "Update fehlgeschlagen",
  updateOutcomeRolledBack: "Update fehlgeschlagen; vorheriger Zustand wiederhergestellt",
  updateOutcomeRollbackFailed: "Update und Rollback fehlgeschlagen. Container und Konfiguration prüfen.",
  updateReasonUnhealthy: "Der bisherige Container meldet einen fehlgeschlagenen Healthcheck.",
  updateReasonRestarting: "Der bisherige Container startet wiederholt neu.",
  updateReasonPaused: "Der Container wird nach der Prüfung wieder pausiert.",
  updateReasonLocalImageNoRegistryDigest: "Das lokale Image hat keinen Registry-Digest und kann nicht aktualisiert werden.",
  updateReasonScaledServiceUnsupported: "Services mit mehreren Replikas werden nicht unterstützt.",
  updateReasonOneoffUnsupported: "Einmalcontainer sind keine Update-Ziele.",
  updateReasonManifestQueryFailed: "Der angebotene Registry-Digest konnte nicht ermittelt werden.",
  updateReasonUpdatePreviewStale: "Die Vorschau ist nicht mehr gültig. Eine neue Vorschau ist erforderlich.",
  updateReasonUpdateDigestChanged: "Das angebotene Image hat sich geändert. Eine neue Vorschau ist erforderlich.",
  updateReasonUpdateRollbackUnavailable: "Das vorherige Image ist nicht als Rückweg verfügbar.",
  updateReasonUpdatePullFailed: "Das Image konnte nicht gezogen werden.",
  updateReasonUpdatePhaseDeadlineExceeded: "Die Zeitgrenze der Phase wurde überschritten.",
  updateReasonUpdateExchangeFailed: "Der Container konnte nicht ausgetauscht werden.",
  updateReasonUpdateStartFailed: "Der Ersatzcontainer konnte nicht gestartet werden.",
  updateReasonUpdateHealthTimeout: "Der Ersatzcontainer wurde nicht rechtzeitig healthy.",
  updateReasonUpdateContainerExited: "Der Ersatzcontainer hat sich während der Prüfung beendet.",
  updateReasonUpdateContainerRestarted: "Der Ersatzcontainer hat während der Prüfung neu gestartet.",
  updateReasonUpdateCompletionFailed: "Der Abschlussauftrag wurde nicht rechtzeitig erfolgreich beendet.",
  updateReasonUpdateStateMismatch: "Der nachgelesene Zustand entspricht nicht dem bestätigten Ziel.",
  updateReasonUpdateRollbackFailed: "Der vorherige Zustand konnte nicht wiederhergestellt werden. Betreiberhandeln ist erforderlich.",
  updateReasonUpdateCancelTooLate: "Nach dem ersten Austausch ist kein Abbruch mehr möglich.",
  updateReasonUpdateJobUnknown: "Der Auftrag ist nicht verfügbar.",
  updateReasonStateChanged: "Der Containerzustand hat sich geändert. Eine neue Vorschau ist erforderlich.",
  updateReasonActionQueueTimeout: "Die Wartezeit auf einen laufenden Vorgang wurde überschritten.",
  updateReasonBackupIncomplete: "Die angeforderte Sicherung ist nicht verfügbar. Das Update wird nicht ohne sie begonnen.",
  updateReasonRollbackDoesNotRestoreData: "Image-Rollback stellt keine Nutzerdaten und keine Datenbankschemata zurück.",

  lifecycleStart: "Start",
  lifecycleStop: "Stopp",
  lifecycleRestart: "Neustart",
  lifecycleStartDefinition: "Start · Definition anwenden",
  lifecycleRestartDefinition: "Neustart · neu erstellen",
  lifecycleActionFor: "{action} für {target}",
  lifecycleActions: "Aktionen für {target}",
  lifecycleOffline: "Host offline. Aktionen sind nach der Wiederverbindung möglich.",
  lifecycleRole: "Nur Administratoren dürfen diese Aktion ausführen.",
  lifecycleReadOnly: "Agent im Nur-Lese-Modus.",
  lifecycleNotAllowlisted: "Container nicht in der Allowlist.",
  lifecycleObserveOnly: "Container nur zur Beobachtung freigegeben.",
  lifecycleSelfLocked: "Selbstverwaltungssperre für Hub und Agent.",
  lifecycleCapability: "Dem Agent fehlt die benötigte Fähigkeit oder die aktuelle Auskunft darüber.",
  lifecycleBusy: "Ein Vorgang auf diesem Ziel läuft bereits.",
  lifecycleUnknownState: "Dieser Containerzustand erlaubt keine Laufzeitaktion.",
  lifecycleAlreadyRunning: "Alle betroffenen Container laufen bereits oder sind erledigt.",
  lifecycleAlreadyStopped: "Das Ziel ist gestoppt. Start ist verfügbar.",
  lifecycleCompleted: "Einmalauftrag erfolgreich beendet.",
  lifecyclePreparing: "Stand des Stacks wird gelesen …",
  lifecycleWaiting: "wartet auf laufenden Vorgang",
  lifecycleRunning: "Vorgang läuft …",
  lifecycleConfirmTitle: "{action}: {target}",
  lifecycleConfirmServices: "Betroffene Services:",
  lifecycleConfirmRecreate: "Alle betroffenen Container werden neu erstellt. Volumes und Bind-Mounts bleiben erhalten.",
  lifecycleConfirmUnknown: "Die Aktion betrifft die folgenden Services. Der Agent bestimmt den wirksamen Modus anhand ihrer Verwaltung.",
  lifecycleConfirmRuntime: "Die Aktion betrifft die bestehenden Container dieser Services.",
  lifecycleConfirmChanged: "Der Stand oder der wirksame Modus hat sich geändert. Bitte den neuen Stand prüfen und erneut bestätigen.",
  lifecycleCancel: "Abbrechen",
  lifecycleConfirm: "Jetzt ausführen",
  lifecycleOk: "Aktion abgeschlossen.",
  lifecyclePartial: "Aktion teilweise abgeschlossen.",
  lifecycleFailed: "Aktion fehlgeschlagen.",
  lifecycleTimeout: "Zeitgrenze überschritten. Der Vorgang kann auf dem Host weiterlaufen. Der Stand wird neu gelesen.",
  lifecycleUnknownResult: "Ergebnis unbekannt, Vorgang kann auf dem Host weiterlaufen. Den Stand neu lesen; nach der Wiederverbindung wird er automatisch aktualisiert.",
  lifecycleStateChanged: "Stand geändert. Neu geladen; die Aktion braucht eine neue Bestätigung.",
  lifecycleWriteOk: "Änderung gespeichert.",
  lifecycleServiceOk: "Zielzustand erreicht",
  lifecycleServiceFailed: "Zielzustand nicht erreicht",
  lifecycleNotCreated: "nicht erzeugt (fremdverwaltet)",
  lifecycleNotCreatedReason: "Erzeugen gehört dem externen Verwalter. Bestehende Container bleiben für Laufzeitaktionen verfügbar.",
  lifecycleReload: "Stand neu lesen",
  lifecycleDismiss: "Meldung schließen",
  lifecycleObservationUnknown: "Beobachtung nicht verfügbar: Stopp-Absicht unbekannt.",
  lifecycleHealingUnknown: "Selbstheilung unbekannt: Beobachtung nicht verfügbar.",
  lifecycleBudget: "Selbstheilungsbudget: {used, number} verbraucht · {remaining, number} verbleibend",
  lifecycleNextAttempt: "Nächster Heilungsversuch: {time}",
  lifecycleStableSince: "Stabilitätsfenster läuft seit {time}",
  lifecycleManualStop: "manuell gestoppt · {time} · {actor}",
  lifecycleActorHealing: "Selbstheilung",
  lifecycleActorHub: "Hub",
  lifecycleOwnershipUnknown: "Die Verwaltung dieses Stacks ist unbekannt.",
  lifecycleOwnershipDefinition: "Ist der Stack Hub-eigen, wird bei Start die Definition angewendet und bei Neustart werden die Container neu erstellt. Volumes und Bind-Mounts bleiben erhalten.",
  lifecycleActorUnknown: "Akteur unbekannt",
  lifecycleCrashed: "abgestürzt · Exit-Code {code}",
  lifecycleRestarting: "startet wiederholt neu",
  lifecycleMaintenanceUntil: "Wartung bis {time}",
  lifecycleMaintenanceUnlimited: "Wartung unbegrenzt",
  lifecycleMaintenanceOn: "Wartung einschalten",
  lifecycleMaintenanceOff: "Wartung ausschalten",
  lifecycleMaintenanceFor: "Wartung für {target}",
  lifecycleDuration: "Wartungsdauer",
  lifecycleDurationDefault: "Vorgabe: {duration}",
  lifecycleDurationMinutes: "{count, number} Minuten",
  lifecycleDurationHour: "1 Stunde",
  lifecycleDurationDay: "1 Tag",
  lifecycleDurationUnlimited: "unbegrenzt",
  lifecycleStackMaintenance: "Die Stack-Wartung gilt auch für neue Services.",
  lifecycleInheritedMaintenance: "Wartung vom Stack übernommen. Zum Ausschalten die Stack-Ansicht öffnen.",
  lifecycleIncident: "Offener Selbstheilungsvorfall",
  lifecycleIncidentCause: "Ursache: Exit-Code {code} · {error}",
  lifecycleNoEngineError: "keine bereinigte Engine-Meldung verfügbar",
  lifecycleIncidentRecommendation: "Empfohlen: Container-Logs und Konfiguration prüfen.",
  lifecycleIncidentAttempts: "Versuche: {count, number}",
  lifecycleAttempt: "Versuch {number, number} · {time} · {result}",
  lifecycleAttemptPending: "läuft",
  lifecycleAttemptOk: "erfolgreich",
  lifecycleAttemptFailed: "fehlgeschlagen",
  lifecycleAttemptInterrupted: "unterbrochen",
  lifecycleLogsUnavailable: "Log-Auszug nicht verfügbar.",
  lifecycleRedactionUnavailable: "Log-Auszug fehlt: Bereinigung nicht verfügbar.",
  lifecycleIncidentLogs: "Bereinigter Log-Auszug",
  lifecycleAcknowledge: "Vorfall quittieren",
  lifecycleAcknowledgeEffect: "Quittieren füllt das Budget auf, ohne den Container zu starten.",
  lifecycleErrorGeneric: "Die Aktion wurde abgelehnt. Bitte den Stand und die Berechtigungen prüfen.",
  lifecycleQueueTimeout: "Die Wartezeit auf den laufenden Vorgang ist abgelaufen. Es wurde keine neue Aktion gestartet.",
  lifecycleErrorCode: "Fehlerschlüssel: {code}",
  lifecycleServiceState: "{service}: {status}",

  // Die Übersicht (D6): Stacks je Host, dazu die Container ohne Stack.
  //
  // ⚠️ Hier standen bis D5 dreizehn Schlüssel mehr — die Spaltenköpfe einer
  // Tabelle (Name, Image, Status, CPU, Speicher) und die Beschriftungen einer
  // Karte mit dem Zustand des Agenten. Sie sind mit ihrer Fläche gegangen und
  // stehen nicht ungenutzt hier: `web/tests/languages.test.mjs` verlangt, dass
  // jeder Schlüssel benutzt wird, und ein Wortschatz für einen Bildschirm, den
  // es nicht mehr gibt, ist der Anfang eines Wörterbuchs, das niemand mehr
  // liest. Die Angaben zum Agenten stehen seit D5 auf der Host-Fläche; CPU und
  // Speicher kommen mit dem Container-Detail in Phase 5 zurück.
  overviewTitle: "Übersicht",
  overviewSearchPlaceholder: "Container suchen",
  // Die vier Chips über der Liste. Ihre Kennungen stehen in
  // `web/src/features/containers/container-filter.ts`; ein Wächter hält beide
  // Listen gegeneinander. „krank" kam mit D6b dazu — das Artboard führt vier
  // Chips, D6 baute drei.
  overviewFilterAll: "alle",
  overviewFilterRunning: "läuft",
  overviewFilterUnhealthy: "krank",
  overviewFilterStopped: "aus",
  overviewNoMatches: "Kein Container passt zu Suche und Filter.",
  overviewWithoutStack: "ohne Stack",
  // Das Kontextmenü einer Stack-Zeile (Rechtsklick) und der zugeklappte
  // Abschnitt am Ende eines Hosts, in den ein ausgeblendeter Stack rückt.
  overviewHiddenStacks: "ausgeblendet · {count, plural, one {# Stack} other {# Stacks}}",
  stackMenuOpen: "Stack öffnen",
  stackMenuHide: "Ausblenden",
  stackMenuShow: "Wieder einblenden",
  stackHideFailed: "Der Stack {project} ließ sich nicht umstellen.",
  // Die Gruppe „fremdverwaltet" (#20). Sie steht in jeder Container-Liste am
  // Ende, und der Satz darunter nennt den Verwalter.
  //
  // ⚠️ Zwei Sätze und nicht einer mit Platzhalter für alle: der Name eines
  // bekannten Verwalters trägt mehr als seinen Namen (dass Unraid mit
  // VORLAGEN arbeitet, erklärt, warum der Hub dort nichts zu suchen hat). Für
  // einen Verwalter, den der Hub nicht kennt, bleibt der Satz mit dem
  // eingesetzten Namen — er darf nicht in einen Text fallen, der ihn
  // verschweigt.
  overviewExternallyManaged: "fremdverwaltet",
  externalManagedByUnraid:
    "Diese Container legt Unraid aus seinen Vorlagen an. Der Hub zeigt und steuert sie; Update und Neuerstellen macht Unraid.",
  externalManagedByUnraidCompose:
    "Diese Container startet das Compose-Manager-Plugin von Unraid aus seinen Projekten. Der Hub zeigt und steuert sie; Update, Neuerstellen und Compose-Änderungen macht das Plugin.",
  externalManagedUnknown:
    "Diese Container tragen ein Verwaltermerkmal, das der Agent keinem Verwalter sicher zuordnen kann. Der Hub zeigt und steuert sie; Update, Neuerstellen und Entfernen bleiben gesperrt.",
  externalManagedByOther: "Diese Container verwaltet {manager}. Der Hub zeigt und steuert sie; Update und Neuerstellen macht {manager}.",
  // Das „›" am Ende einer Stack-Zeile trägt kein Wort — dieser Text sagt einem
  // Screenreader, wohin es führt.
  stackOpen: "Stack {project} öffnen",
  stackContainersCount: "Stack · {count, plural, one {# Container} other {# Container}}",
  // Die Bedeutung der drei Punktfarben, ebenfalls nur für den Screenreader:
  // eine farbige Scheibe ohne Text sagt ihm nichts.
  containerStateOk: "läuft",
  containerStateWarn: "krank",
  containerStateDown: "ausgefallen",
  containerStateUnknown: "Zustand unbekannt: {state}",
  containersEmptyTitle: "Kein Container freigegeben",
  containersEmptyBody:
    "Der Agent zeigt nur Container, die in seiner Allowlist stehen. Ein frisch aufgesetzter Agent hat eine leere Allowlist — die Antwort ist also richtig und nicht leer, weil etwas fehlt.",
  // Die Fläche „Container" — der Deepdive (D6b).
  containersTitle: "Container",
  // Die Tafel „Sichtbarkeit" im Reiter „Container".
  settingsContainerViewTitle: "Hub und Agenten",
  settingsContainerViewHint:
    "Der Hub mit seiner Datenbank und auf jedem Arm Agent, WireGuard und Watcher sind überall dieselben Container. In Übersicht und Container-Fläche sind sie deshalb ausgeblendet; im Reiter „Hub & Agenten“ stehen sie immer.",
  settingsContainerViewShow: "In Übersicht und Container-Fläche zeigen",
  settingsContainerViewSaved: "gespeichert",
  settingsContainerViewFailed: "Die Einstellung konnte nicht gespeichert werden.",
  // Ein Arm, auf dem nur Container von Hub und Agenten laufen und die
  // Einstellung sie ausblendet.
  containersOnlySystem:
    "{count, plural, one {# Container} other {# Container}} von Hub und Agenten ausgeblendet — einblenden unter Einstellungen › Container.",
  // Der Reiter „Hub & Agenten".
  systemContainersTitle: "Container von Hub und Agenten",
  systemContainersHint:
    "Alles, was der Leitstand selbst betreibt — auf dem Hub und auf jedem Arm. Logs, Shell, Dateien und Marken funktionieren hier wie auf der Container-Fläche."
};
