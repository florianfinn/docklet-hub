// German texts of the feature `compose` (#265): the compose tab of a stack with
// the editor (#135) and its key bindings (#157), the diff, the apply card and
// the `.env` view. German is the source of the message type; `en.ts` closes
// with `satisfies typeof deCompose`.
//
// Put together with the texts of every other surface in
// `web/src/app/i18n/messages.ts`; `platform/` may not import a feature.
//
// ⚠️ THE TAB BAR IS NOT HERE. `stackTabsLabel` and `stackTabOverview` belong
// to the page of the stack, not to this feature, and stay in
// `platform/i18n/messages/`. `stackTabCompose` and `composeDiscardConfirm` are
// here and read by `StackScreen` through `t()`, as `containerTabFiles` is read
// by `ContainerScreen`: the keys are global, only the files are per feature.
//
// ⚠️ A FLAT LITERAL, NO GROUP `compose: { … }`. `web/tests/languages.test.mjs`
// reads the top level of a flat literal; a second level would be invisible to
// it, and its assertions would fall away without a test going red.
//
// ⚠️ HISTORY: until #265 this was `platform/i18n/messages/de-compose.ts`. It
// was split off `de.ts` in #135/#157 when that file stood 8 lines over the
// limit of `web/tests/source-file-size.test.mjs`.

