import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { IntlProvider, useTranslations, type Messages } from "use-intl";

import { setLanguage } from "./api";
import { browserLanguage, type Language } from "./languages";

// Der Anbieter der Sprachschicht.
//
// Welche Sprache gilt, hat drei Antworten und nicht eine:
//
//   niemand angemeldet   die des Browsers, soweit wir sie sprechen, sonst `de`
//   angemeldet           die des Kontos
//   Umschalter betätigt  die gewählte, und sie wird geschrieben
//
// ⚠️ `locale` heißt die Sprache an genau einer Stelle: an der Eigenschaft von
// `IntlProvider`, weil use-intl sie so nennt. Überall sonst — im Typ, im
// API-Feld, im Text für den Betreiber — heißt sie `language`. Zwei Namen für
// dieselbe Sache sind der Anfang von zwei Sachen.

export type LanguageContextValue = {
  language: Language;
  // Übernimmt die Sprache des Kontos. Schreibt NICHT zurück — sonst schriebe
  // jede Anmeldung die Einstellung, die sie gerade gelesen hat.
  adopt: (language: Language) => void;
  // Der Umschalter: setzt und speichert.
  change: (language: Language) => void;
};

// ⚠️ Zwei Funktionen und nicht eine mit einem Schalter `persist`. Es sind zwei
// Vorgänge: der eine liest, was der Server ohnehin weiß, der andere schreibt,
// was der Mensch gerade will. Ein Schalter wäre dieselbe Verwechslung in
// kürzerer Schreibweise — und ein vergessenes `persist: false` an der
// Anmeldung fiele niemandem auf, weil das Ergebnis auf dem Bildschirm gleich
// aussieht.

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function useLanguage(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (!value) {
    throw new Error("useLanguage steht außerhalb von LanguageProvider");
  }
  return value;
}

/**
 * ⚠️ `messages` COMES FROM OUTSIDE since #258: the texts of a feature live in
 * the feature, and `platform/` may not import one. `app/i18n/` puts all texts
 * together and passes them in (`AppLanguageProvider`); `Messages` is the type
 * use-intl derives from `app/i18n/use-intl.d.ts`, so a missing language or
 * key still fails the type check.
 */
export function LanguageProvider({
  messages,
  children
}: {
  messages: Record<Language, Messages>;
  children: ReactNode;
}) {
  const [language, setLanguageState] = useState<Language>(browserLanguage);

  return (
    // Kein Rückgriff auf eine Ersatzsprache: `messages` ist ein volles
    // `Record` über `LANGUAGES` (siehe `web/src/app/i18n/messages.ts`), eine Sprache ohne
    // eigene Datei gibt es also gar nicht. Ein `?? de` hier wäre kein Netz,
    // sondern eine Tarnung — es machte aus einer fehlenden Übersetzung eine
    // Oberfläche, die auf Deutsch umspringt, ohne dass es jemand meldet.
    <IntlProvider locale={language} messages={messages[language]}>
      <LanguageBridge language={language} setLanguage={setLanguageState}>
        {children}
      </LanguageBridge>
    </IntlProvider>
  );
}

// Warum eine zweite Komponente für so wenig:
//
// `document.title` kommt aus der Nachricht `appTitle`, und dafür braucht es
// `useTranslations`. Ein Hook findet seinen Anbieter nur, wenn er UNTERHALB
// von ihm steht — in `LanguageProvider` selbst stünde er neben `IntlProvider`
// und nicht darunter, und `t` liefe ins Leere. Dieselbe Lage hat `change`: die
// Fehlermeldung beim Speichern ist eine Nachricht wie jede andere.
//
// Der Preis ist eine Komponente, die nichts eigenes rendert. Die Alternative
// wäre, den Text für den Titel und die Fehlermeldung an dieser einen Stelle
// fest zu verdrahten — und damit die Regel zu brechen, um deren Umsetzung es
// hier gerade geht.
function LanguageBridge({
  language,
  setLanguage: setLanguageState,
  children
}: {
  language: Language;
  setLanguage: (language: Language) => void;
  children: ReactNode;
}) {
  const t = useTranslations();

  const adopt = useCallback(
    (next: Language) => {
      setLanguageState(next);
    },
    [setLanguageState]
  );

  const change = useCallback(
    (next: Language) => {
      const previous = language;
      // Zuerst umstellen, dann speichern: die Oberfläche antwortet auf den
      // Klick und nicht auf die Antwort des Servers.
      setLanguageState(next);
      void setLanguage(next).catch(() => {
        // Zurückstellen, damit der Bildschirm nicht eine Sprache zeigt, die im
        // Konto nicht steht — beim nächsten Laden wäre sie sonst wieder weg,
        // ohne dass jemand erführe, warum.
        setLanguageState(previous);
        // Der Fehler wird gezeigt und nicht verschluckt. Ein stiller
        // Rücksprung sähe aus wie ein klemmender Schalter.
        toast.error(t("languageSaveFailed"));
      });
    },
    [language, setLanguageState, t]
  );

  // Das `lang`-Attribut des Dokuments. Es hängt an der Sprache und nicht an
  // der Datei: `web/index.html` trägt `lang="de"` als Stand VOR dem ersten
  // Rendern. Screenreader wählen daran ihre Aussprache, und der Browser sein
  // Trennmuster — beides liefe auf Deutsch weiter, wenn hier nichts stünde.
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  // Der Seitentitel. Er stand bisher fest in `web/index.html` und war damit
  // die eine Ausnahme, die `web/tests/ui-texts.test.mjs` in seinem
  // Kopfkommentar ausdrücklich nennt. Ab hier kommt er aus der Sprachdatei
  // wie jeder andere sichtbare Text.
  //
  // ⚠️ Der Effekt hängt an `t` und nicht an `language`: `t` wechselt seine
  // Kennung, sobald der Anbieter eine andere Sprache trägt, und nur so ist die
  // Abhängigkeit die, die der Effekt wirklich hat.
  useEffect(() => {
    document.title = t("appTitle");
  }, [t]);

  const value = useMemo<LanguageContextValue>(
    () => ({ language, adopt, change }),
    [language, adopt, change]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}
