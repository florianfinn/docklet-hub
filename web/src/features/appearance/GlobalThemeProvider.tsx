import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import {
  DEFAULT_GLOBAL_THEME,
  THEME_KNOBS,
  type GlobalThemePreset
} from "contract";
import { fetchGlobalTheme, setGlobalTheme } from "./api";

// Die sieben globalen Stellschrauben, angewandt auf `<html>` (D7, #62:
// „Anwendung durch Setzen der Variablen auf `<html>` bzw. dem Element der
// Achse; die Vorschau im Editor ist dieselbe Seite mit denselben Variablen").
//
// WARUM DIESE SCHICHT HIER LIEGT UND NICHT IM EDITOR
//
// Der Editor ist EINE Fläche unter vielen, und die Werte gelten für alle. Läge
// das Anwenden dort, hinge das Aussehen des ganzen Hubs daran, dass gerade
// jemand die Einstellungen offen hat. Diese Schicht steht deshalb über allem
// (`web/src/main.tsx`), wie die Sprachschicht: sie hält den geltenden Satz,
// schreibt ihn an das Wurzelelement und gibt der Fläche, die ihn ändert, zwei
// Wege dorthin.
//
// WARUM DIE VORSCHAU KEINE EIGENE FLÄCHE BRAUCHT
//
// Ein geänderter Wert steht sofort am Wurzelelement, und die CSS-Variablen in
// `web/src/platform/theme/tokens.css` lösen von dort ab neu auf — ohne Neuladen und
// ohne Markup-Wechsel. Der Editor zeigt seine Vorschau also, indem er
// `preview(…)` ruft und danach hinsieht: die Seite, auf der er steht, IST die
// Vorschau.
//
// ⚠️ VOR DER ANMELDUNG WIRD NICHT ABGERUFEN. `GET /api/settings` steht hinter
// `withSession`; die Anmelde- und Erstanmeldebildschirme laufen davor und
// bekämen eine 401. Der Abruf hängt deshalb an der Sitzung und nicht am
// Einhängen dieser Komponente: `web/src/App.tsx` ruft `load()`, sobald die
// Sitzung steht, und `reset()`, sobald keine mehr steht. Bis dahin gilt
// `DEFAULT_GLOBAL_THEME`.
//
// ⚠️ WARUM DAS NICHT UNGESTYLT AUFBLITZT: `:root` in `web/src/platform/theme/tokens.css`
// trägt genau die Werte, die `DEFAULT_GLOBAL_THEME` nennt — die Umschalter
// `[data-scheme="light"]`, `[data-chroma="…"]` und die übrigen sind
// ÜBERSCHREIBUNGEN und keine Voraussetzung. Der erste Anstrich steht also,
// bevor eine Zeile JavaScript gelaufen ist; was diese Schicht setzt, ist
// danach dasselbe noch einmal und beim angemeldeten Betreiber der gespeicherte
// Satz.
//
// ⚠️ KEIN ZWISCHENSPEICHER IM BROWSER. Ein `localStorage` mit dem zuletzt
// gesehenen Satz spart nach einem Neuladen einen Wimpernschlag und kostet zwei
// Dinge: eine zweite Ablage neben der des Servers, die auseinanderlaufen kann,
// und die Einstellung des Betreibers auf dem Bildschirm eines Besuchers, der
// noch nicht angemeldet ist. Vor der Anmeldung gilt die Vorgabe — so steht es
// im Paket, und so bleibt es.

export type GlobalThemeContextValue = {
  /** Der Satz, der gerade am Wurzelelement steht. */
  theme: GlobalThemePreset;
  /**
   * Anwenden, ohne zu speichern — die Vorschau des Editors.
   *
   * Wer sie ruft, ist dafür zuständig, den vorigen Satz wiederherzustellen,
   * wenn der Betreiber die Fläche verlässt, ohne zu speichern.
   */
  preview: (theme: GlobalThemePreset) => void;
  /**
   * Anwenden UND speichern (`PUT /api/settings/theme`, Admin).
   *
   * Zuerst umstellen, dann schreiben: die Oberfläche antwortet auf den Klick
   * und nicht auf die Antwort des Servers. Scheitert das Schreiben, steht der
   * vorige Satz wieder da und der Fehler kommt als `ApiError` aus dem
   * Promise — die Meldung dazu gehört der Fläche, die den Klick entgegennimmt,
   * denn nur sie weiß, wo sie hingehört.
   */
  save: (theme: GlobalThemePreset) => Promise<void>;
  /** Den gespeicherten Satz holen. Setzt eine Sitzung voraus. */
  load: () => void;
  /** Zurück auf die Vorgabe — für den Weg aus der Anmeldung heraus. */
  reset: () => void;
};

