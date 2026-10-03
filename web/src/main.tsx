import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import { App } from "./App";
import { AppLanguageProvider } from "./app/i18n/AppLanguageProvider";
import { AppQueryProvider } from "./app/query/AppQueryProvider";
import { GlobalThemeProvider } from "./features/appearance";
import "./styles.css";

// Der Einstieg — und sonst nichts. Was angezeigt wird, entscheidet App.tsx.
//
// Die Sprachschicht liegt HIER und nicht in App.tsx: sie umschließt jeden der
// Zustände, die App.tsx unterscheidet, den Ladezustand eingeschlossen. Stünde
// sie darin, hinge sie an einem Zweig des `switch` — und der erste Bildschirm,
// der ohne Anmeldung erscheint, hätte keine.
//
// Der Router liegt aus demselben Grund hier und umschließt alles: die Routen
// gelten erst in der angemeldeten Ansicht, aber `useLocation` und `<Link>`
// müssen überall benutzbar sein, ohne dass jemand erst nachsieht, in welchem
// Zweig des `switch` er gerade steht.
//
// Die Schicht der globalen Stellschrauben liegt aus demselben Grund hier: sie
// schreibt die sieben Werte aus D7 an `<html>`, und das gilt für JEDEN
// Zustand, den App.tsx unterscheidet — auch für die beiden Bildschirme vor der
// Anmeldung, die die Vorgabe tragen. Abgerufen wird erst mit der Sitzung; wo
// das steht und warum, sagt der Kopf von
// `web/src/features/appearance/GlobalThemeProvider.tsx`.
//
// The query cache (#256) sits outermost for the same reason: `App.tsx` empties
// it when a session ends, so it must reach every state App.tsx tells apart.
//
// ⚠️ `BrowserRouter` und ausdrücklich NICHT `HashRouter`: die Adresse einer
// Fläche soll „…/hosts" lauten und nicht „…/#/hosts" — teilbar, im Protokoll
// des Servers lesbar, als Pfad zu sehen. Der Preis ist der Rückfall auf
// `index.html` für jeden Pfad, den der Server nicht als Datei kennt; den baut
// der Server im selben Paket. Solange er fehlt, ist ein NEULADEN unter
// „/hosts" ein 404 des Servers und kein Fehler dieses Routers — das Klicken in
// der Anwendung geht auch ohne ihn.

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root-Element fehlt");
}

createRoot(container).render(
  <StrictMode>
    <AppQueryProvider>
      <BrowserRouter>
        <AppLanguageProvider>
          <GlobalThemeProvider>
            <App />
          </GlobalThemeProvider>
        </AppLanguageProvider>
      </BrowserRouter>
    </AppQueryProvider>
  </StrictMode>
);
