import { useTranslations } from "use-intl";

import { AREA_TONES } from "contract";
import { Badge } from "../../platform/ui/shadcn/badge";
import { Card } from "../../platform/ui/shadcn/card";
import { AREA_LABELS, AREA_SCOPE_LABELS, AREA_TONE_LABELS } from "../../platform/i18n/theme-labels";

// Die Tafel „Farbe der Bereiche" (D7a, #62; Artboard hub-palette.html
// Z. 781–798, nachgemessen).
//
// ⚠️ NUR ANZEIGE, UND ZWAR ABSICHTLICH. D0 §4 zählt auf, was der Editor NICHT
// anbietet: „die drei Zustandsfarben, Anordnung und Reihenfolge der Bereiche,
// das Icon-Set". Die zwei Bereichstöne gehören dazu, und `presets.ts` sagt
// warum: sie sind Ortsangabe („ich bin im Betrieb", „ich bin in den
// Einstellungen") und nicht Geschmack. Der Grund steht in D0 §1, letzter
// Absatz: die Schale rechnet mit `calc(--c × 0.32)`, und zwei Farbtöne sind
// ihr fest reserviert, DAMIT SIE NIE AN EINEN HOST FALLEN. Wären sie wählbar,
// könnte die Seitenleiste denselben Ton tragen wie eine Karte daneben — und
// dann stünden zwei Bedeutungen in derselben Farbe.
//
// ⚠️ WARUM DIE TAFEL TROTZDEM DA IST. Ein Vorrat, aus dem zwei Töne fehlen,
// wirft die Frage auf, wo sie geblieben sind. Diese Tafel beantwortet sie an
// der Stelle, an der sie entsteht — und zeigt zugleich, was die zwei Töne
// tragen. Sie trägt deshalb keinen ausgegrauten Umschalter: ein Bedienelement,
// das nichts tut, ist eine Ankündigung und keine Auskunft.
//
// ⚠️ Sie kennt die Rolle nicht und braucht sie nicht. Hier ist für niemanden
// etwas zu ändern, auch nicht für einen Administrator — der Hinweis auf die
// Adminrolle wäre an dieser Stelle schlicht falsch.

export function AreaColorPanel() {
  const t = useTranslations();

  return (
    <Card className="gap-0 overflow-hidden border-accent-line bg-body-face py-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-head-face px-4 py-2.5">
        <span className="text-sm font-medium">{t("settingsAreaColorTitle")}</span>
        {/* Die Zahl kommt aus `AREA_TONES` und ist nicht geschrieben: kämen
            eines Tages drei Bereiche, stünde hier drei. */}
        <span className="ml-auto text-xs text-muted-foreground">
          {t("settingsAreaColorReserved", { count: AREA_TONES.length })}
        </span>
      </div>

      <div className="flex flex-col gap-3 px-4 py-4">
        <p className="text-[13px] text-subtle-foreground">{t("settingsAreaColorHint")}</p>

        {AREA_TONES.map((area) => (
          // ⚠️ `data-area` steht an der ZEILE. Die Ableitungsregel in
          // `palette.css` löst dort auf, wo das Attribut steht; ohne es am
          // Element selbst trüge der Tupfer den Ton seines Vorfahren — und die
          // Tafel zeigte zweimal dieselbe Farbe, ohne dass irgendetwas rot
          // würde.
          <div
            key={area.name}
            data-area={area.name}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-accent-line bg-head-face px-3 py-2"
          >
            <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-primary" />
            <span className="text-[14px] font-medium">{t(AREA_LABELS[area.name])}</span>
            <Badge variant="secondary" className="font-normal">
              {t(AREA_TONE_LABELS[area.name])}
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{area.hue}</span>
            </Badge>
            <span className="ml-auto text-[13px] text-muted-foreground">
              {t(AREA_SCOPE_LABELS[area.name])}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