const GlobalThemeContext = createContext<GlobalThemeContextValue | null>(null);

export function useGlobalTheme(): GlobalThemeContextValue {
  const value = useContext(GlobalThemeContext);
  if (!value) {
    throw new Error("useGlobalTheme steht außerhalb von GlobalThemeProvider");
  }
  return value;
}

export function GlobalThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<GlobalThemePreset>(DEFAULT_GLOBAL_THEME);

  // Der eine Ort, an dem aus Werten Attribute werden.
  //
  // ⚠️ Die Attributnamen stehen NICHT hier, sondern kommen aus `THEME_KNOBS`.
  // Sonst stünde die Zuordnung „Stellschraube → Attribut" ein zweites Mal im
  // Baum, und eine umbenannte Stellschraube schaltete lautlos nichts mehr:
  // ein Attribut, für das keine Regel greift, sieht aus wie eine Seite ohne
  // Einstellung und nicht wie ein Fehler.
  //
  // ⚠️ `useLayoutEffect` AND NOT `useEffect` (#268). A passive effect runs after
  // the browser has painted; a stored theme that arrives with `load()` would
  // stand on the page for one frame in the old values, and a theme that
  // differs from the default would flash on every reload of an operator. The
  // layout effect runs after the DOM is changed and before the paint, so the
  // attributes are on `<html>` before the first frame that shows them
  // (`web/tests/global-theme-provider.test.tsx`).
  useLayoutEffect(() => {
    const root = document.documentElement;
    for (const name of Object.keys(theme) as (keyof GlobalThemePreset)[]) {
      root.setAttribute(THEME_KNOBS[name].attribute, theme[name]);
    }
  }, [theme]);

  const load = useCallback(() => {
    // Ein Fehlschlag bleibt still und lässt die Vorgabe stehen. Er ist hier
    // kein Befund für den Betreiber: entweder ist die Sitzung gerade
    // abgelaufen — dann sagt ihm der nächste Bildschirm das ohnehin —, oder
    // der Hub antwortet gar nicht, und dann steht die Meldung darüber schon
    // auf der Fläche, die ihre Daten nicht bekommen hat. Eine zweite Meldung
    // über die Farbeinstellung wäre Lärm vor der eigentlichen Nachricht.
    void fetchGlobalTheme()
      .then((loaded) => {
        setTheme(loaded);
      })
      .catch(() => {
        setTheme(DEFAULT_GLOBAL_THEME);
      });
  }, []);

  const reset = useCallback(() => {
    setTheme(DEFAULT_GLOBAL_THEME);
  }, []);

  const preview = useCallback((next: GlobalThemePreset) => {
    setTheme(next);
  }, []);

  const save = useCallback(
    async (next: GlobalThemePreset) => {
      const previous = theme;
      setTheme(next);
      try {
        // Übernommen wird, was der Server ZURÜCKGIBT, und nicht, was gesendet
        // wurde: er prüft die Stufen gegen `presets.ts`, und wenn er dabei
        // etwas zurechtrückt, soll auf dem Schirm sein Stand stehen und nicht
        // die Absicht des Browsers.
        const saved = await setGlobalTheme(next);
        setTheme(saved.theme);
      } catch (error) {
        // Zurückstellen, damit die Seite nicht ein Aussehen trägt, das
        // nirgends gespeichert ist — beim nächsten Laden wäre es sonst weg,
        // ohne dass jemand erführe, warum.
        setTheme(previous);
        throw error;
      }
    },
    [theme]
  );

  const value = useMemo<GlobalThemeContextValue>(
    () => ({ theme, preview, save, load, reset }),
    [theme, preview, save, load, reset]
  );

  return <GlobalThemeContext.Provider value={value}>{children}</GlobalThemeContext.Provider>;
}
