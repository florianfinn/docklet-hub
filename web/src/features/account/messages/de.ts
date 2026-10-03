// German texts of the feature `account` (#269): the page "Benutzer & Profil",
// the table of accounts, the sign-in and the first sign-in. German is the source
// of the message type; `en.ts` closes with `satisfies typeof deAccount`.
//
// Put together with the texts of every other surface in
// `web/src/app/i18n/messages.ts`; `platform/` may not import a feature.
//
// ⚠️ `accountTitle` IS ALSO READ BY THE SHELL (the menu item at the name tag):
// one key per surface and not two, a second one for the menu item would be a
// second truth about the same place. The keys of all parts are one flat
// language, so the shell reads it from here without importing the feature.
//
// ⚠️ A FLAT LITERAL, NO GROUP `account: { … }`. `web/tests/languages.test.mjs`
// reads the top level of a flat literal; a second level would be invisible to
// it.

export const deAccount = {
  // Der Bildschirm, der beim ersten Start erscheint — und danach nie wieder.
  setupTitle: "Erstanmeldung",
  setupLead:
    "Dieser Hub hat noch kein Konto. Das erste wird Administrator. Danach ist dieser Weg zu; wer sich später aussperrt, kommt über das Break-Glass auf der Kommandozeile herein.",
  setupNameLabel: "Name",
  setupEmailLabel: "E-Mail",
  setupPasswordLabel: "Passwort",
  setupPasswordHint: "Mindestens 12 Zeichen.",
  setupSubmit: "Konto anlegen",
  setupFailed: "Das Konto konnte nicht angelegt werden.",

  // Anmeldung
  signInTitle: "Anmeldung",
  signInEmailLabel: "E-Mail",
  signInPasswordLabel: "Passwort",
  signInSubmit: "Anmelden",
  signInFailed: "E-Mail oder Passwort stimmen nicht.",
  // Der Satz nach einem 401 mitten in der Arbeit (#127). Er sagt, WARUM
  // dieses Formular gerade erschienen ist — ohne ihn liest sich der Sprung
  // hierher wie ein Absturz.
  signInExpired: "Die Sitzung ist abgelaufen. Bitte erneut anmelden.",

  // Die beiden Flächen am Profil-Knopf (D6b): „Benutzer & Profil" und
  // „Einstellungen". Ihre Titel sind zugleich die Beschriftungen der zwei
  // Menüpunkte im Namensschild unten links — EIN Schlüssel je Fläche und nicht
  // zwei. Ein eigener Schlüssel für den Menüpunkt wäre eine zweite Wahrheit
  // über denselben Ort, und die erste Umbenennung ließe eine davon stehen.
  accountTitle: "Benutzer & Profil",
  accountProfileTitle: "Mein Profil",
  accountNameLabel: "Anzeigename",
  accountEmailLabel: "E-Mail",

  // Die Konten-Tabelle. Sie erscheint nur für eine Adminrolle —
  // `GET /api/users` steht hinter `requireAdmin`.
  accountsTitle: "Konten",
  accountsCount: "{count, plural, one {# Konto} other {# Konten}}",
  accountsAdminCount: "{count, plural, one {# Administrator} other {# Administratoren}}",
  accountsColumnName: "Name",
  accountsColumnRole: "Rolle",
  accountsColumnLastSignIn: "Letzte Anmeldung",
  accountsColumnSessions: "Sitzungen",
  // Ein Konto, das sich noch nie angemeldet hat (`lastSignInAt: null`). Das
  // ist kein fehlender Wert, sondern eine Auskunft.
  accountsNeverSignedIn: "nie",
  // Die Marke an der eigenen Zeile. Das Artboard zeichnet sie allein mit einer
  // Fläche aus (`data-self="true"`); wer die Zeile vorgelesen bekommt, hört
  // von einer Hintergrundfarbe nichts.
  accountsSelf: "Sie",
  accountsFailed: "Die Konten konnten nicht geladen werden."
};
