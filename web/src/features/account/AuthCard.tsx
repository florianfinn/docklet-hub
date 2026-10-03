import type { FormEvent, ReactNode } from "react";
import { useTranslations } from "use-intl";

import { LANGUAGES, useLanguage } from "../../platform/i18n";
import { LANGUAGE_LABEL_KEYS } from "../../platform/i18n/language-labels";
import { cn } from "../../platform/ui/lib/cn";
import { initials } from "../../platform/ui/lib/initials";
import { Card, CardContent } from "../../platform/ui/shadcn/card";

// Der Rahmen beider Formularbildschirme — Anmeldung und Erstanmeldung.
//
// Er löst `FormShell` aus `web/src/screens/form.tsx` ab, das mit rohem Markup
// gebaut war und laut eigenem Kopfkommentar ersetzt und nicht vergrößert
// werden sollte. Was hier steht, sind die Bausteine aus D2 und die Token aus
// D1; Maße und Aufbau kommen aus den Artboards (`Main.dc.html`,
// `Anmeldung.dc.html`, `AnmeldungFehler.dc.html`).
//
// ⚠️ DIE LANDMARKE `main` STEHT HIER. `PlainShell` (web/src/app/shell/AppShell.tsx)
// setzt bewusst keine — wer darin steht, bringt sie selbst mit. Bisher tat das
// `FormShell`; ohne dieses `main` hätte das Dokument in genau den zwei
// Zuständen „Anmeldung" und „Erstanmeldung" gar keine Hauptlandmarke, und ein
// Screenreader fände keinen Einstieg in den Inhalt. Genau eins: die beiden
// Bildschirme im Inneren setzen keins.

type AuthCardProps = {
  title: string;
  lead?: string;
  error: string | null;
  onSubmit: () => void;
  // The ground behind the card. `App.tsx` hands it in (#269): this file is part
  // of the feature `account`, whose door must not pull a stylesheet that the
  // test run cannot read into every test that only wants its texts.
  background?: ReactNode;
  children: ReactNode;
};

// Die Beschriftung eines Feldes: Schreibmaschinenschrift, Versalien, 10,5 px,
// weiter Buchstabenabstand — die `.lbl`-Klasse der Artboards.
//
// Warum als exportierte Konstante und nicht als eigenes `Field`-Bauteil: eine
// Hülle um `Label` plus `Input` wäre genau die Sorte Zwischenschicht, die
// `form.tsx` groß gemacht hat. Die beiden Bildschirme setzen `Label` und
// `Input` selbst, verbinden sie über `htmlFor`/`id` — und teilen sich von hier
// nur die Typografie, damit sie an zwei Stellen nicht auseinanderläuft.
export const authFieldLabelClassName =
  "font-mono text-[10.5px] tracking-[0.13em] text-subtle-foreground uppercase";

