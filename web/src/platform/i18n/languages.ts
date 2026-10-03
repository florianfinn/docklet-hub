// Welche Sprachen es gibt, und welche gilt, solange niemand angemeldet ist.
//
// Diese Datei kennt weder React noch use-intl. Das ist Absicht: die Liste der
// Sprachen wird auch dort gebraucht, wo kein Anbieter steht — im API-Klienten
// etwa, der `language` als Feld führt. Ein Import von hier zieht nichts nach.
//
// ⚠️ Der Begriff heißt in diesem Repo durchgängig `language` — im Typ, im
// API-Feld, im Text für den Betreiber. `locale` steht an genau einer Stelle:
// dort, wo use-intl seine eigene Eigenschaft so nennt (siehe
// `web/src/app/i18n/use-intl.d.ts` und `LanguageProvider.tsx`). Zwei Namen für dieselbe Sache
// sind der Anfang von zwei Sachen.

// Die Reihenfolge ist die Reihenfolge im Umschalter: Deutsch zuerst, weil es
// die erste Sprache ist und der Betreiber sie spricht.
export const LANGUAGES = ["de", "en"] as const;

export type Language = (typeof LANGUAGES)[number];

// Die Sprache, auf die alles zurückfällt, was keine andere Auskunft hat.
export const DEFAULT_LANGUAGE: Language = "de";

export function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}

// Die Sprache des Browsers, soweit wir sie sprechen.
//
// Gelesen wird `navigator.languages` und nicht `navigator.language`: die Liste
// trägt die Reihenfolge, in der jemand seine Sprachen bevorzugt, und genau
// diese Reihenfolge ist die Antwort auf die Frage. Wer `de-AT, en, fr` gesetzt
// hat, bekommt Deutsch — nicht Englisch, weil `en` in unserer Liste weiter
// vorne steht.
//
// Verglichen wird nur der Sprachanteil (`de-AT` → `de`). Regionen unterscheidet
// diese Oberfläche nicht; täte sie es, wäre `de-AT` eine eigene Datei unter
// `messages/`, und die gibt es nicht.
export function browserLanguage(): Language {
  // `navigator.languages` ist optional in der Typbeschreibung von älteren
  // Umgebungen und fehlt in Testläufen ohne DOM — ohne den Rückfall wäre die
  // erste Zeile der Oberfläche ein TypeError.
  const preferred = globalThis.navigator?.languages ?? [];
  for (const tag of preferred) {
    const base = tag.split("-")[0].toLowerCase();
    if (isLanguage(base)) return base;
  }
  return DEFAULT_LANGUAGE;
}
