import { Boxes, Palette, ServerCog, SlidersHorizontal, Tags } from "lucide-react";

import { AppearancePanel, AreaColorPanel, HostColorPanel } from "../../features/appearance";
import { ContainerViewPanel } from "../../features/containers";
import { LogSettingsPanel } from "../../features/logs";
import { MarksPanel } from "../../features/marks";
import { HubNetworkPanel, LanguagePanel, RuntimeSettingsPanel, type SettingsTab } from "../../features/settings";
import { SystemContainers } from "../containers/SystemContainers";
import { TerminalPanel } from "./TerminalPanel";

// Die Reiter der Fläche „Einstellungen" — die EINE Liste, aus der Leiste und
// Inhalt entstehen. Ein neuer Reiter ist ein Eintrag hier und sonst nichts:
// `SettingsView` (`features/settings/`) kennt keinen Reiter beim Namen.
//
// The list is here, in `app/`, since #269 (docs/design/feature-architecture.md,
// section 2): the panels belong to different features, and what two features
// show together is put together in `app/`. The two panels of the container view
// come from the feature `containers` (#282); the tab "Hub & Agenten" goes
// through `app/containers/SystemContainers.tsx`, which hands the marks into the
// list. `TerminalPanel` reads the theme of `appearance` and writes terminal
// knobs, so it belongs to neither `shell` nor `appearance` and lives next to
// this list.
//
// ⚠️ DIE REIHENFOLGE IST DIE DER REICHWEITE, von allgemein zu speziell —
// dieselbe Staffelung, die die Tafeln bisher untereinander trugen:
//
//   - „Allgemein": die Sprache, die als einzige am KONTO hängt und nicht am
//     Hub, und das Netz, ohne das kein externer Arm einen Tunnel aufbaut.
//   - „Darstellung": global über den Bereich zum Arm — die Staffelung der
//     Ebenen in docs/design/hub-color-and-structure.md §2.
//   - „Marken": sie vergeben einen Ton aus demselben Vorrat wie „Farbe je
//     Host" und stehen deshalb direkt dahinter.
//   - „Container": was beim Lesen einzelner Container gilt — ob Hub und
//     Agenten in den Listen stehen, die Logansicht, das Terminal (B6, #5:
//     die Tafel mit der kleinsten Reichweite zuletzt).
//   - „Hub & Agenten": keine Einstellung, sondern die Container des
//     Leitstands selbst. Sie stehen hier, weil sie in Übersicht und
//     Container-Fläche ausgeblendet sind und irgendwo erreichbar sein müssen.
//
// ⚠️ Der Kenner eines Reiters steht in der Adresse und bleibt stehen, auch wenn
// sich die Beschriftung ändert (`features/settings/settings-tabs.ts`).

export const SETTINGS_TABS: readonly SettingsTab[] = [
  {
    id: "general",
    labelKey: "settingsTabGeneral",
    icon: SlidersHorizontal,
    render: ({ role, language, onLanguageChange }) => (
      <>
        <LanguagePanel language={language} onLanguageChange={onLanguageChange} />
        <HubNetworkPanel role={role} />
      </>
    )
  },
  {
    id: "appearance",
    labelKey: "settingsTabAppearance",
    icon: Palette,
    render: ({ role }) => (
      <>
        <AppearancePanel role={role} />
        <AreaColorPanel />
        <HostColorPanel role={role} />
      </>
    )
  },
  {
    id: "marks",
    labelKey: "settingsTabMarks",
    icon: Tags,
    render: ({ role }) => <MarksPanel role={role} />
  },
  {
    id: "containers",
    labelKey: "settingsTabContainers",
    icon: Boxes,
    render: ({ role }) => (
      <>
        <RuntimeSettingsPanel role={role} />
        <ContainerViewPanel role={role} />
        <LogSettingsPanel role={role} />
        <TerminalPanel role={role} />
      </>
    )
  },
  {
    id: "system",
    labelKey: "settingsTabSystem",
    icon: ServerCog,
    render: ({ role }) => <SystemContainers role={role} />
  }
];
