// The door of the feature `account` (#269). Named re-exports only, no
// `export *` (`web/tests/import-boundaries.test.mjs`).
//
// The feature is the account of the signed-in person and the way into the hub:
// the page "Benutzer & Profil" (`AccountView`), and the two screens before the
// sign-in, the first sign-in (`SetupView`) and the sign-in (`SignInView`).
// `App.tsx` decides which of the three is shown; the profile page is put into a
// route by `app/routes/AppRoutes.tsx`. The three are eager: the two forms are
// the first thing an operator sees, and the page is small.

export { AccountView } from "./AccountView";
export { SetupView } from "./SetupView";
export { SignInView } from "./SignInView";
export { deAccount } from "./messages/de";
export { enAccount } from "./messages/en";
