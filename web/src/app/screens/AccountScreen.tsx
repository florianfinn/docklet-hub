import { AccountView } from "../../features/account";
import type { SessionUser } from "../../platform/session/session-user";

// The screen "Benutzer & Profil", a frame around the view of the feature
// `account` (#269). It stands in `app/screens/` because the route table names its screens and
// `web/tests/screen-switching.test.mjs` demands a file under `app/screens/` for each
// of them; what the surface shows and why stands in `features/account/`.
// It hangs at the profile button bottom left and not in the navigation: its path
// is in `standaloneRoutes` (`web/src/app/routes/AppRoutes.tsx`).

export function AccountScreen({ user }: { user: SessionUser }) {
  return <AccountView user={user} />;
}
