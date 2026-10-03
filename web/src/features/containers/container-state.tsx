import { useTranslations, type Messages } from "use-intl";

import type { ContainerState } from "contract";
import { knownClass, knownKey } from "../../platform/i18n/wire-labels";
import { cn } from "../../platform/ui/lib/cn";

// Der Punkt vor einem Container oder einem Stack — dieselbe Form wie am Host
// (web/src/domain/hosts/host-status.tsx) und aus demselben Grund dieselben
// drei Farben: `--state-ok/warn/down` sind laut D0 §2 gegen jede Umschaltung
// gesperrt. Sie tragen Bedeutung und keinen Geschmack, und ein Ausfall, der
// auf dem einen Arm rot und auf dem nächsten grün erschiene, wäre kein Signal
// mehr.
//
// ⚠️ Der ZUSTAND kommt aus dem Server (`server/src/domain/containers/stacks.ts`) und
// wird hier nicht gerechnet — auch nicht der eines einzelnen Containers. Diese
// Datei bildet ihn nur ab.

const STATE_DOT: Record<ContainerState, string> = {
  ok: "bg-state-ok",
  warn: "bg-state-warn",
  down: "bg-state-down"
};

const STATE_KEYS: Record<ContainerState, keyof Messages> = {
  ok: "containerStateOk",
  warn: "containerStateWarn",
  down: "containerStateDown"
};

/**
 * Der Punkt mit seiner Bedeutung als Text daneben — für den Screenreader.
 *
 * ⚠️ Anders als am Host steht hier KEINE Marke in Worten daneben: die Zeile
 * eines Containers ist eine Zeile in einer Liste von dreißig, und dreißig
 * Marken sind keine Übersicht mehr. Damit ist der Punkt der einzige Träger
 * der Aussage — und ein Punkt allein sagt einem Screenreader nichts. Deshalb
 * reist der Text mit, unsichtbar.
 */
export function ContainerStateDot({ state, className }: { state: ContainerState; className?: string }) {
  const t = useTranslations();
  // ⚠️ NACHGESCHLAGEN UND NICHT INDIZIERT, obwohl der Typ es erlaubte. `state`
  // kommt über die Leitung, und `Record<ContainerState, …>[state]` war am
  // 2026-09-07 gemessen der Grund für ein `MISSING_MESSAGE` an JEDER
  // Container-Zeile — die Begründung steht in `i18n/wire-labels.ts`. Wichtig
  // ist hier nicht die Konsolenzeile, sondern was sie anrichtet: der Text
  // dieses Punktes ist der EINZIGE Träger seiner Aussage (siehe oben), und er
  // verschwand still.
  const key = knownKey(STATE_KEYS, state);
  return (
    <span className={cn("inline-flex shrink-0 items-center", className)}>
      {/* Ein Zustand, den dieses Haus nicht kennt, bekommt KEINE der drei
          Farben. Sie sind laut D0 §2 gegen jede Umschaltung gesperrt, weil sie
          Bedeutung tragen — und „ich weiß es nicht" ist keine der drei
          Bedeutungen. Ein grauer Punkt sagt genau das. */}
      <span
        aria-hidden="true"
        className={cn("inline-block size-[7px] rounded-full", knownClass(STATE_DOT, state, "bg-muted-foreground"))}
      />
      <span className="sr-only">{key === null ? t("containerStateUnknown", { state }) : t(key)}</span>
    </span>
  );
}
