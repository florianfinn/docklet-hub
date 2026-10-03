import { useTranslations } from "use-intl";

import { ContainerBrowser } from "./ContainerBrowser";
import type { ContainerSlots } from "./slots";

// Der Reiter „Hub & Agenten": die Container des Leitstands selbst, IMMER
// sichtbar und unabhängig von der Einstellung, die sie in Übersicht und
// Container-Fläche ausblendet.
//
// ⚠️ DERSELBE BAUSTEIN WIE DIE CONTAINER-FLÄCHE (`ContainerBrowser`) und keine
// eigene Liste: Suche, Filter, Marken und die Wege zu Logs, Shell und Dateien
// kommen damit mit, und ein Umbau dort erreicht diesen Reiter ohne Zutun.

export function SystemContainersPanel({ slots }: { slots?: ContainerSlots }) {
  const t = useTranslations();

  return (
    <div className="flex flex-col gap-5">
      <ContainerBrowser
        slots={slots}
        scope="system"
        heading={
          <>
            <h2 className="text-[15px] font-medium">{t("systemContainersTitle")}</h2>
            <p className="mt-1 max-w-prose text-[13px] text-muted-foreground">{t("systemContainersHint")}</p>
          </>
        }
      />
    </div>
  );
}
