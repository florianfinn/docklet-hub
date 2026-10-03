import type { ReactNode } from "react";

import { LanguageProvider } from "../../platform/i18n";
import { messages } from "./messages";

/** The language layer with all texts of the app, features included (#258). */
export function AppLanguageProvider({ children }: { children: ReactNode }) {
  return <LanguageProvider messages={messages}>{children}</LanguageProvider>;
}
