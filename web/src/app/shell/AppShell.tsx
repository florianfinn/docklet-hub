import { useState, type CSSProperties, type ReactNode } from "react";
import { useLocation } from "react-router";
import { useTranslations } from "use-intl";

import { signOut } from "../../platform/session/api";
import type { Role } from "../../platform/session/session-user";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from "../../platform/ui/shadcn/breadcrumb";
import { Separator } from "../../platform/ui/shadcn/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "../../platform/ui/shadcn/sidebar";
import { Toaster } from "../../platform/ui/shadcn/sonner";
import { TooltipProvider } from "../../platform/ui/shadcn/tooltip";
import { AppSidebar } from "./AppSidebar";
import { CommandPalette } from "./CommandPalette";
import { areaForPath, navigationItemForPath } from "./navigation";

// Der Rahmen, in dem jeder Bildschirm des Hubs sitzt.
//
// ⚠️ ZWEI Rahmen, nicht einer:
//   - `AppShell` für die angemeldete Ansicht: Seitenleiste links, Kopfzeile
//     oben, Inhalt rechts.
//   - `PlainShell` für alles davor (Laden, Erstanmeldung, Anmeldung,
//     Fehlschlag): der Inhalt mittig auf dem Grund der Anwendung, ohne
//     Navigation. Wer noch nicht angemeldet ist, könnte sie nicht benutzen.
//
// ⚠️ Der Name ist bewusst `PlainShell` und NICHT `GuestShell`, wie er bis #70
// hieß. Es gibt in diesem System keinen Gast: Zugang gibt es nur über ein
// Konto. Der Name beschrieb eine Rolle, die es nicht gibt, statt das, was der
// Rahmen ist — nämlich der schlanke ohne Navigation. Er hat dazu geführt, dass
// das System in Begriffen erklärt wurde, die es nicht kennt.
// Beide kommen aus diesem Modul und tragen dieselben Token.

// 234 px aus docs/design/mockup/container-module.html Z. 86. Der Baustein
// `sidebar` bringt 16rem mit und liest die Breite aus `--sidebar-width`; der
// Wert wird deshalb hier gesetzt und nicht im Baustein geändert.
const SIDEBAR_WIDTH = "234px";

// Die Höhe der Kopfzeile, als Variable und nicht als `h-14`. Eine Fläche, die
// das Fenster füllt und in sich scrollt (der Reiter „Protokoll"), rechnet ihre
// Höhe als `100svh` minus genau diesen Wert; stünde er dort ein zweites Mal
// als Zahl, liefe er beim nächsten Umbau der Kopfzeile auseinander, und die
// Seite scrollte wieder um die Differenz.
const SHELL_HEADER_HEIGHT = "3.5rem";

// ⚠️ Kein `activeItemId` und kein `onNavigate` mehr. Beides stand hier bis
// D6b, weil der aktive Eintrag in einem `useState` in `web/src/App.tsx` lag
// und durch zwei Schichten nach unten gereicht wurde. Seit D6b trägt ihn die
// ADRESSE: die Schale liest sie über `useLocation()`, die Seitenleiste zeichnet
// Verweise, und niemand muss den Zustand mehr weiterreichen. Zwei Eigenschaften
// weniger sind nicht der Punkt — der Punkt ist, dass es den Zustand nicht mehr
// gibt, den zwei Stellen auseinanderlaufen lassen könnten.
type AppShellProps = {
  userName: string;
  role: Role;
  onSignedOut: () => void;
  children: ReactNode;
};

