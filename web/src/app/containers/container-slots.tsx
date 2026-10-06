import { useMemo, useRef } from "react";
import { useTranslations } from "use-intl";

import type { MarkView, OverviewContainer, StackView } from "contract";

import { useOverviewUpdate, type ContainerRowNotice, type ContainerSlots } from "../../features/containers";
import {
  MarkAssign,
  MarkList,
  ROW_MARK_LIMIT,
  setContainerMarks,
  useMarks,
  withContainerMarks
} from "../../features/marks";
import { RowUsage } from "../../features/metrics";
import type { Role } from "../../platform/session/session-user";

// What the container lists show of the other features (#282): the marks of a
// stack and a container, the grip that assigns them, and the last measured
// usage. The feature `containers` draws the rows and leaves these places open
// (`features/containers/slots.ts`); the marks belong to `marks` and the usage to
// `metrics` (#283), and a feature imports no other feature, so what two of
// them show together is put together here (docs/design/feature-architecture.md,
// rule 1 and section 2).
//
// ⚠️ TWO SETS, AND THE DIFFERENCE IS THE GRIP. `OVERVIEW_SLOTS` is for every
// surface that only shows: the overview, the stack page and, for a user
// without the admin role, the deep dive. `useDeepDiveSlots` is the deep dive
// of an administrator: it is the one place where the marks of a single
// container are assigned (D7b/C2), and a second way to the same target would be
// two places that drift apart.

const stackMarks = (stack: StackView) => (
  // The cap of two is not taste: the row carries arrow, dot, name, counter and
  // the link at its end.
  <MarkList marks={stack.marks} limit={ROW_MARK_LIMIT} />
);

const containerUsage = (container: OverviewContainer, hostId: string) => <RowUsage container={container} hostId={hostId} />;

// Der Deckel gilt: die Zeile trägt schon Punkt, Namen und Statustext.
const readOnlyContainerMarks = (container: OverviewContainer) => (
  <MarkList marks={container.marks} limit={ROW_MARK_LIMIT} />
);

/** The places of every surface that shows marks and usage and assigns nothing. */
export const OVERVIEW_SLOTS: ContainerSlots = {
  stackMarks,
  containerMarks: readOnlyContainerMarks,
  containerUsage
};

type AssignableMarksProps = {
  container: OverviewContainer;
  hostId: string;
  notice: ContainerRowNotice;
  /** The stock of the hub, the pick list. `null` is "not loaded yet" and not "there are none". */
  available: readonly MarkView[] | null;
};

// The marks of one container with the grip beside them. The lock, the removal
// by the cross and the failure note stood in `ContainerRow` until #282; they
// are about marks and moved here with the marks.
function AssignableContainerMarks({ container, hostId, notice, available }: AssignableMarksProps) {
  const t = useTranslations();
  const updateOverview = useOverviewUpdate();
  // ⚠️ EINE SPERRE FÜR BEIDE WEGE (Kreuz und Menü). Beide ersetzen den GANZEN
  // Satz; liefen zwei Schreibvorgänge nebeneinander, gewänne der spätere und
  // zöge die Marke des früheren still wieder ab. Ein Ref und kein State: die
  // Sperre muss im selben Tick gelten, in dem der zweite Klick kommt.
  const writing = useRef(false);

  // ⚠️ The stored state is entered into the HELD answer and not fetched again:
  // the hub answers the write with what it stored.
  const write = async (markIds: string[]) => {
    if (writing.current) return;
    writing.current = true;
    try {
      const marks = await setContainerMarks(hostId, container.name, markIds);
      updateOverview((current) => withContainerMarks(current, hostId, container.name, marks));
    } finally {
      writing.current = false;
    }
  };

  return (
    <>
      <MarkList
        marks={container.marks}
        limit={ROW_MARK_LIMIT}
        // Ein Kreuz an der Pille zieht nur diese Marke ab; der Satz reist
        // vollständig, wie bei jedem Schreibvorgang dieser Zuordnung.
        onRemove={(mark) => {
          if (writing.current) return;
          notice.notify(null);
          void write(container.marks.filter((other) => other.id !== mark.id).map((other) => other.id)).catch(() =>
            notice.notify(t("markAssignFailed"))
          );
        }}
      />
      {/* ⚠️ Ohne sichtbaren Text: die Zeile trägt schon Punkt, Namen, Marken
          und den Statustext des Agenten. Was der Screenreader hört, nennt den
          Container beim Namen — „Marken vergeben" allein sagte in einer Liste
          von dreißig Zeilen nicht, für welche der dreißig. */}
      <MarkAssign
        assigned={container.marks}
        available={available}
        label={t("markAssignForContainer", { container: container.name })}
        testId={`container-marks-${container.name}`}
        onChange={write}
      />
    </>
  );
}

/**
 * The places of the deep dive: for an administrator with the grip, otherwise
 * the read only set.
 *
 * A hook, because the stock of the marks is read once for the whole surface and
 * only for an administrator: a request for a pick list nobody sees is a request
 * without a reader.
 */
export function useDeepDiveSlots(role: Role): ContainerSlots {
  const editable = role === "admin";
  const available = useMarks({ enabled: editable }).data ?? null;
  return useMemo(
    () =>
      editable
        ? {
            ...OVERVIEW_SLOTS,
            containerMarks: (container, hostId, notice) => (
              <AssignableContainerMarks container={container} hostId={hostId} notice={notice} available={available} />
            )
          }
        : OVERVIEW_SLOTS,
    [editable, available]
  );
}
