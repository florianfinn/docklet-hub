import { Link, useSearchParams } from "react-router";
import { useTranslations } from "use-intl";

import { settingsTabOf, type SettingsTab, type SettingsTabContext } from "./settings-tabs";

// The view of the feature `settings` (#269): the frame of the page and its tab
// bar. WHICH tabs there are is not this feature's to say: the panels of the
// tabs belong to `logs`, `appearance`, `marks`, the container view and the
// terminal, and a feature imports no other. `app/settings/settings-tabs.tsx`
// puts the list together and hands it in as `tabs`; this file draws the bar and
// the active tab and knows no tab by name. It is put into the screen
// `web/src/app/screens/SettingsScreen.tsx`.
//
// Die Fläche „Einstellungen" (D6b, #62; Artboard hub-palette.html ab Z. 759).
//
// ⚠️ SIE TRÄGT GENAU DAS, WAS ES HEUTE GIBT. Das Artboard führt fünf Tafeln
// (Darstellung, Farbe der Bereiche, Farbe je Host, Eigene Marken, Stacks). Mit
// D7b Etappe B stehen VIER davon — „Darstellung", „Farbe der Bereiche", „Farbe
// je Host" und „Eigene Marken" —, dazu die Sprache, die seit D6b hier steht.
// „Stacks" steht hier NICHT: die Einrückung gehört an den Stack und wird dort
// gewählt, wo sie wirkt (Entscheidung des Betreibers vom 2026-09-06, Etappe C).
// Nicht einmal als leerer Rahmen — ein Kasten mit einer Überschrift und nichts
// darin ist dieselbe Ankündigung wie ein ausgegrauter Knopf, nur größer.
//
// ⚠️ „TERMINAL" STEHT IM ARTBOARD NICHT und ist mit B6 (#5) dazugekommen —
// eine Entscheidung des Betreibers und keine Ableitung aus dem Bild. Sie ist
// eine EIGENE Karte: die vier Stellschrauben des Terminals wirken auf genau
// einen Reiter, die sieben in „Darstellung" auf jede Fläche des Hubs, und in
// einer gemeinsamen Feldliste wäre dieser Unterschied nicht zu sehen.
//
// ⚠️ „EIGENE MARKEN" IST EINE TAFEL UND KEIN EIGENER BILDSCHIRM. Sie hat
// deshalb keine Route und keinen Eintrag in `web/src/app/routes/AppRoutes.tsx` —
// der Wächter `web/tests/screen-switching.test.mjs` braucht keinen. Die
// Zuordnung einer Marke zu einem Stack oder Container ist kein Fall für diese
// Fläche: sie geschieht an der Zeile, an der die Frage schon beantwortet ist.
//
// ⚠️ DIE ROLLE KOMMT ALS EIGENSCHAFT HEREIN, wie bei `HostsScreen` und
// `AccountScreen`. Es gibt im Web keinen Anbieter für die Sitzung — das
// angemeldete Konto steht in `web/src/App.tsx` und wird über
// `web/src/app/routes/AppRoutes.tsx` an die Flächen gereicht, die es brauchen. Ein
// eigener `GET /api/session` von hier aus wäre eine zweite Quelle für dieselbe
// Auskunft.
//
// ⚠️ DIE SPRACHWAHL IST HIERHER GEWANDERT UND NICHT KOPIERT WORDEN. Sie stand
// bis D6b als `DropdownMenuRadioGroup` im Menü des Namensschilds
// (`web/src/app/shell/AppSidebar.tsx`); dort steht sie seitdem NICHT mehr. Zwei
// Stellen für dieselbe Wahl wären zwei Wahrheiten, und die erste Änderung
// ließe eine davon stehen.
//
// ⚠️ Das SCHREIBEN hat sich dabei nicht geändert: der Umschalter des
// Sprachanbieters (`web/src/platform/i18n/LanguageProvider.tsx`) stellt zuerst um und
// ruft dann `PUT /api/session/language`. Schlägt der Aufruf fehl, stellt der
// Anbieter die Wahl ZURÜCK und meldet es über einen Hinweis. Diese Fläche
// braucht dafür keine eigene Behandlung — sie hält KEINEN eigenen Zustand,
// sondern zeigt `language` an und meldet die Wahl nach oben. Eine Kopie des
// Zustands hier hätte genau diese Rückstellung verpasst und danach eine
// Sprache angezeigt, die im Konto nicht steht.
//
// ⚠️ WARUM DER UMSCHALTER ALS EIGENSCHAFT HEREINKOMMT UND NICHT AUS
// `useLanguage()`: der Wächter `web/tests/auth-screens.test.mjs` (Prüfung 3)
// macht den schreibenden Aufruf des Sprachanbieters in JEDER `.tsx` unter
// `web/src/app/screens/` rot — auch nach der Anmeldung, und ausdrücklich mit
// Absicht: die Alternative wäre eine Liste der „Bildschirme vor der
// Anmeldung", die beim nächsten Bildschirm still veraltet. Seine Vorgabe für
// diesen Fall steht in seinem eigenen Kopf: wer den schreibenden Weg nach der
// Anmeldung braucht, ruft ihn aus der angemeldeten Ansicht.
//
// Genau das geschieht hier. Der Aufruf steht in `web/src/app/routes/AppRoutes.tsx`
// — die Routentabelle wird NUR gerendert, wenn `web/src/App.tsx` im Zustand
// `signedIn` steht, die Sitzung also sicher besteht. Der Wächter bleibt damit
// scharf (er ist nicht angefasst), und der Vertrag, den er hält — vor der
// Anmeldung wird nichts geschrieben —, gilt unverändert.