export const deCompose = {
  // ── Der Compose-Reiter eines Stacks (#35) ─────────────────────────────────
  //
  stackTabCompose: "Compose",

  composeNoContainer:
    "Dieser Stack hat gerade keinen Container. Die Compose-Datei liest der Agent über die Labels eines laufenden Containers — ohne einen ist sie für den Hub nicht auffindbar.",
  composeServiceCount: "{count, plural, one {# Service} other {# Services}}",
  // ⚠️ Zwei Zahlen und nicht eine, wo sie sich unterscheiden. Ein Service, den
  // die Datei nennt und zu dem es keinen Container gibt, ist genau der Fall,
  // den das Anwenden später ausdrücklich bestätigen lässt.
  composeServiceCountDiffers: "{running} mit Container · {inFile} in der Datei",
  composeUnreadable:
    "Den Stack hat der Agent gefunden, seine Compose-Datei aber nicht lesen können. Der Inhalt unten wäre leer — und eine leere Datei ist etwas anderes als eine, die niemand lesen konnte.",

  composeErrorHostUnknown: "Diesen Arm führt der Hub nicht.",
  composeErrorUnreachable: "Der Arm hat nicht geantwortet. Die Datei liegt auf ihm, nicht hier.",
  composeErrorContainerUnknown: "Diesen Container führt der Arm nicht mehr.",
  composeErrorNotAllowlisted:
    "Der Arm hat abgelehnt: nicht jeder Container dieses Stacks steht auf seiner Allowlist. Der Abgleich läuft im Hintergrund — nach dem nächsten Takt sieht es anders aus.",
  composeErrorAgentTooOld: "Der Arm ist zu alt für diese Fläche.",
  composeErrorTooLarge: "Die Compose-Datei überschreitet die Grenze des Agenten.",
  composeErrorReadOnly: "Dieser Arm steht auf „nur lesen“. Solange der Kill-Switch liegt, wendet er nichts an.",
  composeErrorTooManyStreams:
    "Der Arm führt bereits die Höchstzahl gleichzeitiger Ströme. Ein geschlossener Log-Reiter oder ein beendetes Anwenden gibt einen Platz frei.",
  composeErrorGeneric: "Die Compose-Datei war nicht zu holen.",
  // ⚠️ Der Fall aus #183, gemessen am Arm `unraid`: keiner der Container
  // dieses Stacks führt den Arm zu einer Datei in seinem Basispfad. Die zwei
  // Ursachen, die dort vorkamen, stehen im Satz — sie sind der Weg zur
  // Behebung, und beide liegen auf dem Arm, nicht im Hub.
  composeErrorFileMissing:
    "Der Arm findet für diesen Stack keine Compose-Datei in seinem Basispfad. Meist zeigen die Compose-Labels der Container auf einen anderen Pfad zu denselben Dateien (etwa /mnt/user statt /mnt/cache) oder nennen mehr als eine Datei. Ein „docker compose up -d“ aus dem Verzeichnis im Basispfad setzt die Labels neu.",
  composeErrorFileMissingSearched: "Gesucht hat der Arm unter:",
  // ⚠️ Der Grund steht dabei: „nur lesen“ ohne Grund sähe aus wie ein
  // fehlendes Recht.
  composeHubOwnStack:
    "Das ist der Stack, in dem dieser Hub selbst läuft. Er wird hier nur angezeigt: ein Anwenden von hier ersetzte den Hub mitten im Vorgang. Geändert wird er auf dem Host.",
  composeExternallyManaged:
    "Ein Dienst dieses Stacks wird fremdverwaltet. Die Datei wird hier nur angezeigt: seine Definition bleibt beim Verwalter, der eine Änderung von hier beim nächsten Update zurücksetzen würde. Start, Stopp, Logs und Shell bleiben verfügbar.",
  // Der Editor und der Vergleich (#35, Etappe E6a).
  composeEdit: "Bearbeiten",
  composeFileTabs: "Dateien des Compose-Projekts",
  composeEnvFileName: ".env",
  composeEnvReveal: "Werte anzeigen",
  composeEnvHide: "Werte verbergen",
  composeEnvMissing: "Zu dieser Compose-Datei liegt keine .env im Projektverzeichnis.",
  composeEnvEmpty: "Die .env enthält keine auswertbaren Einträge.",
  composeEnvParsedNote: "Angezeigt werden Schlüssel und Werte aus der .env; Kommentare und Leerzeilen bleiben in der Datei.",
  composeEnvOwnStack: "Die .env des Hub-Stacks bleibt gesperrt, weil sie dessen Zugangsdaten enthält.",
  composeEditLabel: "Compose-Datei bearbeiten",
  // Der Weg aus dem Feld heraus (#135). Er steht als Satz da, weil ihn sonst
  // niemand fände: ein Feld, in dem Tab einrückt, sieht von außen aus wie
  // jedes andere.
  composeEditKeyboardHint:
    "Tabulator rückt ein, Umschalt und Tabulator rücken aus. Escape und danach Tabulator führt aus dem Feld heraus.",
  // Der Name des Symbols in der Kopfkarte (#157). Er ist kurz, weil er auf
  // dem Knopf steht; der Satz dazu ist `composeEditKeyboardHint`.
  composeEditKeyboardTitle: "Tastenbelegung",
  composeShowDiff: "Vergleich",
  composeBackToEdit: "Zurück zum Text",
  composeReload: "Neu laden",
  composeDiscard: "Verwerfen",
  // ⚠️ Der Satz nennt, was verloren geht, und fragt nicht bloß „sicher?".
  // Eine Rückfrage ohne Gegenstand beantwortet jeder mit Ja.
  composeDiscardConfirm:
    "Die Änderungen an dieser Compose-Datei sind noch nirgends gespeichert und gehen dabei verloren. Trotzdem fortfahren?",
  composeUnsaved: "ungespeicherte Änderungen",

  composeDiffTitle: "Was sich ändert",
  composeDiffCount: "+{added} · −{removed}",
  composeDiffNone: "Nichts geändert. Der Entwurf ist Zeichen für Zeichen der geladene Stand.",
  composeDiffUnified: "Untereinander",
  composeDiffSideBySide: "Nebeneinander",
  // ⚠️ Der Deckel wird gesagt und nicht verschwiegen: was darunter steht, ist
  // dann kein Vergleich mehr, sondern „alles raus, alles rein".
  composeDiffCapped:
    "Der Vergleich ist zu groß, um Zeile für Zeile gerechnet zu werden. Unten steht deshalb der ganze alte Stand als entfernt und der ganze neue als hinzugefügt — das ist kein Vergleich, sondern eine Ersetzung.",
  // Vorschau, Bestätigungen und Anwenden (#35, Etappe E6b).
  composePreviewTitle: "Was gleich passiert",
  composePreviewByAgent: "vom Arm gerechnet",
  // ⚠️ Der Satz sagt, WAS die Näherung nicht weiß, statt bloß „ungenau".
  composePreviewByHub: "vom Hub geschätzt — der Arm ist zu alt für den Trockenlauf",
  composePreviewInvalid: "Dieser Entwurf bestünde die Prüfung des Arms nicht: {reason}",

  composeConfirmNew: "Neue Services",
  composeConfirmNewNote:
    "Ein Service, den es vorher nicht gab, entsteht nicht als Nebenwirkung einer Textänderung. Jeder wird einzeln bestätigt.",
  composeConfirmRemoved: "Entfallende Services",
  composeConfirmRemovedNote: "Ihre Container werden nach dem Start entfernt.",
  composeConfirmImages: "Images, die erst geholt werden müssen",
  composeConfirmImagesNote: "Sie liegen auf dem Host noch nicht vor. Das Ziehen kann dauern und braucht Netz.",
  // ⚠️ „nicht erhoben" und nicht „keine" — das ist der ganze Unterschied.
  composeImagesUnknown:
    "Welche Images auf dem Host fehlen, ist nicht erhoben. Der Arm fragt danach, sobald er den Entwurf geprüft hat.",

  composeExistingViolations: "Härtungsbefunde, die dieser Stack schon hat",
  composeExistingViolationsNote: "Sie stehen hier als Auskunft. Sie hindern das Anwenden nicht.",
  composeHardeningLater:
    "Ob dieser Entwurf NEUE Härtungsbefunde einführt, misst der Arm erst nach dem Start — vorher ist es niemandem bekannt. Ohne Bestätigung rollt er dann zurück.",
  composeUncertainties:
    "Der Hub konnte nicht alles auflösen: {list}. Was der Arm daraus macht, kann davon abweichen.",

  composeStepsTitle: "Die Schritte dieser Strecke",
  composeStepValidate: "Entwurf prüfen",
  composeStepConfirm: "Bestätigungen abgleichen",
  composeStepPullImages: "Images ziehen",
  composeStepWrite: "Datei schreiben",
  composeStepStart: "Starten",
  composeStepResolveContainers: "Container auflösen",
  composeStepHardening: "Härtung prüfen",
  composeStepRemoveContainers: "Weggefallene Container entfernen",
  composeStepCleanUp: "Aufräumen",
  composeStepRollBack: "Zurückrollen",
  composeApply: "Anwenden",
  composeApplyRunning: "Wird angewendet",
  composeApplySilent:
    "Dieser Arm meldet keine Zwischenschritte. Er antwortet, wenn er fertig ist — das kann einige Minuten dauern.",
  composeApplyLeaveNote:
    "Diese Fläche zu schließen hält den Vorgang NICHT an. Der Arm arbeitet weiter; nur das Zusehen endet.",
  composeApplyStepsTrimmed:
    "Ältere Schritte sind verworfen: die Anzeige hält höchstens {count} Schritte.",
  composeApplied: "Angewandt.",
  composeResyncFailed:
    "Der Abgleich der Allowlist ist nicht durchgelaufen ({status}). Bis zum nächsten Takt kann jede weitere Aktion an diesem Stack abgelehnt werden — das sieht wie ein Rechteproblem aus, ist aber keines.",
  // Dieselbe Warnung, wenn die Ergebniszeile keinen Status trug (#176) — ohne
  // Klammer, statt eine leere oder erfundene hineinzusetzen.
  composeResyncFailedWithoutStatus:
    "Ob der Abgleich der Allowlist durchgelaufen ist, ist nicht bekannt. Bis zum nächsten Takt kann jede weitere Aktion an diesem Stack abgelehnt werden — das sieht wie ein Rechteproblem aus, ist aber keines.",
  composeApplyUnknown: "Der Ausgang ist unbekannt.",

  composeBlockerNoChange: "Nichts geändert.",
  composeBlockerInvalid: "Der Entwurf bestünde die Prüfung nicht.",
  composeBlockerServices: "Noch {count} zu bestätigen.",
  composeBlockerRemoved: "Noch {count} zu bestätigen.",
  composeBlockerImages: "Noch {count, plural, one {# Image} other {# Images}} zu bestätigen.",
  // ⚠️ Der Fall entsteht ganz gewöhnlich: anhaken, weitertippen, der Service
  // heißt jetzt anders. Der Agent prüft genaue Mengengleichheit.
  composeBlockerStale:
    "Eine Bestätigung passt nicht mehr zum Entwurf. Der Vergleich läuft neu — die Haken bitte noch einmal setzen.",

  composeQuestionTitle: "Der Arm fragt zurück",
  composeQuestionServices: "Neue Services: {added}. Entfallende: {removed}.",
  composeQuestionImages: "Diese Images liegen auf dem Host nicht vor und werden geholt: {list}",
  composeQuestionHardening:
    "{count, plural, one {Dieser Entwurf führt einen neuen Härtungsbefund ein} other {Dieser Entwurf führt # neue Härtungsbefunde ein}}. Der Agent übernimmt ihn erst, wenn jeder dieser Befunde bestätigt ist.",
  composeQuestionChangedElsewhere:
    "Die Datei hat sich geändert, seit sie geladen wurde. Der Entwurf steht noch im Editor — neu laden zeigt den fremden Stand.",
  composeQuestionStartFailed: "Der Stack ist nicht hochgekommen: {detail}",
  composeQuestionContainerMissing: "Nach dem Start waren nicht alle Container aufzulösen: {detail}",
  composeQuestionInvalidDraft: "Der Arm hält den Entwurf für unbrauchbar: {detail}",
  composeQuestionAnchorStale:
    "Der Container, über den dieser Stack angesprochen wird, ist beim Arm nicht mehr freigegeben — meist hat ein Anwenden ihn ersetzt. Geschrieben wurde nichts. Den Stack aus der Übersicht neu öffnen und den Entwurf dort erneut einsetzen.",
  composeQuestionImageRefUnreadable:
    "Der Arm kann die Image-Angabe „{ref}“ nicht lesen, so wie sie sich aus dem Entwurf ergibt. Geschrieben wurde nichts. Die Angabe im Entwurf berichtigen und erneut anwenden.",
  composeNotRolledBack:
    "Zurückgerollt wurde NICHT. Die neue Datei liegt auf dem Host, und der Stack läuft nicht wie vorher.",
  composeRolledBack: "Der Arm hat zurückgerollt: Datei und Stack stehen wie vorher.",
  composeAnswerAndRetry: "Bestätigen und erneut anwenden",

  // ── Die Zuordnung von Hand (#185) ─────────────────────────────────────────
  //
  // The reasons for which the arm found no file for a container, verbatim the
  // agent's anchor reasons (`compose-anchor-…`, agent v0.30.0, #234).
  composeErrorAnchorOutsideBase:
    "Die Compose-Labels der Container zeigen auf ein Verzeichnis außerhalb des Basispfads des Arms, etwa /mnt/user statt /mnt/cache. Liegt dieselbe Datei im Basispfad, lässt sie sich unten von Hand zuordnen.",
  composeErrorAnchorAmbiguous:
    "Die Compose-Labels der Container nennen mehr als eine Datei, oder keine direkt im Projektverzeichnis. Welche davon gilt, lässt sich unten von Hand festlegen.",
  composeErrorAnchorLabelsMissing:
    "Die Compose-Labels der Container sind unvollständig. Der Arm kann sie keinem Compose-Projekt zuordnen.",
  composeSelectionOpen: "Zuordnung",
  composeSelectionTitle: "Compose-Datei für {container}",
  composeSelectionIntro:
    "Der Arm bietet nur Dateien an, die er selbst gefunden hat: aus den Compose-Labels des Containers und aus dem Projektverzeichnis in seinem Basispfad. Die Wahl liegt danach beim Arm und gilt, bis sie aufgehoben wird.",
  composeSelectionCandidatesLabel: "Angebotene Dateien",
  composeSelectionSourceLabel: "aus den Labels",
  composeSelectionSourceBase: "im Basispfad",
  composeSelectionCurrent: "festgelegt",
  composeSelectionNone:
    "Der Arm bietet für diesen Container keine Datei an. Weder die Labels noch das Projektverzeichnis im Basispfad führen zu einer Compose-Datei, die er verwalten darf.",
  composeSelectionWarning:
    "Die festgelegte Datei ersetzt für diesen Container den Anker aus den Labels. Der Editor zeigt sie, und ein Anwenden startet den Stack mit ihr.",
  composeSelectionWarningLayered:
    "Die Labels nennen {count, plural, one {# Datei} other {# Dateien}}. Die laufende Konfiguration entsteht aus ihrer Überlagerung. Der Editor bearbeitet genau eine Datei, und ein Anwenden startet mit genau dieser: was aus den anderen kam (Netze, Volumes, Umgebung), fällt dann weg. Gelöscht wird dabei nichts; die übrigen Container des Projekts bleiben stehen.",
  composeSelectionConfirm: "Zuordnung festlegen",
  composeSelectionClear: "Zuordnung aufheben",
  composeSelectionClose: "Schließen",
  composeSelectionSkipped: "Für diese Container fand der Arm keine eigene Datei:",
  composeSelectionInvalid:
    "Der Arm hat diese Datei nicht angenommen. Sie steht nicht mehr in seiner Liste; die Liste wird neu geladen.",

  // ── Neues Hub-eigenes Projekt (#3) ────────────────────────────────────────
  //
  composeQuestionExternalSources:
    "Das Projekt bindet Verzeichnisse außerhalb seines Projektordners ein. Der Arm verlangt, dass jede Quelle bestätigt wird: {list}",
  projectNewAction: "Neues Projekt",
  projectNewTitle: "Neues Projekt auf {host}",
  projectNewDescription:
    "Das Projekt bekommt einen eigenen Ordner unter dem Basispfad des Arms und eine eigene Compose-Datei. Mehrere Dienste teilen diesen Ordner.",
  projectNameLabel: "Name",
  projectNameHint:
    "Name des Projekts und seines Ordners: 2 bis 63 Zeichen aus Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich, am Anfang ein Buchstabe oder eine Ziffer.",
  projectCheck: "Prüfen",
  projectPreviewStale: "Name oder Entwurf haben sich seit der Prüfung geändert.",
  projectDirectory: "Projektordner:",
  projectConfirmServices: "Diese Dienste entstehen neu",
  projectSources: "Datenquellen",
  projectSourceProject: "Projektordner",
  projectSourceExternal: "extern",
  projectSourceVolume: "Volume",
  projectSourceAnonymous: "anonym",
  projectSourceReadOnly: "nur lesen",
  projectSourceShared: "geteilt",
  projectConfirmExternal: "Externe Quellen bestätigen",
  projectConfirmExternalNote:
    "Diese Verzeichnisse liegen außerhalb des Projektordners. Der Container erhält Zugriff darauf; Entfernen und Dateizugriff behandeln sie gesondert.",
  projectCreate: "Projekt anlegen",
  projectCreating:
    "Der Arm legt das Projekt an und startet es. Das kann mit dem Ziehen der Images einige Minuten dauern; Schließen hält den Vorgang nicht an.",
  projectCreated: "Das Projekt ist angelegt.",
  projectRestartLooping: "{count, plural, one {# Dienst startet} other {# Dienste starten}} wiederholt neu.",
  projectResyncWarning:
    "Die Allowlist des Arms ist noch nicht abgeglichen. Bis zum nächsten Abgleich lehnt er Aktionen an den neuen Containern ab.",
  projectDirectoryLeft:
    "Im Projektordner liegen Dateien, die ein Container geschrieben hat. Der Ordner bleibt deshalb stehen und belegt den Namen.",
  projectAnswerAndRetry: "Bestätigen und erneut anlegen",
  projectBlockerStale:
    "Die Bestätigungen passen nicht mehr zur Prüfung. Erneut prüfen setzt sie zurück.",
  projectBlockerName: "Zuerst einen Namen eintragen.",
  projectBlockerCheck: "Zuerst prüfen lassen.",
  projectBlockerExternal:
    "{count, plural, one {# externe Quelle ist} other {# externe Quellen sind}} noch nicht bestätigt.",
  projectErrorDirectoryTaken: "Ein Ordner mit diesem Namen ist schon belegt.",
  projectErrorNameInvalid: "Dieser Name taugt nicht als Projekt- und Ordnername.",
  projectErrorLocked: "Dieser Ordner ist gegen Selbstverwaltung gesperrt.",
  // ── Härtungsbefunde mit Erklärung (#8) ─────────────────────────────────────
  hardeningSeverityDelegationLock: "Kritisch",
  hardeningSeverityWarning: "Warnung",
  hardeningSeverityNotice: "Hinweis",
  hardeningSeverityUnknown: "Unbekannt",
  hardeningService: "Service {service}",
  hardeningConfirmFinding: "Befund an Service {service} bestätigen",
  hardeningDelegationLockNote:
    "Ein kritischer Befund heißt: Der Container kann den Host übernehmen, oder das ist nicht auszuschließen. Der Agent erlaubt verändernde Aktionen daran nur über den internen Zugang und protokolliert sie gesondert; extern bleiben sie gesperrt.",
  hardeningRuleDockerSocket: "Docker-Socket eingehängt",
  hardeningRuleDockerSocketText:
    "Über den Docker-Socket kann der Container weitere Container starten, auch privilegierte mit dem Dateisystem des Hosts. Das entspricht Root-Zugriff auf den Host.",
  hardeningRuleSelfMount: "Verwaltungsverzeichnis eingehängt",
  hardeningRuleSelfMountText:
    "Der Mount erreicht ein Verzeichnis, das den Betrieb des Agenten oder Hubs trägt, etwa Geheimnisse und Schlüssel. Ein übergeordnetes Verzeichnis wie / zählt genauso. Der Container könnte damit die Verwaltung selbst umschreiben.",
  hardeningRuleVolumeUnresolved: "Volume nicht prüfbar",
  hardeningRuleVolumeUnresolvedText:
    "Docker lieferte zu diesem benannten Volume keine Angaben. Ob es auf einen Pfad des Hosts zeigt, ist nicht belegt; der Agent behandelt es deshalb wie einen kritischen Mount.",
  hardeningRulePrivileged: "Privilegierter Modus",
  hardeningRulePrivilegedText:
    "privileged: true gibt dem Container alle Capabilities und alle Geräte des Hosts und schaltet AppArmor und Seccomp ab. Ein Ausbruch auf den Host braucht dann keine weitere Lücke.",
  hardeningRuleHostNamespace: "Namensraum des Hosts geteilt",
  hardeningRuleHostNamespaceText:
    "Mit pid, ipc oder network im Modus host teilt der Container diesen Namensraum mit dem Host. Er sieht dessen Prozesse, gemeinsamen Speicher oder Netzwerkschnittstellen und kann auf sie einwirken.",
  hardeningRuleSensitivePath: "Systemverzeichnis eingehängt",
  hardeningRuleSensitivePathText:
    "Der Mount öffnet ein Betriebs- oder Systemverzeichnis des Hosts wie /etc, /root, /proc, /run oder /var/lib/docker. Auch schreibgeschützt gibt er Einblick in Konfiguration und Zugangsdaten.",
  hardeningRuleOutsideBase: "Mount außerhalb der Projektordner",
  hardeningRuleOutsideBaseText:
    "Die Quelle liegt nicht unterhalb eines Projektordners im Basispfad des Agenten. Der Container erreicht damit Daten, die kein Projekt verwaltet.",
  hardeningRuleOutsideUniverse: "Mount in einem fremden Projektordner",
  hardeningRuleOutsideUniverseText:
    "Dieser Container ist geschützt; für ihn sind nur Quellen unterhalb seines eigenen Projektordners vorgesehen.",
  hardeningRuleCapability: "Gefährliche Capability",
  hardeningRuleCapabilityText:
    "Eine zusätzliche Linux-Capability wie SYS_ADMIN, NET_ADMIN oder SYS_PTRACE erweitert, was der Container am Kernel des Hosts tun darf.",
  hardeningRuleDevice: "Gerät durchgereicht",
  hardeningRuleDeviceText: "Der Container greift direkt auf ein Gerät des Hosts zu, etwa eine Grafikeinheit.",
  hardeningRuleUnconfined: "AppArmor oder Seccomp abgeschaltet",
  hardeningRuleUnconfinedText: "Ein Schutzprofil, das die Systemaufrufe des Containers begrenzt, ist ausgeschaltet.",
  hardeningRuleNoNewPrivileges: "no-new-privileges fehlt",
  hardeningRuleNoNewPrivilegesText: "Prozesse im Container können über setuid-Programme zusätzliche Rechte erlangen.",
  hardeningRuleCapDrop: "Capabilities nicht abgelegt",
  hardeningRuleCapDropText: "Ohne cap_drop: ALL behält der Container den vollständigen Standardsatz von Docker.",
  hardeningRuleLimits: "Ressourcengrenze fehlt",
  hardeningRuleLimitsText: "Ohne Grenze für Speicher, CPU oder Prozesse kann der Container den Host auslasten.",
  hardeningRuleLogging: "Log ohne Größengrenze",
  hardeningRuleLoggingText: "json-file ohne max-size lässt das Log unbegrenzt wachsen, bis der Datenträger voll ist.",
  hardeningRuleUnknownText:
    "Diese Regel kennt der Hub nicht. Der Befund steht so da, wie der Agent ihn meldet.",
  hardeningConfirmNote:
    "Bestätigt wird genau diese Liste. Bringt der nächste Versuch einen weiteren Befund, fragt der Agent erneut; seine Schutzregeln bleiben dabei unverändert.",
  hardeningConfirmMissing:
    "{count, plural, one {# Befund ist} other {# Befunde sind}} noch nicht einzeln bestätigt."
};
