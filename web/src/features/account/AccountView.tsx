import { useTranslations } from "use-intl";

import type { SessionUser } from "../../platform/session/session-user";
import { useAccounts } from "./account-queries";
import { AccountsPanel } from "./AccountsPanel";
import { ProfilePanel } from "./ProfilePanel";

// The view of the feature `account` (#269), put into the screen
// `web/src/app/screens/AccountScreen.tsx`.
//
// Die Fläche „Benutzer & Profil" (D6b, #62; Artboard hub-palette.html
// Z. 717–760).
//
// ⚠️ SIE HÄNGT AM PROFIL-KNOPF UNTEN LINKS UND NICHT IN DER NAVIGATION. Die
// Begründung steht in docs/design/hub-color-and-structure.md §5, letzter
// Absatz: die Verwaltung ist kein Betriebsbereich, sie wird ERREICHT und nicht
// angesteuert. Ihr Pfad steht deshalb in `standaloneRoutes`
// (`web/src/app/routes/AppRoutes.tsx`) und nicht an einem Navigationseintrag.
//
// ⚠️ OHNE „BENUTZER ANLEGEN". Der Knopf steht im Artboard (Z. 722); es gibt
// keine Route, die ein Konto anlegt — D6b ist ausdrücklich lesend. Ein Knopf
// ohne Wirkung ist derselbe Fehler wie ein ausgegrauter Eintrag, und die
// Erstanmeldung (`SetupView`) legt das einzige Konto an, das dieser Hub
// heute anlegen kann.
//
// ⚠️ DIE ROLLE ENTSCHEIDET VOR DEM LADEN. `GET /api/users` steht hinter
// `requireAdmin` (server/src/features/account/routes.ts). Wer keine Adminrolle trägt,
// bekäme 403 — deshalb wird für ihn GAR NICHT ERST gefragt: die Abfrage
// bleibt für ihn ausgeschaltet, und die Tafel „Konten" erscheint nicht. Nicht
// als Fehlermeldung, nicht als leere Tabelle, nicht ausgegraut. Ein Abruf, von
// dem im Voraus feststeht, dass er abgelehnt wird, ist keine Prüfung.

export function AccountView({ user }: { user: SessionUser }) {
  const t = useTranslations();
  const isAdmin = user.role === "admin";
  // ⚠️ `enabled` is the whole rule from the paragraph above: for a user without
  // the admin role the query never runs.
  const users = useAccounts({ enabled: isAdmin });
  const accounts = users.data ?? null;
  const failed = users.isError;

  const adminCount = (accounts ?? []).filter((account) => account.role === "admin").length;

  // ⚠️ KEIN `data-area` mehr hier — seit D6b setzt die SCHALE es an der
  // Adresse (`web/src/app/shell/AppShell.tsx`, `areaForPath(pathname)` am
  // `SidebarProvider`). Ein zweites hier läge unterhalb dessen, was schon
  // vererbt, und wäre folgenlos doppelt: die Seitenleiste läse ohnehin nur das
  // ihre, aber ein zweiter Wert an derselben Achse ist eine zweite Wahrheit,
  // die auseinanderlaufen kann. Vorher stand hier `data-area="management"`,
  // während die Schale FEST `data-area="operations"` trug — das war der
  // gemeldete Befund aus D6b (Seitenleiste und Kopfzeile blieben im Ton des
  // Betriebs).
  //
  // Die Schale liefert das `<main>` über `SidebarInset`; diese Fläche sitzt
  // darin und trägt deshalb selbst keine zweite Landmarke.
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5 px-8 py-7">
      <div>
        <h1 className="text-[20px] font-medium tracking-[-0.022em]">{t("accountTitle")}</h1>
        {/* Die Zusammenfassung des Artboards („4 Konten · 1 Administrator",
            Z. 723) steht nur da, wenn die Zahlen wirklich vorliegen — sie
            kommen aus der Konten-Liste, und die gibt es ohne Adminrolle
            nicht. */}
        {accounts !== null ? (
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-subtle-foreground">
            <span>{t("accountsCount", { count: accounts.length })}</span>
            <span aria-hidden="true">·</span>
            <span>{t("accountsAdminCount", { count: adminCount })}</span>
          </p>
        ) : null}
      </div>

      <ProfilePanel user={user} />

      {isAdmin ? <AccountsPanel accounts={accounts} failed={failed} selfId={user.id} /> : null}
    </div>
  );
}