// ⚠️ SEIT DEN REITERN stehen die Tafeln nicht mehr untereinander, sondern in
// Reitern, und welche Tafel in welchem Reiter steht, sagt EINE Liste:
// `app/settings/settings-tabs.tsx`. Dort steht auch die Reihenfolge samt Grund.
// Diese Datei zeichnet Leiste und Inhalt und kennt keinen Reiter beim Namen.
//
// ⚠️ DER REITER STEHT IN DER ADRESSE (`?tab=…`), aus demselben Grund wie an
// Stack- und Container-Seite: ein Neuladen landet wieder dort, wo der Mensch
// war. Deshalb Verweise und NICHT `ui/shadcn/tabs.tsx` — Radix führt den
// aktiven Reiter in einem eigenen Zustand, und die Adresse wüsste davon
// nichts. Ein Suchparameter und kein eigener Pfad: die Routentabelle
// (`web/src/app/routes/AppRoutes.tsx`) bleibt bei einer Fläche.

type SettingsViewProps = SettingsTabContext & {
  // The tabs, in order; the first is the one a missing or unknown `?tab=` shows.
  tabs: readonly SettingsTab[];
};

export function SettingsView({ tabs, role, language, onLanguageChange }: SettingsViewProps) {
  const t = useTranslations();
  const [params] = useSearchParams();
  const active = settingsTabOf(tabs, params.get("tab"));

  // ⚠️ KEIN `data-area` mehr hier — wie auf der Fläche „Benutzer & Profil"
  // nebenan setzt seit D6b die SCHALE es an der Adresse
  // (`web/src/app/shell/AppShell.tsx`, Begründung dort).
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5 px-8 py-7">
      <h1 className="text-[20px] font-medium tracking-[-0.022em]">{t("settingsTitle")}</h1>

      <nav aria-label={t("settingsTabsLabel")} className="-mt-1 flex gap-1 overflow-x-auto border-b border-border">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const current = tab.id === active.id;
          return (
            <Link
              key={tab.id}
              to={{ search: `?tab=${tab.id}` }}
              aria-current={current ? "page" : undefined}
              data-testid={`settings-tab-${tab.id}`}
              className={
                current
                  ? "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 border-foreground px-3 py-2 text-[13px] font-medium text-foreground"
                  : "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-[13px] text-muted-foreground hover:text-foreground"
              }
            >
              <Icon aria-hidden="true" className="size-3.5" />
              {t(tab.labelKey)}
            </Link>
          );
        })}
      </nav>

      {/* ⚠️ NUR DER GELTENDE REITER WIRD EINGEHÄNGT: jede Tafel holt ihre
          Daten beim Einhängen, und „Hub & Agenten" fragt jeden Arm nach
          seinen Containern. Der Schlüssel baut beim Wechsel neu auf, damit
          kein Zustand eines Reiters in den nächsten wandert. */}
      <div key={active.id} className="flex flex-col gap-5">
        {active.render({ role, language, onLanguageChange })}
      </div>
    </div>
  );
}
