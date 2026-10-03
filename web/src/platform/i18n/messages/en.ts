import type { de } from "./de";

// English — die zweite Sprache.
//
// Diese Datei hängt über `satisfies typeof de` an
// web/src/platform/i18n/messages/de.ts: jeder Schlüssel, der dort steht, muss hier
// stehen, und keiner darüber hinaus.
// Fehlt einer oder kommt einer zu viel vor, schlägt `tsc --noEmit` fehl —
// der Typ ist der Vertrag, keine Konvention. `satisfies` statt einer
// Typangabe an der Variablen, weil de.ts kein `as const` mehr trägt: eine
// Annotation `en: typeof de = { … } as const` prüfte dann nur noch auf
// fehlende Schlüssel, nicht mehr auf überzählige — `as const` nimmt dem
// Objektliteral die Frische, die TypeScript für die Prüfung auf
// überschüssige Eigenschaften braucht.
//
// Der Import zeigt auf "./de", weil beide Sprachdateien nebeneinander unter
// web/src/platform/i18n/messages/ liegen. Als diese Datei entstand, zog de.ts noch
// parallel von web/src/platform/i18n/de.ts hierher; solange der Zug lief, fand der
// Compiler das Modul nicht. Der Zug ist abgeschlossen — nachgemessen am
// 2026-09-05 meldet `pnpm run lint` nichts mehr (Exit-Code 0).
//
// Übersetzt wird sinngemäß, nicht wörtlich: Fachbegriffe (Container, Image,
// Host, Agent, Hub, Stack, Compose, Break-Glass, Allowlist, Endpoint,
// Tunnel, CPU) bleiben unübersetzt, kurze Tabellen- und Feldbeschriftungen
// bleiben kurz, und erklärende Absätze übertragen den Grund, nicht nur die
// Wörter. Kein gerades Apostrophzeichen in einem Wert — ICU maskiert es
// sonst; der typografische Apostroph ’ steht stattdessen.

