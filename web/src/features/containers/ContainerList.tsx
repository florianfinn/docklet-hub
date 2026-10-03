import { useTranslations } from "use-intl";

import type { OverviewContainer } from "contract";

import { ContainerRow } from "./ContainerRow";
import { ExternalManagementNote, groupByManager, splitByManagement } from "./external-management";
import type { ContainerSlots } from "./slots";

// Eine Liste von Containern, und darunter — falls es welche gibt — die Gruppe
// der fremdverwalteten.
//
// ⚠️ EINE Regel, überall dieselbe: in jeder Container-Liste rücken die
// fremdverwalteten Container in eine eigene Gruppe ans Ende. Damit gilt sie im
// Deepdive für die Container ohne Stack und für die eines Stacks genauso wie
// auf der Seite eines Stacks — es gibt keinen Ort, an dem ein fremdverwalteter
// Container unauffällig zwischen den eigenen steht.
//
// ⚠️ Sie sieht ABSICHTLICH nicht aus wie ein Stack: keine anklickbare Zeile,
// kein Zustandspunkt, keine Zahl „6/8". Ein Stack ist eine Einheit, die man
// betritt; diese Gruppe ist eine Auskunft über Herkunft. Was sie von der
// Überschrift „ohne Stack" unterscheidet, ist der Satz darunter — er nennt den
// Verwalter.

// ⚠️ `slots` reist hier nur DURCH. Die Liste weiß nichts über Marken und
// Auslastung und soll nichts darüber wissen — sie ordnet Container.
// Freiwillig: wer nichts reicht, sieht weder Marken noch Griff.
// ⚠️ `hostId` reist hier ebenfalls nur DURCH — aber als PFLICHT und nicht
// freiwillig wie `slots`. Der Unterschied ist gewollt: `slots` entscheidet,
// WAS eine Zeile zusätzlich zeichnet, `hostId` gehört zu einer Angabe, die
// jede Zeile braucht. Ein Container trägt keine Host-Kennung, und eine Zeile
// ohne sie könnte den Weg zu ihrer Detailseite nicht bauen (Begründung samt
// der Nachschau an allen fünf Aufrufstellen in `ContainerRow.tsx`).
export function ContainerList({
  containers,
  hostId,
  slots
}: {
  containers: OverviewContainer[];
  hostId: string;
  slots?: ContainerSlots;
}) {
  const t = useTranslations();
  const { own, external } = splitByManagement(containers);

  return (
    <>
      {own.map((container) => (
        <ContainerRow key={container.id} container={container} hostId={hostId} slots={slots} />
      ))}

      {groupByManager(external).map((group) => (
        <div key={group.manager}>
          <p className="px-2.5 pt-3 pb-1 text-[11px] tracking-wide text-subtle-foreground uppercase">
            {t("overviewExternallyManaged")}
          </p>
          <ExternalManagementNote manager={group.manager} />
          {/* ⚠️ Auch die FREMDVERWALTETEN bekommen dieselben Plätze. Eine
              eigene Marke ordnet — sie greift nicht ein —, und wer einen
              Container von Portainer im Blick behalten will, ordnet ihn
              genauso. Die Gruppe unterscheidet sich in der Herkunft und nicht
              darin, was der Betreiber über sie notieren darf. */}
          {group.containers.map((container) => (
            <ContainerRow key={container.id} container={container} hostId={hostId} slots={slots} />
          ))}
        </div>
      ))}
    </>
  );
}
