import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router";

import type { SessionUser } from "../../platform/session/session-user";
import { useLanguage, type LanguageContextValue } from "../../platform/i18n";
import { AccountScreen } from "../screens/AccountScreen";
import { ContainerScreen } from "../screens/ContainerScreen";
import { ContainersScreen } from "../screens/ContainersScreen";
import { HostResourcesScreen } from "../screens/HostResourcesScreen";
import { HostsScreen } from "../screens/HostsScreen";
import { OverviewScreen } from "../screens/OverviewScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { StackScreen } from "../screens/StackScreen";
import { defaultNavigationPath, navigationItems, type AreaId } from "../shell/navigation";

// Die Routentabelle der angemeldeten Ansicht (D6b, #62).
//
// ⚠️ WAS HIER NICHT STEHT, IST DER PUNKT: die Pfade. Sie stehen am
// Navigationseintrag (`web/src/app/shell/navigation.ts`, Feld `path`), und diese
// Datei LIEST sie. Vor D6b hielt `web/src/App.tsx` den aktiven Eintrag in
// einem `useState` und suchte die Fläche über die `id` heraus; mit einem
// Router käme der Pfad als dritte Liste dazu, wenn er hier noch einmal
// hingeschrieben würde. Zwei Listen sind schon eine zu viel — es bleibt bei
// einer Quelle je Sache: der Pfad am Eintrag, die Fläche hier.
//
// Warum die Tabelle nicht in `web/src/app/shell/` liegt: die Schale ist der
// Rahmen und soll die Bildschirme NICHT kennen. Stünde die Zuordnung dort,
// zöge jeder neue Bildschirm einen Import in `shell/` nach sich, und die
// Trennung zwischen Rahmen und Inhalt wäre nur noch eine Erzählung. Sie liegt
// aus demselben Grund auch nicht mehr in `App.tsx`: dort steht die Frage, WER
// zusieht (Einrichtung, Anmeldung, Sitzung), hier die Frage, WAS unter einer
// Adresse steht.

// Was ein Navigationseintrag rendert. Schlüssel ist seine `id` aus
// `navigationItems`, NICHT der Pfad und nicht der Dateiname.
//
// ⚠️ Die Zuordnung entsteht je Aufruf und nicht auf Modulebene: `HostsScreen`
// braucht die Rolle aus der Sitzung, und die gibt es erst, wenn jemand
// angemeldet ist. Ein Modulwert müsste sie über eine Variable nachreichen und
// wäre beim ersten Rendern falsch.
//
// ⚠️ Der Wächter `web/tests/screen-switching.test.mjs` sucht diese Zuordnung
// über ihren Namen. Wer sie umbenennt, benennt auch dort um — ein Wächter, der
// nichts findet, ist keiner.
function screensFor(user: SessionUser): Record<string, ReactNode> {
  const screens: Record<string, ReactNode> = {
    // ⚠️ `role` seit dem Ausblenden von Stacks: `PUT …/stacks/:project/hidden`
    // steht hinter `requireAdmin`, und ohne Rolle zeigte das Kontextmenü
    // einen Eintrag, der im 403 endet.
    overview: <OverviewScreen role={user.role} />,
    // ⚠️ `role` seit D7b/C2: der Deepdive ist der Ort, an dem die Marken eines
    // einzelnen Containers vergeben werden, und `PUT …/containers/:name/marks`
    // steht hinter `requireAdmin`.
    containers: <ContainersScreen role={user.role} />,
    hosts: <HostsScreen role={user.role} />
  };
  return screens;
}

