// All texts of the interface, per language (#258).
//
// The texts of a surface that is not a feature yet stand in
// `platform/i18n/messages/`; a feature brings its own
// (`features/<name>/messages/`). `platform/` may not import a feature, so the
// two are put together here, in `app/`, and only this whole goes to
// `LanguageProvider`.
//
// ⚠️ GERMAN STAYS THE SOURCE OF THE TYPE. `de` is the type of every language
// (`use-intl.d.ts` next to this file); `en` closes with `satisfies typeof de`,
// so a key missing in English or one too many fails the type check, as before
// the split.
//
// ⚠️ A KEY IN TWO PARTS WOULD WIN SILENTLY BY ORDER OF THE SPREADS. The guard
// `web/tests/languages.test.mjs` reads every part and reports a key that
// stands twice.

import { platformMessages, type Language } from "../../platform/i18n";
import { deAccount, enAccount } from "../../features/account";
import { deAppearance, enAppearance } from "../../features/appearance";
import { deCompose, enCompose } from "../../features/compose";
import { deContainers, enContainers } from "../../features/containers";
import { deFiles, enFiles } from "../../features/files";
import { deHosts, enHosts } from "../../features/hosts";
import { deLogs, enLogs } from "../../features/logs";
import { deMarks, enMarks } from "../../features/marks";
import { deMetrics, enMetrics } from "../../features/metrics";
import { deSettingsPage, enSettingsPage } from "../../features/settings";
import { deShell, enShell } from "../../features/shell";

export const de = {
  ...platformMessages.de,
  ...deLogs,
  ...deShell,
  ...deFiles,
  ...deCompose,
  ...deContainers,
  ...deHosts,
  ...deMarks,
  ...deMetrics,
  ...deAppearance,
  ...deAccount,
  ...deSettingsPage
};

export const en = {
  ...platformMessages.en,
  ...enLogs,
  ...enShell,
  ...enFiles,
  ...enCompose,
  ...enContainers,
  ...enHosts,
  ...enMarks,
  ...enMetrics,
  ...enAppearance,
  ...enAccount,
  ...enSettingsPage
} satisfies typeof de;

export const messages: Record<Language, typeof de> = { de, en };