export function AuthCard({ title, lead, error, onSubmit, background, children }: AuthCardProps) {
  const t = useTranslations();
  // ⚠️ `adopt` UND NICHT `change`. Das ist die eigentliche Zusage dieses
  // Bildschirms: der Umschalter hier SPEICHERT NICHT. Die schreibende Variante
  // aus `useLanguage()` setzt über `PUT /session/language` die Sprache des
  // Kontos und damit eine Sitzung voraus — vor der Anmeldung gibt es keine,
  // der Aufruf endete in 401, während die Oberfläche fröhlich umspränge und
  // niemand den Fehler sähe. `adopt` stellt die laufende Ansicht um und
  // schreibt nichts; beim nächsten Laden gilt wieder die Sprache des Browsers.
  // Das ist kein Notbehelf, sondern der Grund, warum es den Umschalter hier
  // überhaupt geben darf: ein zweiter gespeicherter Ort wirft die Frage auf,
  // welcher gewinnt.
  const { language, adopt } = useLanguage();

  return (
    // ⚠️ `relative`: der Grund (`DotWave`, from `background`) rendert eine `<canvas>` mit
    // `position: absolute; inset: 0` und bringt KEINE eigene Hülle mit. Ohne
    // einen positionierten Kasten hier legte er sich an das nächste
    // positionierte Element weiter oben — oder an das Ansichtsfenster — und
    // läge nicht unter diesem Bildschirm. Der Inhalt darüber trägt `z-10`.
    <main className="relative flex min-h-svh w-full items-center justify-center overflow-hidden p-6">
      {background}

      <div className="relative z-10 flex w-full max-w-[380px] flex-col gap-[18px]">
        {/* Markenblock: 25-px-Quadrat mit Kürzel, daneben der Name. Die Fläche
            ist `--foreground` auf `--background`, also die Umkehrung des
            Grundes — dasselbe wie in der Seitenleiste der angemeldeten
            Ansicht. */}
        <div className="flex items-center gap-[10px]">
          <span
            aria-hidden="true"
            className="flex size-[25px] shrink-0 items-center justify-center rounded-lg bg-foreground text-[12px] font-semibold text-background"
          >
            {initials(t("appTitle"))}
          </span>
          <span className="truncate text-[15px] font-semibold tracking-tight">{t("appTitle")}</span>
        </div>

        {/* Die Karte: 13 px Radius, kein Innenabstand am Baustein selbst — den
            trägt `CardContent`, damit die Fußzeile unten bündig anliegt. */}
        <Card className="gap-0 overflow-hidden rounded-[13px] py-0">
          <CardContent className="px-7 pt-7 pb-[26px]">
            <h1 className="text-[20px] font-medium tracking-[-0.022em]">{title}</h1>
            {lead ? (
              <p className="mt-[10px] text-[13px] leading-[1.65] text-pretty text-muted-foreground">{lead}</p>
            ) : null}

            <form
              className={cn("flex flex-col gap-4", lead ? "mt-6" : "mt-[22px]")}
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                onSubmit();
              }}
            >
              {/* Die Fehlermeldung steht ÜBER den Feldern und nicht mehr unter
                  der Schaltfläche (Artboard `AnmeldungFehler.dc.html`): wer
                  abgewiesen wird, sieht zuerst, warum, und danach das Feld, das
                  er ändern soll.

                  `role="alert"` ist der Grund, warum das kein einfacher Absatz
                  ist: der Text erscheint erst nach dem Absenden, und ohne diese
                  Rolle liest ein Screenreader ihn gar nicht vor — der Fokus
                  steht auf der Schaltfläche, die Meldung darüber bliebe stumm. */}
              {error ? (
                <p
                  role="alert"
                  className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-[9px] text-[13px] text-destructive"
                >
                  {error}
                </p>
              ) : null}
              {children}
            </form>
          </CardContent>

          {/* Die Fußzeile: abgesetzte Fläche, Schreibmaschinenschrift, 10,5 px. */}
          <div className="flex items-center justify-between border-t border-border bg-muted px-7 py-[9px] font-mono text-[10.5px] tracking-[0.06em] text-subtle-foreground">
            {/* Links die Fassung. Sie kommt beim Bauen aus der `package.json`
                der Repo-Wurzel (`define` in `web/vite.config.ts`).

                ⚠️ Ist sie leer, steht hier NICHTS — kein Platzhalter, keine
                erfundene Nummer. Der leere Kasten bleibt trotzdem stehen, damit
                der Sprachumschalter nicht nach links rutscht. */}
            <span>{__HUB_VERSION__}</span>

            {/* Rechts der Sprachumschalter. Die Liste kommt aus `LANGUAGES` und
                nicht aus zwei geschriebenen Zeilen: eine dritte Sprache
                erscheint dann von selbst. Sichtbar ist das Kürzel aus derselben
                Liste — kein Text und damit kein Fall für die Sprachdateien; den
                Namen der Sprache trägt das `aria-label`. */}
            <div role="group" aria-label={t("languageLabel")} className="flex gap-1">
              {LANGUAGES.map((code) => (
                <button
                  key={code}
                  type="button"
                  aria-label={t(LANGUAGE_LABEL_KEYS[code])}
                  aria-pressed={code === language}
                  // ⚠️ Die Fokusgestaltung ist NICHT geerbt: `Button`
                  // (`web/src/platform/ui/shadcn/button.tsx`) bringt sie mit, ein rohes
                  // `<button>` nicht. Ohne die drei Klassen hier zeichnete der
                  // Browser seinen eigenen Umriss — gemessen am 2026-09-05 im
                  // gebauten Bildschirm: `outline: solid 2px` in der
                  // Textfarbe, also ein harter heller Rahmen auf dunklem
                  // Grund, während Feld und Schaltfläche daneben den weichen
                  // Ring aus `--ring` tragen. Zwei Fokusbilder in einer Karte.
                  className={cn(
                    "rounded-[5px] px-[7px] py-[3px] transition-colors",
                    "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    code === language
                      ? "bg-secondary text-foreground"
                      : "text-subtle-foreground hover:text-foreground"
                  )}
                  onClick={() => adopt(code)}
                >
                  {code}
                </button>
              ))}
            </div>
          </div>
        </Card>
      </div>
    </main>
  );
}