export function AppShell({ userName, role, onSignedOut, children }: AppShellProps) {
  const t = useTranslations();
  const [searchOpen, setSearchOpen] = useState(false);
  const { pathname } = useLocation();

  // ⚠️ KEIN Rückfall auf `navigationItems[0]`. Er stand hier, solange jede
  // Fläche einen Eintrag hatte; mit Routen ohne Eintrag (die Stack-Seite, „Mein
  // Konto") wäre er eine Lüge — die Brotkrume schriebe „Übersicht" über eine
  // Fläche, die etwas anderes zeigt. Gibt es keinen Eintrag zur Adresse, trägt
  // die Brotkrume nur den Namen der Anwendung.
  const activeItem = navigationItemForPath(pathname);

  // ⚠️ BEFUND aus D6b behoben: hier stand `data-area="operations"` FEST, am
  // `SidebarProvider" unten. Seitenleiste und Kopfzeile blieben damit im Ton
  // des Betriebs, auch wenn der Inhalt auf einer Verwaltungsfläche stand
  // (`/account`, `/settings`) — die beiden Flächen setzten das richtige
  // `data-area` deshalb selbst an ihrer eigenen Wurzel, eine Ebene zu tief:
  // die Seitenleiste blieb betrieblich gefärbt. `areaForPath` (D6b, #62,
  // `web/src/app/shell/navigation.ts`) hängt den Bereich an dieselbe Adresse, die
  // hier ohnehin schon für die Brotkrume gelesen wird — EINE Quelle, wie beim
  // aktiven Navigationseintrag oben.
  const area = areaForPath(pathname);

  // Das Abmelden gehört in die Schale und nicht in einen Bildschirm: das
  // Namensschild steht in jeder angemeldeten Ansicht, der Bildschirm wechselt.
  // Auch ein fehlgeschlagener Aufruf endet im Neuladen — der übergeordnete
  // Zustand fragt die Sitzung dann ohnehin neu ab und zeigt die Wahrheit.
  const handleSignOut = () => {
    void signOut().finally(onSignedOut);
  };

  return (
    // ⚠️ Der TooltipProvider steht an der Wurzel, obwohl `SidebarProvider`
    // einen eigenen mitbringt: dessen Geltung endet an der Seitenleiste. Ohne
    // diesen hier öffnete ein Tooltip in der Kopfzeile oder im Inhalt nicht.
    <TooltipProvider>
      {/* Die Achse. `data-area` beantwortet „wo bin ich"; der Host beantwortet
          später „woran arbeite ich" und färbt den Inhalt. Der Wert ist nicht
          frei — web/src/platform/theme/palette.css vergibt genau zwei
          (`operations`, `management`) und rechnet daraus den Grundton der
          ganzen Fläche. Der abgemeldete Rahmen trägt ihn NICHT: er liegt in
          keinem Bereich.

          ⚠️ Seit D6b (#62) hängt der Wert an der ADRESSE (`area`, oben aus
          `areaForPath(pathname)`) und steht nicht mehr fest — sonst bliebe
          die Seitenleiste im Ton des Betriebs, während der Inhalt auf einer
          Verwaltungsfläche steht. */}
      <SidebarProvider
        data-area={area}
        style={{ "--sidebar-width": SIDEBAR_WIDTH, "--shell-header-height": SHELL_HEADER_HEIGHT } as CSSProperties}
      >
        <AppSidebar
          userName={userName}
          role={role}
          onSearch={() => setSearchOpen(true)}
          onSignOut={handleSignOut}
        />
        <SidebarInset className="min-w-0">
          <header className="flex h-(--shell-header-height) shrink-0 items-center gap-2 border-b border-border px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
            <Breadcrumb>
              <BreadcrumbList>
                {/* Der Name der Anwendung tritt auf schmalen Schirmen zurück —
                    aber nur, solange etwas Genaueres daneben steht. Ohne
                    Eintrag zur Adresse ist er das Einzige, was die Kopfzeile
                    hat, und bleibt dann sichtbar. */}
                <BreadcrumbItem className={activeItem === undefined ? undefined : "hidden md:block"}>
                  {t("appTitle")}
                </BreadcrumbItem>
                {activeItem !== undefined && (
                  <>
                    <BreadcrumbSeparator className="hidden md:block" />
                    <BreadcrumbItem>
                      <BreadcrumbPage>{t(activeItem.labelKey)}</BreadcrumbPage>
                    </BreadcrumbItem>
                  </>
                )}
              </BreadcrumbList>
            </Breadcrumb>
          </header>
          <div className="min-w-0 flex-1">{children}</div>
        </SidebarInset>
        <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
      </SidebarProvider>

      {/* Die Meldungsecke. `toast.error(…)` schreibt in dieses eine Fenster;
          ohne es bliebe jeder Aufruf wirkungslos — der LanguageProvider
          meldete einen fehlgeschlagenen Sprachwechsel an niemanden, und der
          Rücksprung sähe aus wie ein klemmender Schalter.

          ⚠️ WARUM HIER UND NICHT IN `PlainShell`: melden kann nur, wer etwas
          auslöst, und ausgelöst wird heute nur aus der angemeldeten Ansicht —
          der Sprachumschalter steht im Namensschild der Seitenleiste. Vor der
          Anmeldung gibt es keinen Aufruf, den dieses Fenster zeigen könnte;
          ein zweites dort wäre eine Vorsorge für einen Fall, den es nicht
          gibt. Bekommt `PlainShell` eines Tages eine Meldung, gehört das
          Fenster dorthin — nicht vorher.

          ⚠️ WARUM NEBEN `SidebarProvider` UND NICHT DARIN: dessen Wurzel ist
          der Flex-Behälter aus Seitenleiste und Inhalt. Ein Kind mehr darin
          wäre ein Element in genau diesem Fluss; hier steht es daneben und
          legt sich als eigene Ebene über die Fläche, ohne die Kopfzeile oder
          den Inhalt zu verschieben. */}
      <Toaster />
    </TooltipProvider>
  );
}

// Der schlanke Rahmen: kein `data-area`, keine Navigation, dieselbe Schrift und
// dieselben Farben.
//
// Keine Landmarke `main`, weil WER HIER GERENDERT WIRD, SIE SELBST MITBRINGT:
// `SetupView` und `SignInView` über `AuthCard`
// (`web/src/features/account/AuthCard.tsx`), die zustandslosen Meldungen — das Laden
// und der Fehlschlag — in `web/src/App.tsx` selbst. Setzte dieser Rahmen eine
// eigene, läge bei Einrichtung und Anmeldung eine in der anderen; genau diese
// Verschachtelung wurde in diesem Paket schon einmal behoben.
//
// ⚠️ Hier stand bis D4 `FormShell` aus `web/src/screens/form.tsx`. Beides gibt
// es nicht mehr — die Datei ist gelöscht, der Rahmen heißt `AuthCard`. Kein
// Wächter fängt einen solchen Verweis: der Wächter über die Löschung
// (`web/tests/auth-screens.test.mjs`, Prüfung 1) sucht Modulbezeichner erst,
// NACHDEM er die Kommentare entfernt hat. Ein toter Pfad im Kommentar bleibt
// darum grün und wird trotzdem geglaubt.
export function PlainShell({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <div className="flex min-h-svh w-full items-center justify-center bg-background font-sans text-foreground">
        {children}
      </div>
    </TooltipProvider>
  );
}
