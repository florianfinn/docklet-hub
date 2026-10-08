import { ChevronRight } from "lucide-react";
import { Link } from "react-router";
import { useTranslations } from "use-intl";

import type { StackView } from "contract";

import { stackPath } from "../../platform/routes/stack-path";
import { LifecycleControls } from "./LifecycleControls";
import { ContainerList } from "./ContainerList";
import { ContainerStateDot } from "./container-state";
import type { ContainerSlots } from "./slots";

export function StackSection({
  hostId,
  stack,
  slots
}: {
  hostId: string;
  stack: StackView;
  slots?: ContainerSlots;
}) {
  const t = useTranslations();

  return (
    <div>
      {/* Lifecycle actions stay outside the navigation link. */}
      <Link
        to={stackPath(hostId, stack.project)}
        className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] hover:bg-accent"
      >
        <ContainerStateDot state={stack.state} />
        <span className="truncate font-mono">{stack.project}</span>
        {slots?.stackMarks?.(stack)}
        {/* Use stack.total because the visible container list may be filtered. */}
        <span className="ml-auto shrink-0 text-xs text-subtle-foreground">
          {t("stackContainersCount", { count: stack.total })}
        </span>
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-subtle-foreground" />
      </Link>
      <LifecycleControls target={{ kind: "stack", hostId, stack }} />
      {/* data-indent and pl-stack-indent must share the same element. */}
      <div data-indent={stack.indent} className="pl-stack-indent">
        <ContainerList containers={stack.containers} hostId={hostId} slots={slots} />
      </div>
    </div>
  );
}
