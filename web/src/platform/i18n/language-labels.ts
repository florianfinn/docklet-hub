// Der Name jeder Sprache, als Schlüssel in die Sprachdatei.
//
// Warum eine eigene Datei: die Zuordnung wird an ZWEI Stellen gebraucht. Sie
// stand bisher in `web/src/app/shell/AppSidebar.tsx` und gehörte dem Namensschild
// der Seitenleiste; der Sprachumschalter in der Fußzeile der Anmeldebildschirme
// braucht dieselbe Zuordnung, und dort steht keine Seitenleiste. Eine zweite
// Abschrift wären zwei Wahrheiten: eine dritte Sprache käme an einem Ort an
// und am anderen nicht — und nichts daran wäre rot. Deshalb liegt sie hier,
// bei den Sprachen, und nicht bei einem der beiden Bildschirme.
//
// ⚠️ Diese Datei importiert aus `./languages` und ausdrücklich NICHT aus
// `./index`. Derselbe Grund wie bei `messages/index.ts`: `./index` gibt seinerseits
// den Anbieter heraus, und wer von dort holt, schließt den Kreis über
// `LanguageProvider`. Der kurze Weg zur Quelle ist auch der Weg ohne Zyklus.

import type { useTranslations } from "use-intl";

import type { Language } from "./languages";

// Der Schlüsseltyp kommt aus dem Rückgabetyp des Hooks — derselbe Weg wie
// `TranslationKey` in `web/src/app/shell/navigation.ts`, und nicht dessen Import.
// Ein `import` von dort hieße, die Sprachschicht hinge an der Schale; die
// Anmeldebildschirme zögen die Navigation der angemeldeten Ansicht mit, nur um
// an einen Typ zu kommen. Die Richtung geht andersherum: die Schale kennt die
// Sprachen, die Sprachen kennen die Schale nicht.
type TranslationKey = Parameters<ReturnType<typeof useTranslations>>[0];

// ⚠️ `Record<Language, …>` und nicht `Partial<…>`: der Typ ist TOTAL. Wer
// `LANGUAGES` in web/src/platform/i18n/languages.ts um einen Code erweitert und diese
// Zuordnung vergisst, bekommt hier einen Typfehler, der den fehlenden Eintrag
// beim Namen nennt (`TS2741: Property 'fr' is missing`). Gemessen am
// 2026-09-05 mit `LANGUAGES = ["de", "en", "fr"]` meldet `tsc --noEmit` GENAU
// ZWEI Stellen: diese hier und `web/src/platform/i18n/messages/index.ts`, das
// `messages` aus demselben Grund als volles `Record` führt. Zwei Stellen, ein
// Mechanismus — wer eine Sprache hinzufügt, bekommt beide auf einmal gesagt.
//
// Eine dritte Sprache ist damit eine Datei unter `messages/`, ein Eintrag in
// `LANGUAGES`, eine Zeile in der Tabelle dort und eine Zeile hier. Die Listen
// in den Umschaltern wachsen von selbst mit, weil sie über `LANGUAGES` laufen
// und nicht über geschriebene Zeilen je Sprache.
export const LANGUAGE_LABEL_KEYS: Record<Language, TranslationKey> = {
  de: "languageGerman",
  en: "languageEnglish"
};
