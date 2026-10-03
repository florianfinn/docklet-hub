import { useTranslations } from "use-intl";

import { isLanguage, LANGUAGES, type Language } from "../../platform/i18n";
import { LANGUAGE_LABEL_KEYS } from "../../platform/i18n/language-labels";
import { Card } from "../../platform/ui/shadcn/card";
import { Label } from "../../platform/ui/shadcn/label";
import { RadioGroup, RadioGroupItem } from "../../platform/ui/shadcn/radio-group";

// Die Tafel „Sprache". Sie stand bis zu den Reitern als Rumpf in
// `SettingsView.tsx`; die Begründungen zur Wanderung aus dem Menü des
// Namensschilds und zum durchgereichten Umschalter stehen weiter dort.
//
// ⚠️ SIE HÄLT KEINEN EIGENEN ZUSTAND, sondern zeigt `language` an und meldet
// die Wahl nach oben. Der Umschalter kommt als Eigenschaft herein und NICHT
// aus `useLanguage()` — `web/tests/auth-screens.test.mjs` (Prüfung 3) macht
// den schreibenden Aufruf in jeder `.tsx` unter `web/src/app/screens/` und im Feature
// `account` rot.

type LanguagePanelProps = {
  language: Language;
  onLanguageChange: (language: Language) => void;
};

export function LanguagePanel({ language, onLanguageChange }: LanguagePanelProps) {
  const t = useTranslations();

  return (
    <Card className="gap-0 overflow-hidden border-accent-line bg-body-face py-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-head-face px-4 py-2.5">
        <span className="text-sm font-medium">{t("languageLabel")}</span>
        {/* Die Nebenangabe des Artboards sagt, für WEN eine Einstellung
            gilt („gilt für alle Benutzer", Z. 767). Für die Sprache ist die
            Antwort eine andere und steht in
            docs/design/language-layer.md: sie hängt am KONTO. */}
        <span className="ml-auto text-xs text-muted-foreground">{t("settingsLanguageScope")}</span>
      </div>

      <div className="px-4 py-4">
        {/* ⚠️ `onValueChange` liefert einen `string` — Radix kennt unseren
            Typ nicht. Verengt wird mit `isLanguage` und NICHT mit
            `as Language`: eine Zusicherung wäre eine Behauptung über eine
            Eingabe, die nicht aus diesem Modul kommt. Ist der Wert keine
            Sprache, geschieht nichts.

            Die Einträge kommen aus `LANGUAGES` und nicht aus zwei
            geschriebenen Zeilen: die Reihenfolge dort ist die Reihenfolge
            hier (Deutsch zuerst), und eine dritte Sprache erscheint, ohne
            dass diese Datei es erfährt. */}
        <RadioGroup
          aria-label={t("languageLabel")}
          value={language}
          onValueChange={(value) => {
            if (isLanguage(value)) onLanguageChange(value);
          }}
        >
          {LANGUAGES.map((code) => (
            <div key={code} className="flex items-center gap-2.5">
              {/* Die Beschriftung gehört über `htmlFor` an den Knopf: ohne
                  sie träfe ein Klick auf das Wort daneben ins Leere, und
                  ein Screenreader nennte einen Knopf ohne Namen. */}
              <RadioGroupItem value={code} id={`language-${code}`} />
              <Label htmlFor={`language-${code}`} className="text-[13px] font-normal">
                {t(LANGUAGE_LABEL_KEYS[code])}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </div>
    </Card>
  );
}
