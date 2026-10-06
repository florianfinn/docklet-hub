// English texts of the feature `account` (#269). Closes with
// `satisfies typeof deAccount`: a key that is missing here or stands once too
// many fails the type check.

import type { deAccount } from "./de";

export const enAccount = {
  setupComposeDefinitionLabel: "Apply Compose definition on start and restart",
  setupComposeDefinitionHint: "On: hub-owned stacks apply their Compose definition on start; restart recreates their containers. Externally managed stacks keep their definitions. You can change this in Settings.",
  // Der Bildschirm, der beim ersten Start erscheint — und danach nie wieder.
  setupTitle: "First sign-in",
  setupLead:
    "This hub does not have an account yet. The first one becomes administrator. After that, this path is closed; anyone who gets locked out later comes back in through the break-glass on the command line.",
  setupNameLabel: "Name",
  setupEmailLabel: "Email",
  setupPasswordLabel: "Password",
  setupPasswordHint: "At least 12 characters.",
  setupSubmit: "Create account",
  setupFailed: "The account could not be created.",

  // Anmeldung
  signInTitle: "Sign in",
  signInEmailLabel: "Email",
  signInPasswordLabel: "Password",
  signInSubmit: "Sign in",
  signInFailed: "Email or password is incorrect.",
  signInExpired: "Your session has expired. Please sign in again.",

  // Die beiden Flächen am Profil-Knopf (D6b): „Benutzer & Profil" und
  // „Einstellungen". Ihre Titel sind zugleich die Beschriftungen der zwei
  // Menüpunkte im Namensschild unten links — EIN Schlüssel je Fläche und nicht
  // zwei.
  accountTitle: "Users & profile",
  accountProfileTitle: "My profile",
  accountNameLabel: "Display name",
  accountEmailLabel: "Email",

  // Die Konten-Tabelle. Sie erscheint nur für eine Adminrolle —
  // `GET /api/users` steht hinter `requireAdmin`.
  accountsTitle: "Accounts",
  accountsCount: "{count, plural, one {# account} other {# accounts}}",
  accountsAdminCount: "{count, plural, one {# administrator} other {# administrators}}",
  accountsColumnName: "Name",
  accountsColumnRole: "Role",
  accountsColumnLastSignIn: "Last sign-in",
  accountsColumnSessions: "Sessions",
  // Ein Konto, das sich noch nie angemeldet hat (`lastSignInAt: null`). Das
  // ist kein fehlender Wert, sondern eine Auskunft.
  accountsNeverSignedIn: "never",
  // Die Marke an der eigenen Zeile. Das Artboard zeichnet sie allein mit einer
  // Fläche aus (`data-self="true"`); wer die Zeile vorgelesen bekommt, hört
  // von einer Hintergrundfarbe nichts.
  accountsSelf: "you",
  accountsFailed: "The accounts could not be loaded."
} satisfies typeof deAccount;
