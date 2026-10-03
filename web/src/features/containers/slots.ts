import type { ReactNode } from "react";

import type { OverviewContainer, StackView } from "contract";

// What the container lists leave to the app (#282). The rows show marks and the
// last measured usage, but the marks belong to the feature `marks` and the
// usage to the feature `metrics` (#283), and a feature imports no other
// feature (docs/design/feature-architecture.md, rule 1). The app puts them
// together and hands each one in as a render function; without it a row draws
// nothing at that place.
//
// ⚠️ ONE OBJECT AND NOT ONE PROPERTY PER SLOT. A row is reached through four
// components (`HostGroup` → `StackRow` → `ContainerList` → `ContainerRow`, and
// `HostContainers` → `StackSection` → `ContainerList` → `ContainerRow`), and a
// property per slot would be written out at each level.
//
// ⚠️ A SLOT DECIDES WHETHER A ROW OFFERS A GRIP, not a mode of the row. Only the
// deep dive hands in a `containerMarks` that draws one; the overview and the
// stack page hand in the read only list. There is no `variant` and no `mode`:
// the difference IS the slot, and a surface without it cannot show the grip by
// mistake.

/**
 * The room a container row gives to a slot that can fail on its own.
 *
 * `notify` writes one line under the row (`role="alert"`) and `null` takes it
 * away. The row owns the place, because the line does not belong inside the
 * row: in the full row the message would push the status out.
 */
export type ContainerRowNotice = {
  notify: (message: string | null) => void;
};

export type ContainerSlots = {
  /** Beside the name of a stack row: its own marks. */
  stackMarks?: (stack: StackView) => ReactNode;
  /** Beside the name of a container row: its own marks, and the grip where the app offers it. */
  containerMarks?: (container: OverviewContainer, hostId: string, notice: ContainerRowNotice) => ReactNode;
  /** In front of the status text of a container row: the last measured usage. */
  containerUsage?: (container: OverviewContainer) => ReactNode;
};