// Eine Route OHNE Navigationseintrag.
//
// ⚠️ Das ist kein Sonderfall, sondern der Normalfall für alles, was man
// ERREICHT statt ANZUSTEUERN: eine Detailfläche, auf die eine Liste verweist,
// und die Flächen am Profil-Knopf unten links. Sie tragen ihren Pfad selbst,
// weil es keinen Eintrag gibt, der ihn trüge — und ihr `screen` genau wie ein
// Eintrag, damit der Wächter auch hier prüfen kann, dass die Fläche wirklich
// unter `web/src/app/screens/` liegt. Ohne dieses Feld wäre eine Route auf eine
// Datei, die es nicht gibt, ein Fehler, den erst der Aufruf zeigt.
// ⚠️ `area` (D6b, #62) wird zur LAUFZEIT von keinem Bauteil gelesen — genau
// wie `screen` oben ist es hier die maschinell nachvollziehbare Angabe neben
// dem Pfad, dem diese Route gehört: „Mein Konto" und „Einstellungen" sind
// Verwaltung, die Stack-Seite ist Betrieb
// (`docs/design/hub-color-and-structure.md` §1). Die Schale KANN diese Liste
// nicht lesen — sie liegt in `web/src/app/routes/`, und `AppShell.tsx` darf die
// Bildschirme nicht kennen (Begründung unten an `standaloneRoutesFor`) — und
// trägt deshalb in `web/src/app/shell/navigation.ts` (`managementPaths`)
// dieselben Pfade ein zweites Mal, dort ohne Bildschirm.
//
// ⚠️ Zwei Stellen, die dasselbe sagen, laufen auseinander — deshalb hält sie
// `web/tests/screen-switching.test.mjs` („der Bereich einer Route ohne
// Eintrag steht an beiden Stellen gleich") gegeneinander: was hier als
// Verwaltung steht, muss dort stehen, und ein Pfad dort, unter dem keine
// Route liegt, ist ebenfalls rot. Ohne diese Zusicherung wäre `area` hier
// eine Angabe, die niemand liest und die deshalb lügen darf. Gefunden hat die
// Lücke ein Prüfer, nicht der Bauende.
export type StandaloneRoute = {
  path: string;
  screen: string;
  area: AreaId;
  element: ReactNode;
};

