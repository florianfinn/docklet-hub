import { SettingsView } from "../../features/settings";
import { SETTINGS_TABS } from "../settings/settings-tabs";
import type { Language } from "../../platform/i18n";
import type { Role } from "../../platform/session/session-user";

// The screen "Einstellungen", a frame around the view of the feature `settings`
// (#269). It stands in `app/screens/` because the route table names its screens and
// `web/tests/screen-switching.test.mjs` demands a file under `app/screens/` for each
// of them. The tabs come from `app/settings/settings-tabs.tsx`, where the panels
// of the features are put together.
//
// ⚠️ Role and the language switch come in as properties, as before. There is no
// provider for the session in the web (the account stands in `App.tsx` and
// `app/routes/AppRoutes.tsx` passes it on), and a `GET /api/session` from here
// would be a second source for the same answer. The switch comes from there and
// not from `useLanguage()` because `web/tests/auth-screens.test.mjs` (check 3)
// turns the writing call red in every `.tsx` under `app/screens/`: it is made where
// the session is sure to exist, in the signed-in view.

type SettingsScreenProps = {
  role: Role;
  language: Language;
  // Der Umschalter des Sprachanbieters, durchgereicht. Er stellt um, speichert
  // und stellt bei einem Fehlschlag zurück.
  onLanguageChange: (language: Language) => void;
};

export function SettingsScreen({ role, language, onLanguageChange }: SettingsScreenProps) {
  return <SettingsView tabs={SETTINGS_TABS} role={role} language={language} onLanguageChange={onLanguageChange} />;
}
