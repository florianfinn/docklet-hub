import { useMemo, useState } from "react";
import { Link } from "react-router";

import type { OverviewContainer } from "contract";

import { containerPath } from "../../platform/routes/container-path";
import { ContainerStateDot } from "./container-state";
import type { ContainerRowNotice, ContainerSlots } from "./slots";

// Die Zeile EINES Containers — dieselbe auf allen drei Flächen: in der
// Übersicht unter dem aufgeklappten Stack, im Deepdive unter jedem Stack und
// auf der Seite eines Stacks.
//
// ⚠️ Sie stand bis D6b in StackRow.tsx und ist mit D6b hierher gezogen, ohne
// dass sich an ihr etwas geändert hätte. Der Grund ist der Bestand: sie hat
// jetzt drei Aufrufstellen, und eine Zeile, die drei Flächen tragen, gehört
// keiner davon. Wäre sie geblieben, importierte die Stack-Seite ihre Zeilen
// aus der Zeile eines Stacks.

// ⚠️ WIE DER DEEPDIVE SICH VON DER ÜBERSICHT UNTERSCHEIDET, OHNE DASS ES DIE
// ZEILE ZWEIMAL GIBT: `slots.containerMarks` ist FREIWILLIG und kommt aus
// `app/` (#282), nicht aus dieser Zeile. Der Deepdive reicht einen Platz mit
// Griff durch, die Übersicht und die Stack-Seite einen ohne — und ohne die
// Angabe zeichnet die Zeile keine Marken. Kein `variant`-Schalter, kein
// `mode`, keine zweite Komponente: der Unterschied IST die Angabe, und wer sie
// nicht hat, kann den Griff auch nicht versehentlich zeigen.
//
// Warum nur der Deepdive: er ist die Fläche, die jeden Container einzeln führt
// (docs/design/hub-color-and-structure.md §5). In der Übersicht steht die
// Container-Zeile unter einem AUFGEKLAPPTEN Stack und ist dort die Auskunft
// „was steckt drin"; ein zweiter Weg zum selben Ziel wären zwei Stellen, die
// auseinanderlaufen.

