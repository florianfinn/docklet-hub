import { ChevronsUpDown, LogOut, Search, Settings, UserRound } from "lucide-react";
import { Link, NavLink, useLocation } from "react-router";
import { useTranslations } from "use-intl";

import type { Role } from "../../platform/session/session-user";
import { knownKey } from "../../platform/i18n/wire-labels";
import { initials } from "../../platform/ui/lib/initials";
import { Avatar, AvatarFallback } from "../../platform/ui/shadcn/avatar";
import { Button } from "../../platform/ui/shadcn/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "../../platform/ui/shadcn/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem
} from "../../platform/ui/shadcn/sidebar";
import {
  navigationGroupIds,
  navigationGroupLabelKeys,
  navigationItemForPath,
  navigationItems,
  type TranslationKey
} from "./navigation";

// Die Seitenleiste der angemeldeten Ansicht.
//
// Vorlage ist der Block in docs/design/mockup/container-module.html Z. 85–135.
// Von dort kommen die Maße, NICHT die Farben: das Artboard schreibt
// `var(--fg2)` und feste oklch-Werte, hier stehen die Tailwind-Klassen aus dem
// `@theme inline`-Block von web/src/platform/theme/tokens.css. Ein Wächter
// (web/tests/shell-navigation.test.mjs, Zusicherung 4) macht jede Klasse der
// Tailwind-Grundpalette rot.

// Die Rolle kommt als "admin" | "user" und wird über die Sprachdatei angezeigt.
const ROLE_LABEL_KEYS: Record<Role, TranslationKey> = {
  admin: "roleAdmin",
  user: "roleUser"
};

/**
 * Die Rolle als Text — nachgeschlagen und nicht indiziert; der Grund steht in
 * `i18n/wire-labels.ts`.
 *
 * ⚠️ DIESE ZUORDNUNG STEHT IN DIESEM REPO DREIMAL (hier, `ProfilePanel.tsx`,
 * `AccountsPanel.tsx`). Das ist ein eigener Befund und wird hier nicht
 * nebenbei behoben: `language-labels.ts` zeigt, wie eine solche Zuordnung
 * herausgezogen wird, und dieselbe Bewegung für die Rolle braucht eine
 * Entscheidung über die Schichtung — `Role` kommt aus `api/client`, und die
 * Sprachschicht kennt die API bisher nicht.
 */
function sidebarRoleLabel(t: ReturnType<typeof useTranslations>, role: string): string {
  const key = knownKey(ROLE_LABEL_KEYS, role);
  return key === null ? t("roleUnknown", { role }) : t(key);
}

type AppSidebarProps = {
  userName: string;
  role: Role;
  onSearch: () => void;
  onSignOut: () => void;
};

