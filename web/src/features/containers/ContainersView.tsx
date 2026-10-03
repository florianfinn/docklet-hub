import { useTranslations } from "use-intl";

import { HOST_SCREEN_CLASS } from "../../domain/hosts";
import { ContainerBrowser } from "./ContainerBrowser";
import { useShowSystemContainers } from "./overview-queries";
import type { ContainerSlots } from "./slots";

// Die Fläche „Container" — der Deepdive der Übersicht (D6b, #62). Sie stand bis
// #282 als Rumpf in `app/screens/ContainersScreen.tsx`; dort steht weiter, warum
// sie so aussieht, wie sie aussieht. Der Bildschirm ist der Rahmen, der sie in
// die Navigation stellt und die Plätze für Marken und Auslastung einsetzt.
//
// ⚠️ SEIT DEM REITER „HUB & AGENTEN" steht der Rumpf dieser Fläche in
// `ContainerBrowser.tsx`: derselbe Baustein zeichnet dort die Container des
// Leitstands selbst. Diese Fläche zeigt sie nur, wenn die Einstellung es sagt
// (`GET /api/settings` → `containers.showSystem`).

export function ContainersView({ slots }: { slots?: ContainerSlots }) {
  const t = useTranslations();
  const showSystem = useShowSystemContainers();

  return (
    <div className={HOST_SCREEN_CLASS}>
      <ContainerBrowser
        scope={showSystem === null ? null : showSystem ? "all" : "workload"}
        // Der Kopf des Artboards (Z. 568): „34 Container · 31 laufen". Der
        // dritte Teil („3 Updates") fehlt — siehe `app/screens/ContainersScreen.tsx`.
        heading={<h1 className="text-[20px] font-medium tracking-[-0.022em]">{t("containersTitle")}</h1>}
        slots={slots}
      />
    </div>
  );
}
