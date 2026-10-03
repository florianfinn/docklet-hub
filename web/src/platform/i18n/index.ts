// Was die Sprachschicht nach außen gibt.
//
// ⚠️ `useTranslations` steht hier NICHT. Die Aufrufstellen importieren den Hook
// direkt aus `use-intl`. Ein Weiterreichen unter eigenem Namen wäre ein zweiter
// Name für dieselbe Sache: die Typen kämen weiter aus der Bibliothek, ihre
// Dokumentation spräche über einen Namen, den es hier nicht gibt, und beim
// nächsten Fassungssprung stünde die Hülle zwischen Ursache und Fehlermeldung.
// Was die Bibliothek kann, kommt aus der Bibliothek; was dieses Repo
// entscheidet — welche Sprachen es gibt, welche gilt, wer sie ändert — kommt
// von hier.
//
// Der bisherige Vertrag `export type Texts = typeof de` ist nicht entfallen,
// sondern umgezogen: er steht als Modul-Erweiterung in `web/src/app/i18n/use-intl.d.ts` und
// wirkt dort auf jeden `t(…)`-Aufruf, statt auf eine Zuweisung.

export { LANGUAGES, DEFAULT_LANGUAGE, browserLanguage, isLanguage } from "./languages";
export type { Language } from "./languages";
export { platformMessages } from "./messages";
export { byteSize } from "./byte-size";
export { LanguageProvider, useLanguage } from "./LanguageProvider";
export type { LanguageContextValue } from "./LanguageProvider";
