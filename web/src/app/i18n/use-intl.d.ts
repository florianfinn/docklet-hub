// Since #258 this file lives in `app/` and not in `platform/i18n/`: the type of
// the messages is the type of ALL texts, the feature ones included, and only
// `app/` may import a feature. The reasoning below is unchanged.
//
// Der Vertrag zwischen den Sprachdateien und use-intl.
//
// Der Gedanke stammt aus dem bisherigen `index.ts` und ist derselbe geblieben:
// Der Typ der ersten Sprache ist der Vertrag für jede weitere. Nur der Ort hat
// gewechselt. Früher trug ihn ein eigener Name (`Texts`), den jede Aufrufstelle
// importieren musste; jetzt trägt ihn use-intl selbst, und der Typcheck greift
// dort, wo die Schlüssel benutzt werden.
//
// Gemessen am 2026-09-05 an drei absichtlich falschen Fällen, jeder einzeln
// gegen `npx tsc --noEmit` gehalten:
//   - `t("gibtsNicht")` → TS2345, der Schlüssel steht in keiner Sprachdatei.
//   - eine Übersetzung, der ein Schlüssel FEHLT → ein Typfehler an der Datei,
//     der die fehlenden Schlüssel beim Namen nennt.
//   - eine Übersetzung mit einem ÜBERZÄHLIGEN Schlüssel → TS2353.
//
// ⚠️ Beim FEHLENDEN Schlüssel steht hier absichtlich KEINE Nummer. Sie hängt
// nicht an der Sache, sondern an der ANZAHL: nachgemessen am 2026-09-05 gegen
// `npx tsc --noEmit` meldet TypeScript bei EINEM fehlenden Schlüssel TS2741,
// bei ZWEI BIS FÜNF TS2739 und AB SECHS TS2740. Zugesagt ist hier, dass es
// beim Typcheck auffällt — nicht, wie der Fehler heißt. Eine Nummer, die von
// der Anzahl abhängt, wäre nur die nächste Behauptung, die still veraltet.
//
// ⚠️ Die letzten beiden fallen nur, wenn die Übersetzungsdatei ihr Objekt mit
// `satisfies typeof de` abschließt. An einem Objektliteral prüft TypeScript
// auf überschüssige Eigenschaften, an einer bloßen Zuweisung nicht — eine
// Datei ohne `satisfies` dürfte also stillschweigend zu viel enthalten.
//
// ⚠️ `Locale` ist die eine Stelle, an der die Sprache nicht `language` heißt:
// so heißt die Eigenschaft bei use-intl, und ein eigener Name dafür wäre eine
// Übersetzungstabelle zwischen zwei Wörtern für dieselbe Sache. Überall sonst
// in diesem Repo steht `language`.

import type { Language } from "../../platform/i18n/languages";
import type { de } from "./messages";

declare module "use-intl" {
  interface AppConfig {
    Messages: typeof de;
    Locale: Language;
  }
}
