import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Messages } from "use-intl";

import type { Language } from "../../platform/i18n";
import type { Role } from "../../platform/session/session-user";

// What a tab of the page "Einstellungen" is (#269). The list itself is built in
// `app/settings/settings-tabs.tsx`; the feature only defines the shape and how
// the address picks one.
//
// ⚠️ DER KENNER EINES REITERS STEHT IN DER ADRESSE (`?tab=…`) und ist damit
// ein Teil der Oberfläche, der ein Neuladen übersteht. Umbenennen bricht
// Lesezeichen — der Kenner ist englisch und bleibt stehen, auch wenn sich die
// Beschriftung ändert.

export type SettingsTabContext = {
  role: Role;
  language: Language;
  onLanguageChange: (language: Language) => void;
};

export type SettingsTab = {
  id: string;
  labelKey: keyof Messages;
  icon: LucideIcon;
  render: (context: SettingsTabContext) => ReactNode;
};

/**
 * Der Reiter zu einem Kenner aus der Adresse. Ein unbekannter oder fehlender
 * Kenner ergibt den ersten Reiter — ein veraltetes Lesezeichen landet damit
 * auf der Fläche und nicht auf einer leeren Seite.
 */
export function settingsTabOf(tabs: readonly SettingsTab[], id: string | null): SettingsTab {
  return tabs.find((tab) => tab.id === id) ?? tabs[0];
}
