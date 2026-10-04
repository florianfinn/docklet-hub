// German texts of the feature `hosts` (#267): the hosts screen with its cards,
// the dialog that creates an arm with the instructions for the target host,
// the removal, the reload of the archive, the agent update (#7) and the times
// on a card (#205). German is the source of the message type; `en.ts` closes
// with `satisfies typeof deHosts`.
//
// Put together with the texts of every other surface in
// `web/src/app/i18n/messages.ts`; `platform/` may not import a feature.
//
// ⚠️ THE COUNTERS AND THE STATUS MARKS ARE NOT HERE. `hostsCount`,
// `hostStacksCount`, `hostContainersCount`, `hostRunningCount`, `hostsEmpty`,
// `hostsFailed` and the six `hostStatus…` keys stay in
// `platform/i18n/messages/`: the overview, the container list and the colour
// panel of the settings show them too, `domain/hosts/host-status.tsx` is the
// status mark of all of them, and none of those may import a feature.
//
// ⚠️ A FLAT LITERAL, NO GROUP `hosts: { … }`. `web/tests/languages.test.mjs`
// reads the top level of a flat literal; a second level would be invisible to
// it, and its assertions would fall away without a test going red.

export const deHosts = {
  hostKindLocal: "lokal",
  hostKindInternal: "intern",
  hostKindExternal: "extern",
  // ⚠️ Der Rückfall für eine Art, die der Server kennt und diese Fläche nicht.
  // Er nennt den rohen Wert: „unbekannt" allein schickte den Betreiber auf die
  // Suche, ohne ihm zu sagen, wonach. Begründung in `i18n/wire-labels.ts`.
  hostKindUnknown: "Art unbekannt: {kind}",
  // Die Host-Verwaltung (Phase 4a). Vier erhobene Zustände aus §3 der Doku:
  // `pending` (Datensatz `pending`, sein Agent existiert noch nicht), `online`
  // und `offline` (beide `registered`) sowie `outdated` — der letzte sperrt
  // schreibende Routen und bekommt deshalb eine eigene, deutlich andere Farbe
  // als `offline` (`web/src/domain/hosts/host-status.tsx`).
  hostsTitle: "Hosts",
  // Zustand und Zähler sind Messungen vom Zeitpunkt des Ladens; dieser Knopf
  // ist der einzige Weg zu neuen, ohne die ganze Anwendung neu zu laden.
  hostsRefresh: "Erneut prüfen",
  hostsRefreshBusy: "Wird geprüft …",
  hostAgentVersionLabel: "Agent-Fassung",
  hostTunnelAddressLabel: "Tunneladresse",
  hostKindFieldLabel: "Art",
  hostsManagedCount: "{count} verwaltet",
  hostCreateAction: "Host hinzufügen",
  hostCreateTitle: "Host anlegen",
  hostCreateDescription:
    "Ein neuer Arm bekommt ein Archiv mit seinen Zugangsdaten. Es lässt sich nur einmal in dieser Form laden — der Dialog zeigt es gleich hier.",
  hostNameLabel: "Name",
  hostKindOptionInternal: "intern",
  hostKindOptionExternal: "extern",
  hostDockerGidLabel: "Docker-Gruppen-ID des Zielhosts",
  hostDockerGidHint:
    "Die Gruppe, der der Docker-Socket auf dem Zielhost gehört. Sie steht im Paket, das dieser Arm bekommt — ohne sie startet sein Agent nicht. Abzulesen dort mit:",
  hostDockerGidCommand: "stat -c %g /var/run/docker.sock",
  hostDockerGidPlaceholder: "z. B. 996",
  hostDockerGidInvalid: "Die Gruppen-ID ist eine ganze Zahl ab 0. Auf dem Zielhost nennt sie „stat -c %g /var/run/docker.sock“.",
  hostBindBasePathLabel: "Arbeitsverzeichnis des Zielhosts",
  hostBindBasePathHint:
    "Unterhalb dieses Pfades darf der Agent Bind-Mounts anlegen und lesen. Wo die Compose-Projekte des Zielhosts liegen, zeigt dort die Spalte CONFIG FILES von:",
  hostBindBasePathCommand: "docker compose ls",
  // ⚠️ Der Hinweis sagt ZUERST, dass das Feld leer bleiben darf, und erst
  // danach, was hineingehört. Der erste Entwurf tat es umgekehrt — er
  // beschrieb den Wert richtig („Host:Port, unter dem dieser Arm den Hub
  // erreicht") und ließ offen, WANN man ihn braucht. Beim ersten echten Arm
  // kam dazu die Rückmeldung „verstehe ich nicht ganz", und das zu Recht: von
  // den fünf Feldern des Dialogs ist dies das einzige, das in aller Regel leer
  // bleibt, und genau das stand nirgends.
  hostEndpointOverrideLabel: "Hub-Adresse für diesen Arm",
  hostEndpointOverrideHint:
    "Normalerweise leer lassen. Der Arm baut den Tunnel zu diesem Hub auf und braucht dafür dessen Adresse von außen — sie steht in der Umgebung des Hubs und gilt für alle Arme gleichermaßen. Etwas eintragen musst du nur, wenn ausgerechnet dieser Arm den Hub unter einer anderen Adresse erreicht als die übrigen, etwa aus einem anderen Netz. Ohne Portangabe gilt der Port des Hubs.",
  hostEndpointOverridePlaceholder: "leer = Adresse des Hubs",
  // Die Adresse dieses Hubs von außen (#4). Sie gehört dem HUB und nicht dem
  // einzelnen Arm — deshalb das Angebot, sie zu merken, statt sie bei jedem
  // externen Arm neu abzutippen.
  hostEndpointTarget: "Dieser Arm wird den Hub hier anwählen:",
  hostEndpointRequiredHint:
    "Für diesen Arm nötig. Die Adresse, die der Hub sonst mitgäbe, ist eine private — aus einem fremden Netz kommt darüber nichts an, und sein Tunnel käme nie zustande. Trage ein, unter welchem Namen oder welcher IP dieser Hub von außen erreichbar ist. Ohne Portangabe gilt der Port des Hubs.",
  hostEndpointRequired: "Ein externer Arm braucht die Adresse, unter der er diesen Hub von außen erreicht.",
  hostEndpointRememberHint:
    "Als Adresse dieses Hubs merken. Dann bekommt sie jeder weitere externe Arm von selbst, und wer sie später ändert, ändert sie an einer Stelle. Abwählen, wenn sie nur für diesen einen Arm gelten soll.",
  hostCreateSubmit: "Anlegen",
  hostErrorNameTaken: "Der Name ist bereits vergeben.",
  hostErrorNameInvalid:
    "Der Name darf keine Steuerzeichen wie Zeilenumbruch oder Tabulator enthalten und höchstens {max} Zeichen lang sein.",
  hostErrorPoolExhausted: "Das Tunnelnetz ist voll — kein Platz für einen weiteren Arm.",
  hostErrorInvalidInput: "Die Eingabe ist unbrauchbar.",
  hostCreateFailed: "Der Host konnte nicht angelegt werden.",
  hostArchiveDownload: "Archiv herunterladen",
  hostArchiveReload: "Archiv erneut laden",
  hostArchiveHint: "Jeder Klick rotiert Schlüsselpaar, Agent-Secret und Token neu. Ein laufender Agent mit dem alten Archiv wird dabei ausgesperrt.",
  hostArchiveReadyHint: "Das Archiv liegt bereit. Es lässt sich nur jetzt in dieser Form laden — ein erneuter Klick erzeugt ein neues und macht das alte ungültig.",
  // Die drei Schritte auf dem ZIELHOST. Ausführlich stehen sie in der README
  // im Paket — nur liest die niemand, bevor er das Paket ausgepackt hat, und
  // genau dieser Schritt ist der erste. Deshalb hier: der Ort, die Rechte, der
  // Start. Mehr nicht; alles Weitere steht daneben in der README.
  hostArchiveStepUnpackTitle: "Verzeichnis anlegen und Archiv entpacken",
  hostArchiveStepUnpack:
    "Lege auf dem Zielhost ein Verzeichnis an und entpacke das Archiv hinein. Der Ort muss einen Neustart überstehen — darin liegen der private Schlüssel und das Agent-Geheimnis, und ein zweites Exemplar gibt es nicht.",
  hostArchiveStepPermissionsTitle: "Geheimnisse schützen",
  hostArchiveStepPermissions:
    "Nimm .env und wg0.conf die Leserechte für alle anderen. Beide tragen Geheimnisse; wer sie lesen kann, kann sich als dieser Host ausgeben.",
  hostArchiveStepPermissionsCommand: "sudo chmod 600 .env wg0.conf",
  hostArchiveStepStartTitle: "Agent starten",
  hostArchiveStepStart:
    "Starte den Stack in diesem Verzeichnis. Der Agent meldet sich danach von selbst bei diesem Hub an — die Karte hier zeigt ihn nach einem Klick auf „Erneut prüfen“ als online. Die README im Archiv nennt die Gegenproben, falls er es nicht tut.",
  hostArchiveStepStartCommand: "sudo docker compose up -d",
  // Die Rückfrage vor der Rotation. Sie nennt die FOLGE und nicht die
  // Handlung: dass ein Archiv geladen wird, sieht der Betreiber am Knopf; dass
  // dabei ein arbeitender Agent stehenbleibt, sieht er nirgends.
  hostArchiveReloadTitle: "Archiv erneut laden?",
  hostArchiveReloadConfirm:
    "Das erzeugt ein neues Archiv für „{name}“ und macht das bisherige ungültig. Der Agent, der dort gerade läuft, kommt damit nicht mehr an den Hub — er braucht das neue Paket.",
  hostArchiveReloadDetail:
    "Rückgängig gibt es nicht: Schlüsselpaar, Agent-Secret und Token werden neu gewürfelt, und das alte Archiv ist danach nirgends mehr hinterlegt. Wenn der Arm läuft und du das Archiv nur aufheben wolltest, brich hier ab.",
  hostArchiveReloadSubmit: "Neues Archiv laden",
  hostRemove: "Entfernen",
  hostRemoveTitle: "Host entfernen",
  hostRemoveConfirm: "Diesen Host wirklich entfernen? Der Agent darauf läuft weiter, erreicht danach aber niemanden mehr.",
  hostRemoveFailed: "Der Host konnte nicht entfernt werden.",
  hostRemoveLocalError: "Der lokale Host lässt sich nicht entfernen.",

  hostAgentUpdate: "Agent auf v{version} aktualisieren",
  hostAgentUpdateCurrent: "Agent aktuell (v{version})",
  hostAgentUpdateTitle: "Agent aktualisieren?",
  // Der Name steht IN der Frage, aus demselben Grund wie beim Archiv: der
  // Dialog verdeckt die Karte.
  hostAgentUpdateConfirm: "Der Watcher auf {name} zieht v{version}, prüft Signatur und Fassung und tauscht erst dann den Agenten.",
  hostAgentUpdateDetail:
    "Während des Tauschs ist der Arm einige Sekunden nicht erreichbar. Startet der neue Agent nicht, rollt der Watcher auf die laufende Fassung zurück.",
  hostAgentUpdateSubmit: "Jetzt aktualisieren",
  hostAgentUpdateRunning: "Der Watcher tauscht den Agenten …",

  // Die Ausgänge des Watchers. `aborted` heißt „nichts passiert", `failed`
  // heißt „hier muss jemand nachsehen" — der Unterschied steht im Agenten
  // ausdrücklich und gehört bis hierher durchgereicht.
  hostAgentUpdateOk: "Der Agent läuft jetzt auf {version}.",
  hostAgentUpdateUnchanged: "Nichts getauscht: der Arm läuft bereits auf diesem Image.",
  hostAgentUpdateAborted: "Abgebrochen, bevor etwas getauscht wurde: {reason}",
  hostAgentUpdateRolledBack: "Der neue Agent ist nicht gestartet, der Watcher hat zurückgerollt: {reason}",
  hostAgentUpdateFailed: "Der Tausch ist gescheitert, hier muss jemand nachsehen: {reason}",
  hostAgentUpdateOutcomeUnknown: "Der Watcher meldet „{outcome}“: {reason}",
  hostAgentUpdateNoReason: "ohne Angabe",
  hostAgentUpdateTimeout: "Nach zehn Minuten noch keine Rückmeldung vom Arm. Läuft sein Watcher?",

  // Ablehnungen, bevor der Watcher etwas sieht.
  hostAgentUpdateBusy: "Auf diesem Arm läuft bereits ein Update.",
  hostAgentUpdateReadOnly: "Dieser Arm steht auf „nur lesen“ und nimmt kein Update an.",
  hostAgentUpdateUnavailable: "Für diesen Arm steht kein Update über den Watcher an. Einmal neu messen.",
  hostAgentUpdateStartFailed: "Das Update ließ sich nicht anstoßen.",
  hostAgentUpdateStartRejected: "Das Update ließ sich nicht anstoßen (Arm: „{reason}“).",

  // Ein Arm unter v0.30.0 liest das Ziel nicht. Der Schritt von Hand ist die
  // eine Zeile in seiner `.env` und ein `up -d`.
  hostAgentUpdateManual:
    "v{version} steht bereit. Dieser Agent nimmt das Ziel noch nicht an — der Schritt geht einmal von Hand: in der .env des Arms diese Zeile setzen und danach „sudo docker compose up -d“.",
  hostAgentUpdateManualLine: "DOCKER_AGENT_IMAGE={imageRef}",

  // Der Hinweis auf der Karte eines Arms mit altem Agenten (R38, #280): zu alte
  // Fassung oder zu altes Protokoll, beides dieselbe Handlung auf dem Host.
  hostMigrationTitle: "Dieser Arm braucht den Agenten dieses Hubs",
  hostMigrationBody:
    "Der Agent dieses Arms ist älter als das, was dieser Hub versteht — er läuft weiter, aber Shell, Änderungen an Dateien und Compose bleiben gesperrt, bis er umgestellt ist, und Lesendes kann am alten Protokoll scheitern. Der Schritt geht einmal von Hand auf dem Host.",
  hostMigrationStepImage: "In der .env des Arms diese Zeile setzen:",
  hostMigrationStepRestart: "Danach den Stack neu starten:",
  hostMigrationRestartCommand: "sudo docker compose up -d",

  // „29.09.26, 22:15 (vor 3 Minuten)“ — der Zeitpunkt und sein Alter.
  timeAtAgo: "{at} ({ago})",
  hostLastSeenLabel: "Zuletzt erreichbar",
  hostLastSeenNever: "noch nie",
  hostLastUpdateLabel: "Letztes Agent-Update",
  // Ein Arm, dessen Agent von Hand getauscht wurde, hat keinen Lauf des
  // Watchers — das ist kein Fehler und steht deshalb nicht als einer da.
  hostLastUpdateNone: "noch keines über den Watcher",
  hostLastUpdateUnknownTime: "Zeitpunkt unbekannt",
  hostsMeasuredAt: "Gemessen um {at}"
};
