# app

Setzt die Oberfläche zusammen: Routen, Schale, die Bildschirme, die mehrere
Features zeigen (Container, Stack, Übersicht), und die Einstellungen aus den
Reitern der Features. `app/` darf jede Schicht
darunter importieren; ein Feature nur über seine Tür `index.ts` oder eine
`.lazy.tsx`, diese nur per `import()`.

| Ordner    | Inhalt                                                                     |
| --------- | -------------------------------------------------------------------------- |
| `routes/` | `AppRoutes.tsx`: welcher Pfad welchen Bildschirm zeigt                      |
| `screens/` | die Bildschirme der Routen (`OverviewScreen`, `ContainersScreen`, `ContainerScreen`, `StackScreen`, `HostsScreen`, `AccountScreen`, `SettingsScreen`) und `detail-page.ts`, der Rahmen der beiden Detailseiten; `StackIndentSwitch` unter `screens/stack/`. Ein Bildschirm kennt jedes Feature nur über dessen `index.ts` oder `.lazy.tsx` |
| `shell/`  | `AppShell`, `AppSidebar`, `CommandPalette` und die Navigation (`navigation.ts`) |
| `containers/` | `container-slots.tsx`: die Plätze für Marken, Griff und Auslastung in den Container-Zeilen (`OVERVIEW_SLOTS`, `useDeepDiveSlots`), `SystemContainers.tsx`: der Reiter „Hub & Agenten“ |
| `settings/` | `settings-tabs.tsx`: die Reiter der Einstellungen, `TerminalPanel.tsx` |
| `query/`  | `AppQueryProvider`: der eine Zwischenspeicher von TanStack Query für die App    |
| `i18n/`   | `messages.ts` setzt die Texte von `platform/` und den Features zusammen, `AppLanguageProvider` reicht sie an `LanguageProvider`, `use-intl.d.ts` macht Deutsch zum Typ aller Sprachen |

Regeln und Begründung: `docs/design/feature-architecture.md`, Abschnitte 2
und 3. Die Grenzen prüft `.dependency-cruiser.mjs`.
