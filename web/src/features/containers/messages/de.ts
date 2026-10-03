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