// ⚠️ SEIT H3 (#5) FÜHRT DER NAME AUF DIE DETAILSEITE — UND NUR DER NAME.
// Verlinkt wird das eine Wort und nicht die Zeile, und das ist kein
// Formfehler, den ein Wächter fängt, sondern ein Bedienfehler, den er fängt:
// in einer verlinkten Zeile öffnete ein Klick auf den Griff der Marken die
// Detailseite statt das Menü. `web/tests/marks-assign.test.tsx` zählt jedes
// `a[href]`/`button`, das in einem anderen steckt — die Zeile bleibt deshalb
// ein schlichtes `div`, der Verweis und der Griff stehen als Geschwister
// darin.
//
// ⚠️ DER VERWEIS TRÄGT DEN VOLLSTÄNDIGEN NAMEN UND NICHT DEN DIENSTNAMEN. Zu
// sehen ist im Stack weiterhin der Dienst (siehe `label` unten); die Adresse
// braucht den Namen, unter dem der Container auf dem Arm läuft — nur der ist
// je Arm eindeutig, „web" gibt es in jedem zweiten Projekt.
//
// ⚠️ `hostId` IST PFLICHT UND NICHT FREIWILLIG. Die Zeile kennt ihren Arm
// nicht von selbst — sie bekommt nur den Container, und der trägt keine
// Host-Kennung. Nachgesehen an allen fünf Aufrufstellen von `ContainerList`:
// `overview/StackRow.tsx` und `containers/StackSection.tsx` tragen `hostId`
// bereits als eigene Angabe, `overview/HostGroup.tsx` und
// `containers/HostContainers.tsx` haben `entry.host.id`, und `StackScreen.tsx`
// hat den gefundenen Host. Es fehlt an keiner — eine freiwillige Angabe wäre
// deshalb eine Einladung, sie irgendwo zu vergessen, und dort stünde dann eine
// Zeile ohne Weg zu ihrem Container.
export function ContainerRow({
  container,
  hostId,
  slots
}: {
  container: OverviewContainer;
  hostId: string;
  slots?: ContainerSlots;
}) {
  // The one line a slot may put under the row (`ContainerRowNotice`).
  const [notice, setNotice] = useState<string | null>(null);
  const rowNotice = useMemo<ContainerRowNotice>(() => ({ notify: setNotice }), []);
  // ⚠️ Im Stack steht der DIENSTNAME und nicht der Container-Name. Compose
  // setzt den Container aus Projekt, Dienst und Nummer zusammen
  // („monitoring-grafana-1"); unter der Zeile „monitoring" eingerückt wiederholt
  // das zweimal, was schon dasteht, und schiebt das eine Wort, auf das es
  // ankommt, in die Mitte. Der vollständige Name bleibt am Element hängen —
  // er ist die Kennung, mit der man auf dem Host arbeitet.
  const label = container.compose ? container.compose.service : container.name;

  return (
    <div>
      <div className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] hover:bg-accent">
        <ContainerStateDot state={container.state} />
        <Link
          to={containerPath(hostId, container.name)}
          title={container.name}
          data-testid={`container-open-${container.name}`}
          className="truncate font-mono underline-offset-2 hover:underline"
        >
          {label}
        </Link>
        {/* ⚠️ DIE MARKEN DIESES CONTAINERS UND NICHT DIE SEINES STACKS, und der
          Platz gehört `app/` (#282). §3 vergibt eine eigene Marke „an einen
          Stack ODER an einen einzelnen Container"; erbte der Container, stünde
          unter einem markierten Stack an jeder Zeile dieselbe Marke, und die
          Zuordnung am Stack wäre nicht mehr zu sehen. Diese Zeile weiß von
          ihrem Stack ohnehin nichts — sie bekommt nur den Container —, und das
          ist hier kein Mangel, sondern die Bauform, die den Fehler unmöglich
          macht.

          ⚠️ DER GRIFF STEHT NEBEN DER MARKEN-LISTE, NICHT DARIN UND NICHT IN
          EINEM ANDEREN BEDIENELEMENT. Diese Zeile ist ein schlichtes `div` —
          der `a` des Deepdives ist die KOPFZEILE des Stacks
          (`StackSection.tsx`) und steht als Geschwister neben der
          Container-Liste, nicht um sie herum, und der `button` der Übersicht
          (`StackRow.tsx`) umschließt die Stack-Zeile und nicht die Container
          darunter. Was der Platz zeichnet, steckt damit in keinem Knopf und in
          keinem Verweis; `web/tests/marks-assign.test.tsx` prüft das am
          gerenderten Baum, denn kein vorhandener Wächter fängt eine solche
          Verschachtelung. */}
        {slots?.containerMarks?.(container, hostId, rowNotice)}
        {/* Der Statustext des Agenten („Up 2 hours", „Exited (1) …"). Er steht
          hier rechts und blass: er ist die Begründung des Punktes und nicht
          die Hauptaussage der Zeile. Übersetzt wird er nicht — er kommt
          wörtlich von Docker und ist kein Text dieser Oberfläche. */}
        <span className="ml-auto flex shrink-0 items-center gap-2.5">
          {/* Der letzte Messwert (#213), aus `app/` hereingereicht. Er steht
              VOR dem Statustext und nicht dahinter: der Status ist der rechte
              Rand der Zeile, an dem das Auge über alle Zeilen hinweg
              entlangläuft. */}
          {slots?.containerUsage?.(container, hostId)}
          <span className="shrink-0 truncate text-xs text-subtle-foreground">
            {container.status}
          </span>
        </span>
      </div>
      {/* Eine eigene Zeile unter der Container-Zeile : in der
          vollen Zeile schöbe die Meldung den Status hinaus. */}
      {notice !== null ? (
        <span role="alert" className="block pl-5 text-[12px] text-destructive">
          {notice}
        </span>
      ) : null}
    </div>
  );
}
