import { ChevronRight, Eye, EyeOff, SquareArrowOutUpRight } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useTranslations } from "use-intl";

import type { StackView } from "contract";

import { cn } from "../../platform/ui/lib/cn";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../platform/ui/shadcn/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "../../platform/ui/shadcn/context-menu";
import { stackPath } from "../../platform/routes/stack-path";
import { ContainerList } from "./ContainerList";
import { ContainerStateDot } from "./container-state";
import type { ContainerSlots } from "./slots";

export type StackRowProps = {
  hostId: string;
  stack: StackView;
  open: boolean;
  onHiddenChange?: (hidden: boolean) => void;
  slots?: ContainerSlots;
};

export function StackRow({ hostId, stack, open, onHiddenChange, slots }: StackRowProps) {
  const t = useTranslations();
  const navigate = useNavigate();

  // open is the initial value; user toggles remain local.
  const [expanded, setExpanded] = useState(open);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex items-center rounded-md hover:bg-accent data-[state=open]:bg-accent">
            {/* Navigation stays outside the disclosure button. */}
            <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px]">
              <ChevronRight
                aria-hidden="true"
                className={cn("size-3.5 shrink-0 text-subtle-foreground transition-transform", expanded && "rotate-90")}
              />
              <ContainerStateDot state={stack.state} />
              <span className="truncate font-mono">{stack.project}</span>
              {slots?.stackMarks?.(stack)}
              {/* Use stack.total because the visible container list may be filtered. */}
              <span className="ml-auto shrink-0 font-mono text-[11px] text-subtle-foreground" aria-hidden="true">
                {stack.running}/{stack.total}
              </span>
              <span className="sr-only">{t("stackRunningOf", { running: stack.running, total: stack.total })}</span>
            </CollapsibleTrigger>
            <Link
              to={stackPath(hostId, stack.project)}
              aria-label={t("stackOpen", { project: stack.project })}
              className="shrink-0 rounded-md px-2 py-1.5 text-subtle-foreground hover:text-foreground"
            >
              <ChevronRight aria-hidden="true" className="size-4" />
            </Link>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">
          <ContextMenuItem onSelect={() => void navigate(stackPath(hostId, stack.project))}>
            <SquareArrowOutUpRight aria-hidden="true" />
            {t("stackMenuOpen")}
          </ContextMenuItem>
          {onHiddenChange ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem data-testid="stack-menu-hidden" onSelect={() => onHiddenChange(!stack.hidden)}>
                {stack.hidden ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
                {t(stack.hidden ? "stackMenuShow" : "stackMenuHide")}
              </ContextMenuItem>
            </>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
      {/* data-indent and pl-stack-indent must share the same element. */}
      <CollapsibleContent data-indent={stack.indent} className="pl-stack-indent">
        <ContainerList containers={stack.containers} hostId={hostId} slots={slots} />
      </CollapsibleContent>
    </Collapsible>
  );
}
