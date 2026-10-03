import type { Language } from "../i18n/languages";

// The signed-in account as the session route hands it out (`GET /api/session`).
// It lives in `platform/` because the feature `account` shows it, the shell
// and the routes of `app/` pass it on, and a feature may not import another
// feature.

export type Role = "admin" | "user";

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  // Die Sprache der Oberfläche liegt im Konto, nicht im Browser
  // (docs/design/language-layer.md). Sie reist deshalb mit der Sitzung.
  language: Language;
};
