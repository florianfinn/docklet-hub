// Die Nachrichten je Sprache.
//
// Eine weitere Sprache ist eine Datei in diesem Ordner und ein Eintrag in
// dieser Tabelle — sonst nichts. Sie steht neben den Sprachdateien und nicht
// in `../index.ts`, damit der Anbieter sie holen kann, ohne über die
// Außenkante der Schicht zu gehen: `../index.ts` gibt seinerseits den Anbieter
// heraus, und der Kreis wäre da.
//
// ⚠️ Ein volles `Record` und ausdrücklich kein `Partial`. Der Unterschied ist
// nicht Genauigkeit, sondern die Stelle, an der eine vergessene Sprachdatei
// auffällt: bei `Partial` erst im Browser, als stiller Rückfall auf Deutsch —
// hier fällt sie beim Typcheck auf, und zwar an dem Tag, an dem jemand
// `LANGUAGES` erweitert.
//
// ⚠️ Eine neue Sprachdatei schließt ihr Objekt mit `satisfies typeof de` ab.
// Nur an einem Objektliteral prüft TypeScript auf überschüssige
// Eigenschaften; eine bloße Zuweisung ließe einen Schlüssel durch, den es in
// keiner anderen Sprache gibt (siehe `web/src/app/i18n/use-intl.d.ts`).

import type { Language } from "../languages";
import { de } from "./de";
import { en } from "./en";

// ⚠️ SINCE #258 THESE ARE NOT ALL TEXTS. A feature brings its own language
// files (`features/<name>/messages/`), and `platform/` may not import a
// feature; `web/src/app/i18n/messages.ts` puts both together, and only that
// whole is handed to `LanguageProvider`.
export const platformMessages: Record<Language, typeof de> = { de, en };
