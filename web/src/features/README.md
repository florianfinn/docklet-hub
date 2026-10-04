# features

Je Fachbereich ein Ordner `features/<name>/`: API-Aufrufe, Ansichten,
Bauteile und Sprachdateien einer Fläche. Server und Web benennen dasselbe
Feature gleich (`server/src/features/<name>/`).

Von außen ist ein Feature nur über `index.ts` erreichbar, mit benannten
Re-Exporten und ohne `export *`. Eine schwere Ansicht hat zusätzlich eine
Einstiegsdatei `<Ansicht>.lazy.tsx`, die nur per `import()` geladen wird. Ein
Feature importiert kein anderes Feature und nichts aus `app/`, nur `domain/`,
`platform/` und `contract`.

Texte stehen in `features/<name>/messages/de.ts` und `en.ts`, gehen über die
Tür hinaus und werden in `app/i18n/messages.ts` zusammengesetzt; `platform/`
darf sie nicht importieren.

Regeln und Begründung: `docs/design/feature-architecture.md`, Abschnitte 2
und 3. Die Grenzen prüft `.dependency-cruiser.mjs`, die Türen
`web/tests/import-boundaries.test.mjs`.

| Feature | Inhalt |
| ------- | ------ |
| `logs/` | Log-Ansicht eines Containers (`LogView.lazy.tsx`), Reiter „Protokoll" eines Stacks (`StackLogView.lazy.tsx`), Tafel „Logansicht" der Einstellungen, Aufrufe (`api.ts`), Texte (`messages/`) |
| `shell/` | Terminal eines Containers (`ShellView.lazy.tsx`; xterm steckt hinter einem zweiten `import()` in `terminal-surface.ts`), Aufrufe (`api.ts`), Fehlertabellen (`shell-errors.ts`), Texte (`messages/`) |
| `files/` | Reiter „Dateien" eines Containers (`FilesView.lazy.tsx`) mit Freigabe-Wahl (`ShareChooser.tsx`), Liste, Editor, Hochladen und Ordneraktionen, Aufrufe (`api.ts`), Abfragen und Invalidierung (`file-queries.ts`), Texte (`messages/`) |
| `compose/` | Reiter „Compose" eines Stacks (`ComposeView.lazy.tsx`) mit Editor, Vergleich, Anwenden-Karte und `.env`-Ansicht, Aufrufe (`api.ts`), Abfragen (`compose-queries.ts`), Fehler- und Schritttabellen, Texte (`messages/`) |
| `hosts/` | Host-Seite (`HostsView.tsx`, eingerahmt von `app/screens/HostsScreen.tsx`) mit Karten, Anlege-Dialog und -Formular, Agent-Update samt „Letztes Agent-Update", Aufrufe (`api.ts`), Abfragen (`host-queries.ts`, `use-host-counters.ts`), Texte (`messages/`); die Last steckt `app/screens/HostsScreen.tsx` über `renderLoad` in die Karte |
| `marks/` | Tafel „Eigene Marken" der Einstellungen (`MarksPanel.tsx`, mit Zeile, Anlegefeld und Entfernen-Dialog), Liste (`MarkList.tsx`) und Auswahl (`MarkAssign.tsx`) an Stack und Container, die reinen Fortschreibungen der Übersicht (`overview-marks.ts`), Aufrufe (`api.ts`, auch Einrückung und Ausblenden je Stack), Abfrage (`mark-queries.ts`), Texte (`messages/`); `MarkChip` liegt in `platform/ui/marks/` |
| `appearance/` | Anbieter des globalen Themas (`GlobalThemeProvider.tsx`, in `main.tsx` eingehängt), Tafeln „Darstellung", „Farbe der Bereiche" und „Farbe je Host" der Einstellungen, die Zeile einer Stellschraube (`KnobRow.tsx`, auch vom Terminal der Einstellungen benutzt), Aufrufe (`api.ts`), Texte (`messages/`); Stylesheets in `platform/theme/`, Stufen-Beschriftungen in `platform/i18n/theme-labels.ts` |
| `containers/` | Übersicht (`OverviewView.tsx`) und Container-Fläche (`ContainersView.tsx`, `ContainerBrowser.tsx`) mit Host-Gruppen, Stack- und Container-Zeilen, Suche und Filter (`container-filter.ts`), fremdverwaltete Container, die Tafeln „Hub und Agenten“ und „Container von Hub und Agenten“ der Einstellungen, Aufrufe (`api.ts`), Abfragen (`overview-queries.ts`), Texte (`messages/`); Marken und Auslastung stecken die Plätze `ContainerSlots` aus `app/containers/` herein |
| `metrics/` | Auslastung: Karte „Auslastung“ im Container-Detail (`ContainerMetrics.tsx`, fragt alle zehn Sekunden über `metrics-queries.ts`), letzter Wert in der Container-Zeile (`RowUsage.tsx`), Last durch Container auf der Host-Karte (`ContainerLoad.tsx`), Aufbereitung der Messwerte (`metric-values.ts`), Aufruf (`api.ts`), Texte (`messages/`); Zeile und Karte stecken `app/containers/` und `app/screens/HostsScreen.tsx` über die Plätze `containerUsage` und `renderLoad` herein; die Sparkline liegt in `platform/ui/metrics/` |
| `resources/` | Ressourcen eines Hosts (`ResourcesView.lazy.tsx`, eingerahmt von `app/screens/HostResourcesScreen.tsx`): Speicherbelegung, Images, Volumes und Netze mit Verwendern und Merkmalen, Aufruf (`api.ts`), Abfrage (`resource-queries.ts`), reine Hilfen (`resource-values.ts`), Texte (`messages/`); den Verweis auf der Host-Karte steckt `app/screens/HostsScreen.tsx` über `renderActions` herein |
