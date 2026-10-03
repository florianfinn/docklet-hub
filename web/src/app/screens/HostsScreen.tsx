import { HostsView, type HostRole } from "../../features/hosts";
import { ContainerLoad } from "../../features/metrics";

// Die Host-Verwaltung als eigene Fläche (D5, #62). Die Ansicht selbst liegt
// seit #267 im Feature `hosts` (`features/hosts/HostsView.tsx`); diese Fläche
// ist der Rahmen, der sie in die Navigation stellt.
//
// ⚠️ DIE LAST STECKT HIER IN DIE KARTE. `ContainerLoad` gehört zur Auslastung
// (Feature `metrics`, #283), und ein Feature importiert kein anderes. Die
// Karte kennt deshalb nur den Platz (`renderLoad`), und die Fläche, die beide
// kennen darf, setzt die Ansicht ein.
export function HostsScreen({ role }: { role: HostRole }) {
  return (
    <HostsView
      role={role}
      renderLoad={(hostId, load) => <ContainerLoad hostId={hostId} load={load} />}
    />
  );
}