// ⚠️ Die Seite eines Stacks ist der erste Eintrag hier, und sie ist der Grund,
// aus dem es diese Liste gibt: man ERREICHT sie über die Übersicht oder den
// Deepdive, man steuert sie nicht an. Ein Menüpunkt „Stack" wäre sinnlos — er
// kennt weder Host noch Projekt.
//
// ⚠️ EIN STACK HAT IM HUB KEINE KENNUNG (docs/design/hub-color-and-structure.md
// §6). Die Adresse hängt deshalb am Paar aus Host-Kennung und Compose-Projekt.
// Gebaut wird sie von `stackPath` in `web/src/platform/routes/stack-path.ts`,
// das den Projektnamen kodiert; der Pfad steht hier trotzdem noch einmal als
// Zeichenkette, weil der Wächter `web/tests/screen-switching.test.mjs` ein
// LITERAL liest (`stringField`) und einen Bezeichner weder gegen eine Datei
// noch gegen einen zweiten Pfad halten könnte.
//
// `SetupView` und `SignInView` stehen weiterhin nicht hier: sie liegen vor
// der Anmeldung in `PlainShell` und unter keiner Route der Schale.
//
// ⚠️ Seit D6b stehen hier die beiden Flächen am Profil-Knopf: „Benutzer &
// Profil" unter „/account" und „Einstellungen" unter „/settings". Sie tragen
// ihren Pfad genau deshalb selbst — sie hängen am Namensschild unten links und
// haben keinen Navigationseintrag, der ihn trüge
// (docs/design/hub-color-and-structure.md §5, „Verwaltung hängt am Profil").
//
// ⚠️ Die Liste entsteht je Aufruf und nicht mehr auf Modulebene — derselbe
// Grund wie bei `screensFor` oben: `AccountScreen` braucht das angemeldete
// Konto (Name, E-Mail und vor allem die ROLLE, die darüber entscheidet, ob die
// Konten-Tabelle überhaupt geladen wird). Ein Modulwert müsste es über eine
// Variable nachreichen und wäre beim ersten Rendern falsch.
//
// ⚠️ Der SPRACHUMSCHALTER kommt aus demselben Grund von hier und nicht aus dem
// Bildschirm selbst — und aus einem zweiten: der Wächter
// `web/tests/auth-screens.test.mjs` (Prüfung 3) macht den schreibenden Aufruf
// des Sprachanbieters in JEDER `.tsx` unter `web/src/app/screens/` rot, weil ein
// solcher Aufruf vor der Anmeldung in einer 401 endet. Sein eigener Kopf nennt
// den Weg für den Fall danach: aus der angemeldeten Ansicht rufen. Diese
// Tabelle IST die angemeldete Ansicht — `web/src/App.tsx` rendert sie nur im
// Zustand `signedIn` —, und hier steht die Sitzung fest.
function standaloneRoutesFor(user: SessionUser, language: LanguageContextValue): StandaloneRoute[] {
  const standaloneRoutes: StandaloneRoute[] = [
    {
      path: "/stack/:hostId/:project",
      screen: "StackScreen",
      area: "operations",
      // ⚠️ `role` ist seit D7b/C2 dabei: die Seite ist der Ort, an dem die
      // Marken eines Stacks und seine Einrückung vergeben werden, und beide
      // Schreibrouten stehen hinter `requireAdmin`. Aus DEMSELBEN `user` wie
      // bei den zwei Einträgen darunter — es gibt im Web keinen Anbieter für
      // die Sitzung, und ein eigener `GET /api/session` aus der Fläche heraus
      // wäre eine zweite Quelle für dieselbe Auskunft.
      element: <StackScreen role={user.role} tab="overview" />
    },
    // ⚠️ ZWEI ROUTEN AUF DIE STACK-SEITE, aus demselben Grund wie bei der
    // Container-Seite darunter: der Reiter steht in der ADRESSE. Hier wiegt
    // das schwerer — der Compose-Reiter trägt einen ungespeicherten Entwurf,
    // und ein Neuladen, das auf den ersten Reiter zurückfiele, sähe für den
    // Betreiber aus, als sei seine Bearbeitung weg.
    //
    // ⚠️ KEINE EIGENE ROLLENPRÜFUNG HIER. Die Adresse ist für jeden
    // Angemeldeten erreichbar; die Fläche selbst zeigt den Reiter nur dem
    // Admin und hängt `ComposeView` nur für ihn ein. Eine zweite Prüfung an
    // dieser Stelle wäre eine zweite Wahrheit über dieselbe Frage — und die
    // eigentliche Schranke steht ohnehin am Server (`requireAdmin` vor allen
    // drei Compose-Routen).
    // ⚠️ DER REITER „PROTOKOLL" (#183), OHNE ROLLENPRÜFUNG aus einem anderen
    // Grund als beim Compose-Reiter darunter: Logs lesen ist eine Fähigkeit
    // der Rolle User (docs/design/phase-5-write-access.md §4), und die
    // Log-Route am Server steht hinter `withSession` und nicht hinter
    // `requireAdmin`. Die Fläche zeigt diesen Reiter deshalb jedem.
    {
      path: "/stack/:hostId/:project/logs",
      screen: "StackScreen",
      area: "operations",
      element: <StackScreen role={user.role} tab="logs" />
    },
    {
      path: "/stack/:hostId/:project/compose",
      screen: "StackScreen",
      area: "operations",
      element: <StackScreen role={user.role} tab="compose" />
    },
    // ⚠️ ZWEI ROUTEN AUF DIESELBE FLÄCHE, und das ist erlaubt: verboten ist
    // derselbe PFAD zweimal („kein Pfad zweimal" in
    // `web/tests/screen-switching.test.mjs`), nicht dieselbe Fläche unter zwei
    // Adressen. Der Reiter der Container-Detailseite steht in der ADRESSE
    // (Entscheidung des Betreibers vom 2026-09-07): ein Lesezeichen und ein
    // Neuladen landen wieder dort, wo der Mensch war — bei einer Fehlersuche
    // der Normalfall. Ein Zustand in der Fläche fiele beim Neuladen auf den
    // ersten Reiter zurück.
    //
    // ⚠️ WELCHER REITER GILT, STEHT HIER UND NICHT IN DER FLÄCHE. Sie bekommt
    // ihn als Angabe, statt ihn aus `useLocation()` zurückzurechnen: so steht
    // die Zuordnung „diese Adresse zeigt jenen Reiter" an einer Stelle,
    // sichtbar neben dem Pfad, den der Wächter ohnehin liest.
    //
    // ⚠️ Die Pfade stehen als LITERAL da, obwohl `containerPath` in
    // `web/src/platform/routes/container-path.ts` sie baut — derselbe Grund
    // wie eine Zeile höher bei der Stack-Seite: der Wächter liest ein Literal
    // (`stringField`) und könnte einen Bezeichner weder gegen eine Datei noch
    // gegen einen zweiten Pfad halten.
    //
    // ⚠️ `:name` UND NICHT `:containerId`. Eine Container-Kennung wechselt bei
    // jedem Neuerstellen; ein Lesezeichen darauf wäre nach dem nächsten
    // `compose up` tot. Der Name überlebt, und die Fläche löst ihn über
    // `fetchOverview()` in die Kennung auf, mit der die Log-Route arbeitet.
    //
    // ⚠️ `area: "operations"` — ein Container ist Betrieb
    // (`docs/design/hub-color-and-structure.md` §1). Damit gehören diese
    // beiden Pfade AUSDRÜCKLICH NICHT in `managementPaths` in
    // `web/src/app/shell/navigation.ts`; der Wächter hält beide Stellen
    // gegeneinander und macht einen Betriebspfad dort rot.
    {
      path: "/container/:hostId/:name",
      screen: "ContainerScreen",
      area: "operations",
      element: <ContainerScreen tab="overview" />
    },
    {
      path: "/container/:hostId/:name/logs",
      screen: "ContainerScreen",
      area: "operations",
      element: <ContainerScreen tab="logs" />
    },
    // ⚠️ DER PFAD IN DER FREIGABE STEHT NICHT IN DIESER ROUTE (Paket B5,
    // Etappe E5a, #5). Er reist als Abfrageteil (`?path=…`), und der gehört
    // keiner Route: ein Pfad in der Freigabe enthält selbst Schrägstriche und
    // bräuchte als Segment einen Splat, den react-router an genau diesen
    // Schrägstrichen wieder zerlegte. Die Begründung mit allen drei Gründen
    // steht in `web/src/features/files/file-paths.ts`.
    {
      path: "/container/:hostId/:name/files",
      screen: "ContainerScreen",
      area: "operations",
      element: <ContainerScreen tab="files" />
    },
    // ⚠️ DER VIERTE REITER, „Shell" (Paket B6, Etappe E6, #5). Der Pfad steht
    // als LITERAL da, obwohl `containerPath` ihn baut — derselbe Grund wie bei
    // den drei Zeilen darüber: `web/tests/screen-switching.test.mjs` liest ein
    // Literal (`stringField`) und könnte einen Bezeichner weder gegen eine
    // Fläche noch gegen einen zweiten Pfad halten.
    //
    // ⚠️ `area: "operations"` wie die drei anderen. Eine Shell ist Betrieb und
    // nicht Verwaltung; damit gehört dieser Pfad AUSDRÜCKLICH NICHT in
    // `managementPaths` in `web/src/app/shell/navigation.ts`, und der Wächter hält
    // beide Stellen gegeneinander.
    {
      path: "/container/:hostId/:name/shell",
      screen: "ContainerScreen",
      area: "operations",
      element: <ContainerScreen tab="shell" />
    },
    // The resources of one host (#10), reached from its card. A host is
    // operations, so this path stays out of `managementPaths`.
    {
      path: "/hosts/:hostId/resources",
      screen: "HostResourcesScreen",
      area: "operations",
      element: <HostResourcesScreen role={user.role} />
    },
    { path: "/account", screen: "AccountScreen", area: "management", element: <AccountScreen user={user} /> },
    {
      path: "/settings",
      screen: "SettingsScreen",
      area: "management",
      // ⚠️ `role` ist seit D7a dabei: die Fläche trägt den Theme- und
      // Farbeditor, und dessen beide Schreibrouten stehen hinter
      // `requireAdmin`. Sie kommt aus DEMSELBEN `user` wie bei `AccountScreen`
      // — es gibt im Web keinen Anbieter für die Sitzung, und ein eigener
      // `GET /api/session` aus der Fläche heraus wäre eine zweite Quelle für
      // dieselbe Auskunft.
      element: (
        <SettingsScreen
          role={user.role}
          language={language.language}
          onLanguageChange={language.change}
        />
      )
    }
  ];
  return standaloneRoutes;
}

