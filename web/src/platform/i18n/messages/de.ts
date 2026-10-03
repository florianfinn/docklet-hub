// Deutsch — die erste Sprache.
//
// Der ORT, an dem sichtbarer Text steht, ist das Verzeichnis
// web/src/platform/i18n/messages/ — diese Datei und en.ts daneben. „Der einzige Ort,
// an dem sichtbarer Text steht" stand hier, solange es nur diese eine Datei
// gab; seit der zweiten Sprache (#70) sind es zwei Dateien und ein Ort. Die
// Regel dazu steht in AGENTS.md, der Wächter in web/tests/ui-texts.test.mjs.
//
// Warum von der ersten Zeile an und nicht später: ein Text, der einmal im JSX
// steht, wird beim nachträglichen Herauslösen nie vollständig gefunden — es
// bleibt immer eine Fehlermeldung, ein Tooltip, ein leerer Zustand übrig.

// ⚠️ Kein `as const`. Mit ihm trüge jeder Wert seinen eigenen Literaltyp
// (`"Docker-Verwaltung"` statt `string`), und `typeof de` wäre als Vertrag für
// eine zweite Sprache unbrauchbar: `appTitle: "Docker management"` fällt dann
// mit TS2322 durch (gemessen am 2026-09-05 gegen `npx tsc --noEmit`). Gebraucht
// werden die Schlüssel, nicht die deutschen Zeichenketten.

// ⚠️ DIE SPRACHDATEI IST SEIT PAKET B6, ETAPPE E6 (#5) GETEILT. `de.ts` stand
// bei 967 Zeilen von 1.000 (`web/tests/source-file-size.test.mjs`, gezählt als
// `split("\n").length`), und der Reiter „Shell" braucht rund dreißig
// Schlüssel — sie passten nicht mehr hinein. Ein Teil ist eine flache Datei
// `de-<thema>.ts` daneben und wird hier eingesetzt; `en.ts` tut dasselbe mit
// `en-<thema>.ts`.
//
// ⚠️ EINE TEILUNG, DIE EINEN WÄCHTER BLIND MACHT, IST KEINE TEILUNG. Eine
// Gruppe (`shell: { … }`) wäre stiller gewesen und hätte
// `web/tests/languages.test.mjs` genau das genommen, was er hält: er liest die
// OBERSTE Ebene eines FLACHEN Literals. Er ist in derselben Änderung erweitert
// worden und liest nun jede Teildatei mit — die sechs Zusicherungen gelten für
// alle Teile.

