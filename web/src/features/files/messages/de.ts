// German texts of the feature `files` (#263): the tab "Dateien" of a container
// with the share chooser, the directory list, the text editor, the upload and
// the folder actions. German is the source of the message type; `en.ts` closes
// with `satisfies typeof deFiles`.
//
// Put together with the texts of every other surface in
// `web/src/app/i18n/messages.ts`; `platform/` may not import a feature.
//
// ⚠️ THE FOUR SIZE UNITS ARE NOT HERE. `fileSizeBytes` and its three siblings
// stay in `platform/i18n/messages/`: the metrics of a container and the load
// of an arm show sizes too, through `byteSize` in `platform/i18n/byte-size.ts`,
// and they may not import a feature.
//
// ⚠️ A FLAT LITERAL, NO GROUP `files: { … }`. `web/tests/languages.test.mjs`
// reads the top level of a flat literal; a second level would be invisible to
// it, and its assertions would fall away without a test going red.

export const deFiles = {
  filesBlockerSourceUnknown: "Die Quelle ist nicht bekannt.",
  filesBlockerSourceProtected: "Die Quelle ist geschützt.",
  filesBlockerSourceShared: "Andere Container verwenden diese Quelle.",
  filesBlockerSourceOwnershipUnknown: "Die Zuordnung der Quelle ist unklar.",
  filesBlockerSourceReadOnly: "Die Quelle ist nur lesbar.",
  filesBlockerBackupDirectoryProtected: "Das Sicherungsverzeichnis ist gesperrt.",
  filesBlockerNotMounted: "Die Quelle ist nicht gemountet.",
  filesBlockerAgentReadOnly: "Der Agent erlaubt nur Lesezugriff.",
  filesBlockerNotAllowlisted: "Der Container ist nicht freigegeben.",
  filesBlockerNameNotUsableAsDirectory: "Der Projektname ist kein gültiger Verzeichnisname.",
  filesBlockerInvalidComposeFileName: "Der Compose-Dateiname ist ungültig.",
  filesBlockerComposeProjectNameMissingOrInvalid: "Der Compose-Projektname fehlt oder ist ungültig.",
  filesBlockerProjectDirOutsideBasePath: "Das Projekt liegt außerhalb des freigegebenen Bereichs.",
  filesBlockerSelfManagementLocked: "Agent und Hub können sich hier nicht selbst verwalten.",
  filesBlockerComposeFileMissing: "Die Compose-Datei fehlt.",
  filesBlockerComposeAnchorLabelsMissing: "Der bestätigte Compose-Anker fehlt.",
  filesBlockerComposeAnchorOutsideBasePath: "Der Compose-Anker liegt außerhalb des freigegebenen Bereichs.",
  filesBlockerComposeAnchorFileAmbiguous: "Der Compose-Anker benennt mehrere Dateien.",
  filesBlockerDirectoryTaken: "Das Projektverzeichnis ist bereits belegt.",
  filesBlockerStackServiceNotAllowlisted: "Nicht alle Dienste sind freigegeben.",
  filesBlockerExternallyManaged: "Die Definition wird extern verwaltet.",
  filesBlockerComposeHashMissing: "Der Inhaltshash der Compose-Datei fehlt.",
  filesBlockerConfirmationMissing: "Eine erforderliche Bestätigung fehlt.",
  filesBlockerTooManyStreams: "Es sind zu viele Datenströme geöffnet.",
  filesBlockerStackBusy: "Für dieses Projekt läuft bereits eine Änderung.",
  filesBlockerPathEmpty: "Ein Dateipfad fehlt.",
  filesBlockerPathAbsolute: "Der Pfad muss relativ sein.",
  filesBlockerPathTraversal: "Der Pfad enthält unzulässige Abschnitte.",
  filesBlockerPathInvalidCharacters: "Der Pfad enthält unzulässige Zeichen.",
  filesBlockerPathBlocked: "Diese Datei hat einen geschützten Bearbeitungsweg.",
  filesBlockerPathOutside: "Der Pfad liegt außerhalb der Quelle.",
  filesBlockerFileReplaced: "Die Datei wurde während des Zugriffs ausgetauscht.",
  filesBlockerNotReadable: "Die Quelle ist nicht lesbar.",
  filesBlockerNotWritable: "Die Dateirechte verhindern das Schreiben.",
  filesBlockerWrongKind: "Der Eintrag hat einen ungeeigneten Dateityp.",
  filesBlockerNotATextFile: "Der Inhalt ist kein gültiger UTF-8-Text.",
  filesBlockerTooLarge: "Der Inhalt überschreitet die Größengrenze.",
  filesBlockerAlreadyExists: "Das Ziel existiert bereits. Wähle einen anderen Namen.",
  filesBlockerFileChangedExternally: "Die Datei wurde extern geändert.",
  filesBlockerExpectedHashMissing: "Der Inhaltshash aus dem Laden fehlt.",
  filesBlockerBusy: "Für dieses Projekt läuft bereits eine Änderung.",
  filesSourcesLabel: "Mount-Quelle wählen",
  filesSourceProject: "Projekt",
  filesSourceExternal: "Externer Bind-Mount",
  filesSourceVolume: "Benanntes Volume",
  filesSourceWritable: "Beschreibbar",
  filesSourceReadOnly: "Nur lesbar",

  // Der Reiter selbst.
  containerTabFiles: "Dateien",

  // ── Die Datei-Fläche (Web-FTP), Paket B5 Etappe E5a (#5) ─────────────────
  //
  // Zwei Zustände, und der erste ist der wichtigere: ohne gewählte Freigabe
  // gibt es keinen Dateizugriff, und das ist keine Störung, sondern die
  // Entscheidung des Betreibers, die noch aussteht.

  // Die Wahl der Freigabe.
  filesShareTitle: "Für diesen Container ist noch keine Freigabe gewählt.",
  filesShareBody:
    "Ohne Freigabe gibt es keinen Dateizugriff — der Arm weist jede Anfrage ab, und zwar zu Recht: was zugänglich ist, entscheiden Sie und nicht die Oberfläche. Gewählt werden kann nur, was hier steht: die Bind-Mounts dieses Containers unterhalb seines Projektverzeichnisses.",
  filesShareChoose: "Wählen",
  filesSharePending: "Wird gewählt …",
  filesShareDestination: "im Container unter {destination}",
  filesShareWritable: "schreibbar gemountet",
  filesShareReadOnly: "nur lesbar gemountet",
  filesShareRelease: "Freigabe zurücknehmen",
  filesCurrentShare: "Freigabe: {share}",

  // ⚠️ Ein Container ohne Kandidaten bekommt eine Erklärung und keine leere
  // Liste: die leere Antwort ist vollständig und richtig, und eine leere
  // Tabelle sähe aus wie eine Störung oder wie ein halbes Laden.
  filesShareNoneTitle: "Dieser Container hat keine Freigabe, die sich wählen ließe.",
  filesShareNoneBody:
    "Als Freigabe taugt nur ein Bind-Mount unterhalb des Projektverzeichnisses dieses Containers. Dieser hier hat keinen — seine Daten liegen in einem benannten Volume, im Abbild selbst oder außerhalb des Projektverzeichnisses. Das ist eine vollständige Antwort und keine Störung.",

  // Die Liste eines Verzeichnisses.
  filesColumnName: "Name",
  filesColumnKind: "Art",
  filesColumnSize: "Größe",
  filesColumnChanged: "Geändert",
  filesColumnActions: "Aktionen",
  filesRootLabel: "Wurzel der Freigabe",
  filesUp: "Eine Ebene höher",
  filesEmpty: "Dieses Verzeichnis ist leer.",
  filesDownload: "Herunterladen",

  // ⚠️ Der Hinweis am gekürzten Verzeichnis ist keine Zierde: eine Liste, die
  // an der Obergrenze des Arms endet, sieht vollständig aus. Die ZAHL steht
  // nicht darin — sie ist eine Grenze des Agenten und gehört in seinen Vertrag,
  // nicht in einen Satz der Oberfläche.
  filesTruncated:
    "Diese Liste ist gekürzt: das Verzeichnis enthält mehr Einträge, als der Arm in einer Antwort schickt. Was hier nicht steht, ist deshalb nicht weg.",

  // Die Diagnose. Sie sagt, was in DIESEM Verzeichnis geht — und „keine
  // Auskunft" ist nicht dasselbe wie „nein".
  filesDiagnosticsReadable: "lesbar",
  filesDiagnosticsNotReadable: "nicht lesbar",
  filesDiagnosticsDeletable: "Umbenennen und Löschen erlaubt",
  filesDiagnosticsNotDeletable: "Umbenennen und Löschen gesperrt",
  filesDiagnosticsUploadable: "im Container schreibbar",
  filesDiagnosticsNotUploadable: "im Container nur lesbar",
  filesDiagnosticsOwner: "Eigentümer {uid}:{gid}",
  filesDiagnosticsNone:
    "Der Arm konnte dieses Verzeichnis nicht beurteilen. Das heißt: keine Auskunft — und nicht etwa, dass hier nichts erlaubt wäre.",

  // Die vier Arten, die der Arm nennt. Sie werden gespiegelt und nicht
  // übersetzt — ein fünfter, unbekannter Wert steht roh da.
  fileKindFile: "Datei",
  fileKindDirectory: "Verzeichnis",
  fileKindSymlink: "Verweis",
  fileKindOther: "Anderes",

  fileValueNone: "—",

  // Die Fehler der Datei-Fläche, je Ursache einer. Ein gesammeltes
  // „Fehlgeschlagen" nähme genau die Auskunft, wegen der jemand hinschaut.
  fileErrorInvalidPath: "Dieser Pfad ist keine Angabe, mit der der Arm arbeiten kann.",
  fileErrorForbidden:
    "Der Arm weist den Zugriff ab. Er führt die Liste der freigegebenen Container selbst; steht dieser nicht darin, hilft keine Wiederholung.",
  fileErrorNotFound: "Diesen Pfad gibt es in der Freigabe nicht mehr.",
  fileErrorShareUnknown:
    "Dieser Pfad ist kein Bind-Mount dieses Containers. Gewählt werden kann nur, was die Kandidatenliste führt — sie kann sich geändert haben, seit diese Seite geladen wurde.",
  // ⚠️ Die drei „409" dieser Fläche bekommen drei Sätze und nicht einen: „keine
  // Freigabe gewählt", „dieser Pfad ist keine" und „der Arm hat abgelehnt" sind
  // drei verschiedene Lagen. Bis Etappe E5b stand für alle drei der Satz
  // darüber, und wer im zweiten Reiter die Freigabe zurücknahm, las im Editor
  // etwas über einen Pfad, den er nie eingegeben hat.
  fileErrorShareUnset:
    "Für diesen Container ist keine Freigabe mehr gewählt. Vermutlich wurde sie zurückgenommen, während diese Seite offen war — laden Sie sie neu, dann steht die Wahl wieder da.",
  fileErrorAgentConflict:
    "Der Arm hat diesen Zugriff abgelehnt. Sein Stand über diesen Container passt nicht mehr zu dem des Hubs; nach einem Neuladen der Seite sieht es anders aus.",
  fileErrorAgentUnreachable: "Der Arm dieses Hosts hat nicht geantwortet.",
  fileErrorAgentReadOnly: "Dieser Arm steht auf „nur lesen“. Solange der Kill-Switch liegt, schreibt er nichts.",
  fileErrorTooManyStreams:
    "Der Arm führt bereits die Höchstzahl gleichzeitiger Ströme. Ein geschlossener Log-Reiter oder ein beendeter Download gibt einen Platz frei.",
  fileErrorAgentTimeout: "Der Arm dieses Hosts hat zu lange gebraucht.",
  fileErrorUnknown: "Die Dateien konnten nicht geholt werden.",

  // ⚠️ DIE ZAHL STEHT NICHT IN DIESEM SATZ. Die Grenzen sind Werte des Arms und
  // stehen ausschließlich in seinem Vertrag; eine zweite Nennung — auch in
  // einem Satz der Oberfläche — wäre eine zweite Wahrheit, die altert.
  fileErrorTooLarge:
    "Diese Datei ist größer, als der Arm in einem Zug annimmt. Die Grenze steht beim Arm und nicht in dieser Oberfläche.",

  // ── Der Texteditor, Paket B5 Etappe E5b (#5) ─────────────────────────────
  //
  // ⚠️ Der Konflikt ist der wichtigste Fall dieser Fläche. Er heißt „jemand
  // anderes hat die Datei geändert" und nicht „ging nicht" — und er bietet
  // zwei Wege an, weil jeder von beiden etwas kostet.
  filesEditOpen: "Bearbeiten",
  filesEditorClose: "Editor schließen",
  filesEditorLabel: "Inhalt der Datei",
  filesEditorSave: "Speichern",
  filesEditorSaving: "Wird gespeichert …",
  filesEditorSaved: "Gespeichert.",
  filesEditorConflictTitle: "Diese Datei hat sich seit dem Laden geändert.",
  filesEditorConflictBody:
    "Jemand oder etwas anderes hat sie angefasst, während sie hier offen war. Ihr Text steht unverändert im Feld darunter — Sie müssen ihn nicht neu tippen. Entweder Sie holen den fremden Stand und verwerfen dabei Ihre Änderung, oder Sie speichern Ihre Fassung über den fremden Stand.",
  filesEditorConflictNoMerge:
    "Beide Stände nebeneinander zeigt diese Fläche nicht: der Arm meldet beim Konflikt, DASS sich etwas geändert hat, und nicht was. Wer sicher gehen will, öffnet den fremden Stand in einem zweiten Reiter.",

  // ── Hochladen ────────────────────────────────────────────────────────────
  //
  // ⚠️ Ob es geht, hängt NICHT an den Rechten des Arms, sondern daran, ob der
  // Container dieses Verzeichnis schreibbar gemountet hat. Und „keine Auskunft"
  // ist nicht dasselbe wie „nein".
  filesUploadChoose: "Datei wählen",
  // ⚠️ Dieser Satz ersetzt die Beschriftung des BROWSERS („No file chosen").
  // Sie ließe sich nicht setzen und stand als englischer Text in einer
  // deutschen Oberfläche — Sichtprüfung am 2026-09-07.
  filesUploadNone: "Keine Datei gewählt.",
  filesUploadSubmit: "Hochladen",
  filesUploadPending: "Wird hochgeladen …",
  filesUploadDone: "„{name}“ ist hochgeladen.",
  filesUploadBlocked:
    "Hierher kann nichts hochgeladen werden: der Container hat dieses Verzeichnis nur lesbar gemountet. Das ist eine Angabe über den Container und nicht über die Rechte des Arms.",
  filesUploadUnknown:
    "Ob hierher hochgeladen werden kann, ist ungeklärt — der Arm konnte dieses Verzeichnis nicht beurteilen. Der Versuch geht trotzdem hinaus; entschieden wird er dort.",

  // ⚠️ HIER STEHEN DIE ZAHLEN, bei `fileErrorTooLarge` weiter oben nicht — und
  // das ist kein Widerspruch. Dort wären sie LITERALE in dieser Datei und damit
  // eine zweite Wahrheit neben dem Vertrag des Arms; hier sind es Platzhalter,
  // die zur Laufzeit mit der Zahl aus dem Umschlag von `GET …/files` gefüllt
  // werden (#136).
  filesUploadTooLarge:
    "Diese Datei ist {size} groß, der Arm nimmt höchstens {limit} in einem Zug an. Sie wird deshalb gar nicht erst gesendet.",
  filesUploadProgress: "{sent} von {total} gesendet.",
  filesUploadCancel: "Abbrechen",
  filesUploadAborted:
    "Der Upload wurde abgebrochen. Die Datei bleibt gewählt; ein erneutes Hochladen beginnt von vorn.",

  // ── Ordner anlegen, umbenennen, löschen ──────────────────────────────────
  //
  // ⚠️ Löschen und Umbenennen brauchen das Schreibrecht am VERZEICHNIS und
  // nicht an der Datei.
  filesFolderCreate: "Ordner anlegen",
  filesFolderCreateName: "Name des neuen Ordners",
  filesFolderCreatePending: "Wird angelegt …",
  filesRename: "Umbenennen",
  filesRenameTitle: "Eintrag umbenennen",
  filesRenameBody: "„{name}“ bekommt einen neuen Namen. Der Inhalt bleibt, wo er ist.",
  filesRenameLabel: "Neuer Name",
  filesRenameSubmit: "Umbenennen",
  filesRenamePending: "Wird umbenannt …",
  filesDelete: "Löschen",
  filesDeleteTitle: "Wirklich löschen?",
  filesDeleteConfirm: "„{name}“ wird auf dem Arm entfernt.",
  filesDeleteDetail:
    "Das ist die einzige Handlung dieser Fläche, die Daten vernichtet. Der Hub hält keine Kopie, der Arm hat keinen Papierkorb, und es gibt keinen Weg zurück.",
  filesDeleteSubmit: "Endgültig löschen",
  filesDeletePending: "Wird gelöscht …",
  filesWriteBlocked:
    "Diese Aktion ist für die Quelle gesperrt. Die Archiv-API erlaubt kein sicheres Umbenennen oder Löschen ohne garantierte Werkzeuge im Zielcontainer.",
  filesWriteUnknown:
    "Ob hier geschrieben werden darf, ist ungeklärt — der Arm konnte dieses Verzeichnis nicht beurteilen. Der Versuch geht trotzdem hinaus; entschieden wird er dort.",
};