// Die Anwendung unterhalb der Schale.
//
// ⚠️ Die letzte Route ist der Auffang. Ohne sie stünde unter einer unbekannten
// Adresse die Schale mit einer LEEREN Fläche da — Kopfzeile, Seitenleiste, und
// dazwischen nichts. `replace` statt eines Vorwärtssprungs, damit der
// Zurück-Knopf nicht in die unbekannte Adresse zurückfällt und von dort sofort
// wieder umgeleitet wird.
//
// ⚠️ Der Auffang steht ABSICHTLICH als JSX hier und nicht in einer der beiden
// Listen oben: er zeigt auf keine Fläche unter `web/src/app/screens/`, und der
// Wächter verlangt für jede Route dort genau die.
export function AppRoutes({ user }: { user: SessionUser }) {
  const screens = screensFor(user);
  // Die Sprache kommt aus dem Anbieter und nicht als Eigenschaft von oben: sie
  // steht in keinem Zustand dieser Datei. Gebraucht wird sie für die Fläche
  // „Einstellungen", die den Umschalter trägt.
  const language = useLanguage();
  const standaloneRoutes = standaloneRoutesFor(user, language);

  return (
    <Routes>
      {navigationItems.map((item) => (
        <Route key={item.id} path={item.path} element={screens[item.id]} />
      ))}
      {standaloneRoutes.map((route) => (
        <Route key={route.path} path={route.path} element={route.element} />
      ))}
      <Route path="*" element={<Navigate to={defaultNavigationPath} replace />} />
    </Routes>
  );
}