export function AppSidebar({ userName, role, onSearch, onSignOut }: AppSidebarProps) {
  const t = useTranslations();
  // Der aktive Eintrag kommt aus der Adresse und nicht mehr als Eigenschaft
  // von oben. Die Regel, WANN ein Pfad zu einem Eintrag gehört, steht dabei an
  // einer Stelle (`navigationItemForPath`) — hier und in der Brotkrume der
  // Schale dieselbe, sonst hätte die Seitenleiste eines Tages einen anderen
  // Eintrag ausgezeichnet, als die Kopfzeile benennt.
  const activeItem = navigationItemForPath(useLocation().pathname);

  return (
    // ⚠️ `border-sidebar-border` steht hier, weil der Baustein nur `border-r`
    // setzt und keine Farbe: ohne sie fiel die Kante auf `currentColor`
    // zurück und stand als harte Linie in der Schriftfarbe da (gemessen am
    // 2026-09-29 über `getComputedStyle` am `sidebar-container`: im hellen
    // Schema `oklch(0.235 0.014 265)`, also `--foreground`).
    <Sidebar collapsible="offcanvas" className="border-sidebar-border">

      <SidebarHeader className="gap-5 p-0 px-[14px] pt-[18px]">
        {/* Markenblock: 25-px-Quadrat mit Kürzel, daneben der Name in 15 px,
            halbfett.
            ⚠️ Die Fläche ist `--foreground` auf `--background`, also die
            Umkehrung des Grundes — genau das, was das Artboard mit
            `background: var(--fg); color: var(--bg)` schreibt, nur als Token.
            Die `--mark-*`-Token stehen bewusst NICHT hier: sie gehören zum
            Farbeinsatz eines HOSTS (palette.css, Abschnitte 4 und 5), und der
            Name des Hubs ist kein Host. */}
        <div className="flex items-center gap-[10px] px-[9px]">
          <span
            aria-hidden="true"
            className="flex size-[25px] shrink-0 items-center justify-center rounded-lg bg-foreground text-[12px] font-semibold text-background"
          >
            {initials(t("appTitle"))}
          </span>
          <span className="truncate text-[15px] font-semibold tracking-tight text-sidebar-foreground">
            {t("appTitle")}
          </span>
        </div>

        {/* Der Suchknopf: volle Breite, links das Wort mit der Lupe, rechts die
            Tastenkombination in Schreibmaschinenschrift. Er öffnet dieselbe
            Palette wie ⌘K — ein zweiter Weg zur selben Tür, kein zweiter
            Mechanismus. */}
        {/* Hover: die Fläche nimmt den Ton des Bereichs an (`--sidebar-accent`)
            statt nur um 20 % durchsichtiger zu werden, und das Kürzel rechts
            hebt sich mit — dieselbe Sprache wie die Einträge darunter. */}
        <Button
          type="button"
          variant="secondary"
          className="group/search w-full justify-between border border-sidebar-border px-[11px] text-muted-foreground transition-colors duration-150 hover:border-accent-line hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          onClick={onSearch}
        >
          <span className="inline-flex items-center gap-2">
            <Search className="size-3.5" />
            {t("shellSearch")}
          </span>
          <kbd className="rounded-sm border border-sidebar-border bg-background/60 px-1.5 py-px font-mono text-[10.5px] text-subtle-foreground transition-colors duration-150 group-hover/search:text-sidebar-accent-foreground">
            {t("shellSearchShortcut")}
          </kbd>
        </Button>
      </SidebarHeader>

      {/* `pt-6` trennt Suche und erste Gruppe; bis hierher stieß die
          Gruppenüberschrift ohne Luft an den Suchknopf. `gap-6` gilt zwischen
          den Gruppen, sobald es mehr als eine gibt. */}
      <SidebarContent className="gap-6 px-[14px] pt-6">
        {navigationGroupIds.map((groupId) => (
          <SidebarGroup key={groupId} className="p-0">
            <SidebarGroupLabel className="h-auto px-[11px] pb-2 text-[11px] font-medium tracking-wider text-subtle-foreground uppercase">
              {t(navigationGroupLabelKeys[groupId])}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-[2px]">
                {navigationItems
                  .filter((item) => item.group === groupId)
                  .map((item) => (
                    <SidebarMenuItem key={item.id}>
                      {/* 35 px hoch, 17 px Symbol, 11 px Abstand — die Maße des
                          Artboards. Der aktive Eintrag trägt über `isActive`
                          die Fläche `--sidebar-accent`, und die zeigt in
                          palette.css auf `--accent`.

                          ⚠️ Seit D6b ist der Eintrag ein VERWEIS und kein
                          Knopf: `asChild` reicht die Gestalt an den `NavLink`
                          durch. Das ist keine Formsache — ein Verweis hat eine
                          Adresse, und damit funktionieren die mittlere
                          Maustaste, „Link in neuem Tab öffnen" und das
                          Kopieren der Adresse. Ein `onClick` auf einem `button`
                          kann das alles nicht.

                          ⚠️ Der `NavLink` kommt VON AUSSEN in den übernommenen
                          Baustein hinein und nicht umgekehrt: `react-router`
                          steht nicht auf der Paketliste von
                          `web/tests/vendored-origin.test.mjs`, und ein Import
                          in `web/src/platform/ui/shadcn/` machte diesen Wächter rot.
                          `asChild` ist genau der Weg, der das vermeidet.

                          `end`, damit „/" nicht unter jeder Adresse aktiv ist:
                          `NavLink` hält einen Pfad sonst auch für einen
                          Präfixtreffer aktiv, und die Übersicht wäre auf
                          „/hosts" mit ausgezeichnet.

                          Hover und Aktiv sind zwei Stufen und nicht mehr
                          dieselbe Fläche: der Baustein legt auf beide
                          `--sidebar-accent`, und ein überfahrener Eintrag sah
                          damit aus wie der aktive. Hover ist jetzt eine
                          neutrale Aufhellung, und das Symbol rückt um 2 px
                          nach rechts; der aktive Eintrag behält die getönte
                          Fläche und trägt dazu links einen Strich in
                          `--sidebar-primary`. Inaktive Einträge stehen in
                          `--muted-foreground`, damit der aktive heraussticht. */}
                      <SidebarMenuButton
                        asChild
                        className="relative h-[35px] gap-[11px] px-[11px] text-muted-foreground transition-[background-color,color] duration-150 ease-out before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:scale-y-0 before:rounded-full before:bg-sidebar-primary before:transition-transform before:duration-200 hover:bg-sidebar-foreground/6 hover:text-sidebar-foreground active:bg-sidebar-foreground/10 data-[active=true]:before:scale-y-100 data-[active=true]:hover:bg-sidebar-accent data-[active=true]:hover:text-sidebar-accent-foreground [&>svg]:size-[17px] [&>svg]:transition-transform [&>svg]:duration-150 [&>svg]:ease-out hover:[&>svg]:translate-x-0.5 motion-reduce:[&>svg]:transition-none"
                        isActive={item.id === activeItem?.id}
                        tooltip={t(item.labelKey)}
                      >
                        <NavLink to={item.path} end>
                          <item.icon aria-hidden="true" strokeWidth={1.8} />
                          <span>{t(item.labelKey)}</span>
                        </NavLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      {/* Das Namensschild unten links: oben abgetrennt durch eine Linie,
          28-px-Kreis mit Initialen, daneben Name und Rolle.

          Der Knopf trägt dieselbe Einrückung wie die Einträge oben, damit
          Kreis und Symbole auf einer Flucht stehen — bis hierher saß er ohne
          Innenabstand an der Kante, und Hover war ausdrücklich abgeschaltet.
          Jetzt hellt er beim Überfahren auf wie ein Eintrag, der Kreis nimmt
          den Ton des Bereichs an, und rechts steht ein Chevron als Zeichen,
          dass hier ein Menü aufgeht. Bei offenem Menü bleibt die getönte
          Fläche stehen. */}
      <SidebarFooter className="mx-[14px] border-t border-sidebar-border px-0 pt-3 pb-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  aria-label={t("shellAccountMenu")}
                  className="group/account h-auto gap-[10px] px-[6px] py-[7px] transition-colors duration-150 ease-out hover:bg-sidebar-foreground/6 hover:text-sidebar-foreground active:bg-sidebar-foreground/10 data-[state=open]:bg-sidebar-accent data-[state=open]:hover:bg-sidebar-accent [&>svg]:size-3.5"
                >
                  <Avatar className="size-7 border border-sidebar-border transition-colors duration-150 group-hover/account:border-accent-line group-data-[state=open]/account:border-accent-line">
                    <AvatarFallback className="bg-sidebar-accent text-[10.5px] font-semibold text-sidebar-accent-foreground">
                      {initials(userName)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="grid flex-1 text-left leading-tight">
                    <span className="truncate text-[13px] font-medium text-sidebar-foreground">{userName}</span>
                    <span className="truncate text-[11px] text-subtle-foreground">{sidebarRoleLabel(t, role)}</span>
                  </span>
                  <ChevronsUpDown
                    aria-hidden="true"
                    className="text-subtle-foreground transition-colors duration-150 group-hover/account:text-sidebar-foreground group-data-[state=open]/account:text-sidebar-foreground"
                  />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              {/* ⚠️ Hier stehen die zwei Flächen der Verwaltung und das
                  Abmelden — und sonst nichts.

                  An dieser Stelle stand bis D6b der Satz „es gibt weiterhin
                  keine Fläche ‚Mein Konto' und keine ‚Einstellungen'". Er
                  stimmt nicht mehr: beide GIBT es seit D6b
                  (`web/src/app/screens/AccountScreen.tsx` und `SettingsScreen.tsx`,
                  ihre Pfade in `standaloneRoutes` von
                  `web/src/app/routes/AppRoutes.tsx`), und deshalb stehen die
                  Punkte jetzt hier. Die Regel dahinter ist dieselbe geblieben
                  und hat sich nicht gelockert: ein Menüpunkt entsteht MIT
                  seiner Fläche, nicht vor ihr — ein Punkt, der nirgends
                  hinführt, ist derselbe Fehler wie ein ausgegrauter Eintrag.

                  ⚠️ DIE SPRACHE STEHT NICHT MEHR IN DIESEM MENÜ. Sie ist mit
                  D6b auf die Fläche „Einstellungen" GEWANDERT und nicht dorthin
                  kopiert worden. Zwei Umschalter für dieselbe Wahl wären zwei
                  Wahrheiten, und die erste Änderung an einem von beiden ließe
                  den anderen stehen. Wer sie hier vermisst, findet sie einen
                  Klick weiter — und dort neben dem, was mit D7 dazukommt.

                  ⚠️ Warum `asChild` mit einem `Link` und kein `onSelect` mit
                  `navigate(…)`: derselbe Grund wie am Eintrag der Navigation
                  oben — ein Verweis hat eine Adresse, also greifen mittlere
                  Maustaste, „in neuem Tab öffnen" und das Kopieren der
                  Adresse. Und `react-router` bleibt außerhalb des übernommenen
                  Bausteins (`web/tests/vendored-origin.test.mjs`).

                  ⚠️ Die beiden Pfade stehen hier als Zeichenkette und ein
                  zweites Mal in `standaloneRoutes`. Das ist der Preis dafür,
                  dass die Schale die Bildschirme NICHT kennt: ein gemeinsamer
                  Wert käme aus `web/src/app/routes/AppRoutes.tsx` und zöge mit dem
                  Import jede Fläche in den Modulbaum der Schale. Ein
                  Navigationseintrag trüge seinen Pfad an einer Stelle — aber
                  diese beiden Flächen gehören ausdrücklich nicht in die
                  Navigation (docs/design/hub-color-and-structure.md §5). */}
              <DropdownMenuContent align="start" side="top" className="w-(--radix-popper-anchor-width)">
                <DropdownMenuItem asChild>
                  <Link to="/account">
                    <UserRound aria-hidden="true" />
                    {t("accountTitle")}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/settings">
                    <Settings aria-hidden="true" />
                    {t("settingsTitle")}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onSignOut}>
                  <LogOut aria-hidden="true" />
                  {t("signOut")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