export const de = {
  // The tab bar of the stack page. The texts of the tabs themselves live in
  // the features `logs` and `compose` (`web/src/features/<name>/messages/`).
  stackTabsLabel: "Reiter dieses Stacks",
  stackTabOverview: "Übersicht",
  stackTabLogs: "Protokoll",

  appTitle: "docklet hub",

  // Gemeinsames
  loading: "Wird abgefragt …",
  retry: "Erneut versuchen",
  signOut: "Abmelden",
  cancel: "Abbrechen",
  done: "Fertig",

  roleAdmin: "Administrator",
  roleUser: "Benutzer",
  roleUnknown: "Rolle unbekannt: {role}",

  // Die Seite eines Stacks (D6b). „Übersicht" steht hinter einem Pfeil nach
  // links — das „‹" des Artboards ist ein Zeichen und kein Wort.
  stackBack: "Übersicht",
  stackOnHost: "auf {host}",
  stackContainersTitle: "Container des Stacks",
  stackNotFoundTitle: "Diesen Stack gibt es nicht.",
  stackNotFoundBody:
    "Ein Stack hat im Hub keine Kennung — er kommt aus der Antwort des Agenten. Wurde der Host entfernt oder der Stack gestoppt, führt seine Adresse ins Leere.",

  // Sichtbar steht am Stack nur „6/8“. Dieser Satz reist unsichtbar mit und
  // ist das, was ein Screenreader vorliest — ein Schrägstrich zwischen zwei
  // Zahlen wird sonst als „sechs acht“ angesagt.
  stackRunningOf: "{running} von {total} laufen",
  containersFailed: "Die Container konnten nicht geholt werden.",

  // Die Detailseite EINES Containers mit ihren zwei Reitern (#5, Etappe H3).
  //
  // ⚠️ Der Rücksprung heißt hier „Zurück zur Übersicht" und nicht „Übersicht"
  // wie auf der Stack-Seite: auf dieser Fläche heißt schon ein REITER so, und
  // zwei gleich benannte Ziele nebeneinander sind eines zu viel.
  containerBack: "Zurück zur Übersicht",
  containerOnHost: "auf {host}",

  // ⚠️ „Gibt es nicht" ist ein NORMALFALL und keine Störung: die Adresse hängt
  // am Namen, und der Container kann seit dem letzten Laden verschwunden sein.
  // Der Text sagt deshalb, warum das so gebaut ist — sonst sucht der Betreiber
  // einen Fehler, den es nicht gibt.
  containerNotFoundTitle: "Diesen Container gibt es nicht.",
  containerNotFoundBody:
    "Die Adresse dieser Seite hängt am NAMEN des Containers, denn seine Kennung wechselt bei jedem Neuerstellen. Wurde der Container entfernt, umbenannt oder aus der Allowlist des Arms genommen, führt seine Adresse ins Leere — das ist der Normalfall und keine Störung.",

  // Die Reiterleiste. Sie besteht aus Verweisen, und der Reiter steht in der
  // Adresse: ein Neuladen landet wieder dort, wo der Mensch war.
  containerTabsLabel: "Reiter dieses Containers",
  containerTabOverview: "Übersicht",
  containerTabLogs: "Protokoll",

  // Die Tafel im Reiter „Übersicht". Übersetzt sind die BESCHRIFTUNGEN; der
  // Statustext daneben kommt wörtlich von Docker und bleibt, wie er ist.
  containerImage: "Abbild",
  containerAgentStatus: "Status laut Agent",
  containerStartedAt: "Gestartet",
  containerStack: "Stack",

  // Ein fremdverwalteter Container (#124). Der Hinweis nennt, was hier NICHT
  // geht — Update, Neuerstellen, Entfernen —, alles andere läuft wie bei jedem
  // anderen Container.
  //
  // ⚠️ Eigene Sätze und nicht die aus `overview/external-management.tsx`: die
  // sprechen über eine GRUPPE („Diese Container legt Unraid …"), und auf einer
  // Fläche mit genau einem Container stünde ein Plural über einem Einzelstück.
  containerExternalTitle: "Diesen Container verwaltet {manager}.",
  containerExternalDefinition:
    "Protokoll, Dateien, Shell sowie Start und Stopp gehen wie bei jedem anderen Container. Update, Neuerstellen und Entfernen macht {manager} selbst: der Arm lehnt sie vom Hub ab, weil {manager} sie beim nächsten Update aus seiner Vorlage zurückbauen würde.",

  // Größen in binären Vorsätzen, wie `ls -lh` und `du -h` sie zeigen. Zahl und
  // Einheit stehen als Satz da, weil ihre Stellung nicht in jeder Sprache
  // dieselbe ist.
  //
  // Sizes stay here and not in `features/files/` (#263): the metrics and the
  // load of an arm show them too, through `byteSize` in `platform/i18n/`.
  fileSizeBytes: "{value} B",
  fileSizeKibibytes: "{value} KiB",
  fileSizeMebibytes: "{value} MiB",
  fileSizeGibibytes: "{value} GiB",

  valueUnknown: "—",

  hostsEmpty: "Es ist noch kein Host eingetragen.",
  hostsFailed: "Die Hosts konnten nicht geholt werden.",

  // Die Zähler im Kopf des Bildschirms und im Kopf jeder Karte: „4 Hosts · 34
  // verwaltet · 30 laufen" und „3 Stacks · 21 Container · 18 laufen".
  //
  // ⚠️ Als ICU-Mehrzahl und NICHT als Zahl plus Wort im JSX. Der erste Entwurf
  // reihte beides nebeneinander und schrieb damit „1 Stacks" und „1 laufen" —
  // gemessen am 2026-09-05 an einem Host mit einem einzigen Stack. Die Mehrzahl
  // ist nichts, was die Oberfläche zusammensetzen kann: sie hängt an der
  // Sprache, und genau dafür gibt es diese Dateien. `#` ist die Zahl selbst.
  hostsCount: "{count, plural, one {# Host} other {# Hosts}}",
  hostStacksCount: "{count, plural, one {# Stack} other {# Stacks}}",
  hostContainersCount: "{count, plural, one {# Container} other {# Container}}",
  hostRunningCount: "{count, plural, one {# läuft} other {# laufen}}",

  hostStatusPending: "wartet auf Registrierung",
  hostStatusOnline: "online",
  hostStatusOffline: "offline",
  hostStatusOutdated: "veraltet",
  hostStatusUnknown: "Zustand unbekannt: {status}",
  hostStatusOutdatedHint:
    "Der Agent meldet eine Fassung oder ein Protokoll unter dem, was dieser Hub versteht, oder gar keine Angabe. Schreibende Aktionen bleiben so lange gesperrt; die Anleitung zum Umstieg steht auf der Karte.",

  // Der Theme- und Farbeditor (D7a, #62). Was der Betreiber hier liest, sind
  // die Stufen aus contract/src/presets.ts — dort stehen sie englisch als
  // BEZEICHNER („amber", „head"), weil sie zugleich die Attributwerte in
  // web/src/platform/theme/palette.css und die Kennungen in der Ablage sind. Die
  // Zuordnung Stufe → Schlüssel steht in
  // web/src/platform/i18n/theme-labels.ts.
  settingsAdminOnly: "Ändern kann diese Einstellung nur ein Administrator.",

  // Die Einrückung EINES Stacks (D7b/C2, #62; docs/design/hub-color-and-structure.md §4).
  stackIndentTitle: "Einrückung",
  // ⚠️ Der Satz sagt, WO die Einrückung wirkt. Auf der Seite eines Stacks
  // selbst ist von ihr nichts zu sehen — dort steht ohnehin nur dieser eine
  // Stack —, und ein Schalter ohne sichtbare Wirkung sieht kaputt aus.
  stackIndentHint:
    "Sie wirkt in der Übersicht und unter „Container“: dort stehen die Container dieses Stacks unter ihm.",
  stackIndentFailed: "Die Einrückung konnte nicht gespeichert werden.",

  // Die zwei Darstellungen einer Marke. Die Namen sagen, was zu sehen ist, und
  // nicht, wie die Stufe in der Ablage heißt („label“, „fill“).
  // Die zwei Stufen der Einrückung. Wie überall in D7 sagen die Namen, was zu
  // sehen ist, und nicht, wie die Stufe in der Ablage heißt („nested", „flat").
  themeIndentNested: "eingerückt",
  themeIndentFlat: "bündig",

  themeMarkStyleLabel: "Beschriftung",
  themeMarkStyleFill: "Fläche",

  // Die sieben Töne des Vorrats. Die Namen sind die des Artboards
  // (hub-palette.html Z. 802–820) und benennen die Farbe, die zu sehen ist —
  // nicht den Bezeichner, unter dem sie gespeichert liegt.
  themeHueAmber: "Orange",
  themeHueGreen: "Grasgrün",
  themeHueTeal: "Türkis",
  themeHueBlue: "Blau",
  themeHueViolet: "Lila",
  themeHueRose: "Rosa",
  themeHueNeutral: "Grau",

  // Die vier Stufen des Farbeinsatzes am Host. „ohne Farbe" und „nur Kante"
  // tragen dieselben Flächen und unterscheiden sich allein in der Kante —
  // deshalb zwei Namen und nicht einer.
  themeInkNone: "ohne Farbe",
  themeInkEdge: "nur Kante",
  themeInkHead: "Kopf getönt",
  themeInkCard: "Karte getönt",

  // Die elf globalen Stellschrauben aus THEME_KNOBS mit scope „global" —
  // sieben aus D7a, vier für das Terminal aus B6 (#5).
  themeKnobScheme: "Schema",
  themeKnobChroma: "Sättigung",
  themeKnobRadius: "Rundung",
  themeKnobDensity: "Dichte",
  themeKnobFont: "Schrift",
  themeKnobCharts: "Diagrammfarben",
  themeKnobFocus: "Fokusring",

  themeSchemeDark: "dunkel",
  themeSchemeLight: "hell",
  themeChromaSubtle: "zurückhaltend",
  themeChromaNormal: "normal",
  themeChromaBold: "kräftig",
  themeRadiusSharp: "kantig",
  themeRadiusSoft: "weich",
  themeRadiusRound: "rund",
  themeDensityNormal: "normal",
  themeDensityCompact: "kompakt",
  themeFontPlex: "IBM Plex",
  themeFontSystem: "Schrift des Systems",
  themeChartsRotate: "Farbton gedreht",
  themeChartsMono: "einfarbig",
  themeFocusHue: "im Farbton der Umgebung",
  themeFocusNeutral: "neutral",

  // Das Terminal der Shell (B6, #5). Die Stufen benennen, was der Betreiber
  // SIEHT, und nicht den Bezeichner, unter dem es gespeichert liegt: „sunken"
  // ist der Schlüssel, „eine Stufe tiefer" die Auskunft.
  themeKnobTerminalScheme: "Schema des Terminals",
  themeKnobTerminalSurface: "Fläche des Terminals",
  themeKnobTerminalSize: "Schriftgröße im Terminal",
  themeKnobTerminalScrollback: "Verlauf im Terminal",

  themeTerminalSchemeFollow: "wie der Hub",
  themeTerminalSchemeDark: "immer dunkel",
  themeTerminalSurfaceCard: "wie die Karte",
  themeTerminalSurfaceSunken: "eine Stufe tiefer",
  themeTerminalSurfaceInk: "die tiefste Stufe",
  themeTerminalSizeSmall: "klein (12 px)",
  themeTerminalSizeNormal: "normal (13 px)",
  themeTerminalSizeLarge: "groß (15 px)",
  // Zeilen im Browser, keine Angabe an den Agenten — der kennt keinen Verlauf.
  themeTerminalScrollbackShort: "1.000 Zeilen",
  themeTerminalScrollbackNormal: "5.000 Zeilen",
  themeTerminalScrollbackLong: "20.000 Zeilen",

  // Die Tafel „Terminal" selbst (B6, #5) — eine eigene Karte und keine vier
  // weiteren Zeilen in „Darstellung": die sieben dort wirken auf jede Fläche
  // des Hubs, diese vier auf genau einen Reiter.
  settingsTerminalTitle: "Terminal",
  settingsTerminalHint:
    "Diese vier Angaben gelten für das Terminal der Shell — hubweit und für jeden Benutzer. Vorgabe ist ein dunkles Terminal, auch wenn der Hub hell steht.",
  // ⚠️ Der Satz behauptet ausdrücklich KEINE Vergangenheit. Die Zeilenzahl ist
  // Speicher im Browser; der Agent kennt keinen Verlauf und schickt, was
  // kommt. Ein Text wie „5.000 Zeilen Vergangenheit" wäre eine Zusage, die
  // niemand einlöst.
  settingsTerminalScrollbackHint:
    "So viele Zeilen behält der Browser zum Zurückrollen, solange der Reiter offen ist. Nachgeliefert wird nichts: der Agent kennt keinen Verlauf, und was vor dem Öffnen lief, ist nirgends aufgehoben.",
  settingsTerminalSave: "Speichern",
  settingsTerminalSaving: "Wird gespeichert …",
  settingsTerminalSaved: "gespeichert",
  settingsTerminalFailed: "Die Einstellungen des Terminals konnten nicht gespeichert werden.",

  themeAreaOperations: "Betrieb",
  themeAreaManagement: "Profil & Einstellungen",
  themeAreaOperationsTone: "Stahlblau",
  themeAreaManagementTone: "Magenta",
  themeAreaOperationsScope: "Übersicht, Container, Hosts",
  themeAreaManagementScope: "alles hinter dem Profil-Knopf",

  // Übernommene Bausteine unter web/src/platform/ui/shadcn/ — sichtbarer und vom
  // Screenreader gelesener Text, der in der Registry-Vorlage auf Englisch mitkam.
  uiClose: "Schließen",
  uiSidebar: "Seitenleiste",
  uiSidebarMobileDescription: "Zeigt die Seitenleiste für mobile Geräte.",
  uiSidebarToggle: "Seitenleiste ein- und ausklappen",
  uiBreadcrumbNav: "Brotkrümelnavigation",
  uiBreadcrumbMore: "Weitere Einträge",
  uiCommandPaletteTitle: "Befehlspalette",
  uiCommandPaletteDescription: "Nach einem Befehl suchen, um ihn auszuführen",

  // Die Schale (D3): Seitenleiste, Kopfzeile, Namensschild und die ⌘K-Suche.
  // Auch die Tastenkombination steht hier — sie wird angezeigt und ist damit
  // sichtbarer Text wie jeder andere.
  navGroupOperations: "Betrieb",
  navOverview: "Übersicht",
  navContainers: "Container",
  navHosts: "Hosts",

  shellSearch: "Suchen",
  shellSearchShortcut: "⌘K",
  shellSearchPlaceholder: "Bildschirm suchen …",
  shellSearchEmpty: "Kein Eintrag gefunden.",

  // Beschriftung des Namensschild-Knopfs unten links. Sichtbar ist dort Name
  // und Rolle; diese Zeile liest der Screenreader und sagt, was der Knopf tut.
  shellAccountMenu: "Konto und Abmelden",

  // ⚠️ EIN SATZ FÜR VIER FLÄCHEN (#188): Protokoll, Dateien, Compose und Shell
  // bekommen dieselbe Abweisung von derselben Stelle — der Herkunftsprüfung
  // des Hubs. Er nennt den HUB und den BROWSER, denn der Arm hat die Anfrage
  // nie gesehen; der Satz über die Allowlist schickte die Suche dorthin.
  errorOriginRefused:
    "Der Hub hat die Anfrage abgewiesen, bevor sie den Arm erreichte: der Browser hat sich nicht als diese Oberfläche ausgewiesen. Häufigster Fall: der Browser sendet keinen Referer. Lade die Seite über die Adresse des Hubs neu.",

  // Die Sprachschicht (#70). Diese Meldung braucht der LanguageProvider:
  // schlägt das Speichern fehl, stellt er die Sprache zurück und sagt, dass er
  // es getan hat.
  languageSaveFailed: "Die Sprache konnte nicht gespeichert werden.",

  // Die Überschrift über den Sprachen im Namensschild-Menü unten links.
  languageLabel: "Sprache",

  // ⚠️ Die Sprachnamen stehen in IHRER EIGENEN Sprache und sind deshalb in
  // de.ts und en.ts WORTGLEICH: „Deutsch" bleibt „Deutsch", auch wenn die
  // Oberfläche gerade Englisch spricht, und „English" bleibt „English", auch
  // wenn sie Deutsch spricht. Das ist keine vergessene Übersetzung, sondern
  // der Zweck des Umschalters: wer die aktuelle Oberfläche nicht lesen kann,
  // sucht darin nach dem einen Wort, das er kennt. Stünde hier „Englisch",
  // fände er es nicht — und der Umschalter wäre genau für den unbrauchbar,
  // der ihn braucht.
  languageGerman: "Deutsch",
  languageEnglish: "English",
};