export const en = {
  // The tab bar of the stack page. The texts of the tabs themselves live in
  // the features `logs` and `compose` (`web/src/features/<name>/messages/`).
  stackTabsLabel: "Tabs for this stack",
  stackTabOverview: "Overview",
  stackTabLogs: "Logs",

  appTitle: "docklet hub",

  // Gemeinsames
  loading: "Loading …",
  retry: "Try again",
  signOut: "Sign out",
  cancel: "Cancel",
  done: "Done",

  roleAdmin: "Administrator",
  roleUser: "User",
  roleUnknown: "Unknown role: {role}",

  stackBack: "Overview",
  stackOnHost: "on {host}",
  stackContainersTitle: "Containers of this stack",
  stackNotFoundTitle: "This stack does not exist.",
  stackNotFoundBody:
    "A stack has no identifier in the hub — it comes from the response of the agent. If the host was removed or the stack stopped, its address leads nowhere.",

  stackRunningOf: "{running} of {total} running",
  containersFailed: "The containers could not be fetched.",

  containerBack: "Back to the overview",
  containerOnHost: "on {host}",

  containerNotFoundTitle: "This container does not exist.",
  containerNotFoundBody:
    "The address of this page hangs on the NAME of the container, because its identifier changes every time it is recreated. If the container was removed, renamed or taken out of the allowlist of the agent, its address leads nowhere — that is the normal case, not a fault.",

  containerTabsLabel: "Tabs of this container",
  containerTabOverview: "Overview",
  containerTabLogs: "Logs",

  containerImage: "Image",
  containerAgentStatus: "Status reported by the agent",
  containerStartedAt: "Started",
  containerStack: "Stack",

  containerExternalTitle: "{manager} manages this container.",
  containerExternalUnknownTitle: "The manager of this container cannot be determined with certainty.",
  containerExternalUnknownDefinition:
    "It carries an Unraid manager label that does not match its other labels, already comes with the image or could not be checked against the image. The hub therefore treats it as externally managed: logs, files, shell, start and stop work, while the agent refuses updates, recreation and removal.",
  containerExternalDefinition:
    "Logs, files, shell, start and stop work as for any other container. {manager} handles updates, recreation and removal itself: the agent refuses them from the hub, because {manager} would rebuild the container from its template on the next update.",

  // Shared with the metrics and the load of an arm (`byteSize`, #263); the
  // texts of the file surface live in `features/files/messages/`.
  fileSizeBytes: "{value} B",
  fileSizeKibibytes: "{value} KiB",
  fileSizeMebibytes: "{value} MiB",
  fileSizeGibibytes: "{value} GiB",

  valueUnknown: "—",

  hostsEmpty: "No host has been added yet.",
  hostsFailed: "The hosts could not be fetched.",

  // Die Zähler im Kopf des Bildschirms und im Kopf jeder Karte, als
  // ICU-Mehrzahl — siehe die Begründung in de.ts. Im Englischen fällt die
  // Mehrzahl anders aus als im Deutschen („1 container" gegen „1 Container",
  // „2 containers" gegen „2 Container"), und genau deshalb steht sie je
  // Sprache hier und nicht im JSX.
  hostsCount: "{count, plural, one {# host} other {# hosts}}",
  hostStacksCount: "{count, plural, one {# stack} other {# stacks}}",
  hostContainersCount: "{count, plural, one {# container} other {# containers}}",
  hostRunningCount: "{count, plural, one {# running} other {# running}}",

  hostStatusPending: "awaiting registration",
  hostStatusOnline: "online",
  hostStatusOffline: "offline",
  hostStatusOutdated: "outdated",
  hostStatusUnknown: "Unknown state: {status}",
  hostStatusOutdatedHint:
    "The agent reports a version or protocol below what this hub understands, or none at all. Write actions stay locked for as long as that is the case; the steps to move it are on the card.",

  // Der Theme- und Farbeditor (D7a, #62). Die Stufen selbst stehen englisch in
  // contract/src/presets.ts und sind BEZEICHNER, keine Texte; die
  // Zuordnung Stufe → Schlüssel steht in
  // web/src/platform/i18n/theme-labels.ts.
  settingsAdminOnly: "Only an administrator can change this setting.",

  // The indentation of a single stack (D7b/C2, #62).
  stackIndentTitle: "Indentation",
  stackIndentHint:
    "It takes effect on the overview and under “Containers”, where this stack’s containers sit below it.",
  stackIndentFailed: "The indentation could not be saved.",

  // Die zwei Darstellungen einer Marke.
  themeIndentNested: "indented",
  themeIndentFlat: "flush",

  themeMarkStyleLabel: "Outline",
  themeMarkStyleFill: "Filled",

  // Die sieben Töne des Vorrats.
  themeHueAmber: "Amber",
  themeHueGreen: "Green",
  themeHueTeal: "Teal",
  themeHueBlue: "Blue",
  themeHueViolet: "Violet",
  themeHueRose: "Rose",
  themeHueNeutral: "Gray",

  // Die vier Stufen des Farbeinsatzes am Host. „no color" und „edge only"
  // tragen dieselben Flächen und unterscheiden sich allein in der Kante.
  themeInkNone: "no color",
  themeInkEdge: "edge only",
  themeInkHead: "tinted head",
  themeInkCard: "tinted card",

  // Die elf globalen Stellschrauben aus THEME_KNOBS mit scope „global" —
  // sieben aus D7a, vier für das Terminal aus B6 (#5).
  themeKnobScheme: "Scheme",
  themeKnobChroma: "Saturation",
  themeKnobRadius: "Corner radius",
  themeKnobDensity: "Density",
  themeKnobFont: "Typeface",
  themeKnobCharts: "Chart colors",
  themeKnobFocus: "Focus ring",

  themeSchemeDark: "dark",
  themeSchemeLight: "light",
  themeChromaSubtle: "subtle",
  themeChromaNormal: "normal",
  themeChromaBold: "bold",
  themeRadiusSharp: "sharp",
  themeRadiusSoft: "soft",
  themeRadiusRound: "round",
  themeDensityNormal: "normal",
  themeDensityCompact: "compact",
  themeFontPlex: "IBM Plex",
  themeFontSystem: "system typeface",
  themeChartsRotate: "hue rotated",
  themeChartsMono: "single hue",
  themeFocusHue: "from the surrounding hue",
  themeFocusNeutral: "neutral",

  // Das Terminal der Shell (B6, #5).
  themeKnobTerminalScheme: "Terminal scheme",
  themeKnobTerminalSurface: "Terminal surface",
  themeKnobTerminalSize: "Terminal font size",
  themeKnobTerminalScrollback: "Terminal scrollback",

  themeTerminalSchemeFollow: "same as the hub",
  themeTerminalSchemeDark: "always dark",
  themeTerminalSurfaceCard: "same as the card",
  themeTerminalSurfaceSunken: "one step deeper",
  themeTerminalSurfaceInk: "the deepest step",
  themeTerminalSizeSmall: "small (12 px)",
  themeTerminalSizeNormal: "normal (13 px)",
  themeTerminalSizeLarge: "large (15 px)",
  themeTerminalScrollbackShort: "1,000 lines",
  themeTerminalScrollbackNormal: "5,000 lines",
  themeTerminalScrollbackLong: "20,000 lines",

  // Die Tafel „Terminal" selbst (B6, #5) — dieselben Schlüssel wie in `de.ts`.
  settingsTerminalTitle: "Terminal",
  settingsTerminalHint:
    "These four settings apply to the terminal of the shell — across the hub and for every user. The default is a dark terminal, even when the hub stands light.",
  settingsTerminalScrollbackHint:
    "That many lines the browser keeps for scrolling back while the tab is open. Nothing is delivered afterwards: the agent knows no history, and whatever ran before the tab opened is kept nowhere.",
  settingsTerminalSave: "Save",
  settingsTerminalSaving: "Saving …",
  settingsTerminalSaved: "saved",
  settingsTerminalFailed: "The terminal settings could not be saved.",

  themeAreaOperations: "Operations",
  themeAreaManagement: "Profile & settings",
  themeAreaOperationsTone: "Steel blue",
  themeAreaManagementTone: "Magenta",
  themeAreaOperationsScope: "overview, containers, hosts",
  themeAreaManagementScope: "everything behind the profile button",

  // Übernommene Bausteine unter web/src/platform/ui/shadcn/ — sichtbarer und vom
  // Screenreader gelesener Text, der in der Registry-Vorlage auf Englisch mitkam.
  uiClose: "Close",
  uiSidebar: "Sidebar",
  uiSidebarMobileDescription: "Displays the sidebar for mobile devices.",
  uiSidebarToggle: "Toggle sidebar",
  uiBreadcrumbNav: "Breadcrumb navigation",
  uiBreadcrumbMore: "More items",
  uiCommandPaletteTitle: "Command palette",
  uiCommandPaletteDescription: "Search for a command to run",

  // Die Schale (D3): Seitenleiste, Kopfzeile, Namensschild und die ⌘K-Suche.
  // Auch die Tastenkombination steht hier — sie wird angezeigt und ist damit
  // sichtbarer Text wie jeder andere.
  navGroupOperations: "Operations",
  navOverview: "Overview",
  navContainers: "Containers",
  navHosts: "Hosts",

  shellSearch: "Search",
  shellSearchShortcut: "⌘K",
  shellSearchPlaceholder: "Search screens …",
  shellSearchEmpty: "No entries found.",

  // Beschriftung des Namensschild-Knopfs unten links. Sichtbar ist dort Name
  // und Rolle; diese Zeile liest der Screenreader und sagt, was der Knopf tut.
  shellAccountMenu: "Account and sign out",

  errorOriginRefused:
    "The hub rejected the request before it reached the arm: the browser did not identify itself as this interface. Most common case: the browser sends no referrer. Reload the page from the address of the hub.",

  // Die Sprachschicht (#70). Diese Meldung braucht der LanguageProvider:
  // schlägt das Speichern fehl, stellt er die Sprache zurück und sagt, dass er
  // es getan hat.
  languageSaveFailed: "The language could not be saved.",

  // Die Überschrift über den Sprachen im Namensschild-Menü unten links.
  languageLabel: "Language",

  // ⚠️ Die Sprachnamen stehen in IHRER EIGENEN Sprache und sind deshalb in
  // de.ts und en.ts WORTGLEICH: „Deutsch" bleibt „Deutsch", auch wenn die
  // Oberfläche gerade Englisch spricht, und „English" bleibt „English", auch
  // wenn sie Deutsch spricht. Das ist keine vergessene Übersetzung, sondern
  // der Zweck des Umschalters: wer die aktuelle Oberfläche nicht lesen kann,
  // sucht darin nach dem einen Wort, das er kennt. Stünde hier „German",
  // fände er es nicht — und der Umschalter wäre genau für den unbrauchbar,
  // der ihn braucht.
  languageGerman: "Deutsch",
  languageEnglish: "English",
} satisfies typeof de;
