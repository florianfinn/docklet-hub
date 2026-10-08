import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { OverviewContainer } from "contract";
import { containerPath } from "../../platform/routes/container-path";
import { ContainerStateDot } from "./container-state";
import type { ContainerRowNotice, ContainerSlots } from "./slots";

// Navigation and marks are siblings so that no control is nested in a link.
export function ContainerRow({ container, hostId, slots }: {
  container: OverviewContainer; hostId: string; slots?: ContainerSlots;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const rowNotice = useMemo<ContainerRowNotice>(() => ({ notify: setNotice }), []);
  const label = container.compose ? container.compose.service : container.name;
  return <div>
    <div className="flex flex-wrap items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] hover:bg-accent">
      <ContainerStateDot state={container.state} />
      <Link to={containerPath(hostId, container.name)} title={container.name}
        data-testid={`container-open-${container.name}`} className="truncate font-mono underline-offset-2 hover:underline">{label}</Link>
      {slots?.containerMarks?.(container, hostId, rowNotice)}
      <span className="ml-auto flex min-w-0 items-center gap-2.5">
        {slots?.containerUsage?.(container, hostId)}
        <span className="truncate text-xs text-subtle-foreground">{container.status}</span>
      </span>
    </div>
    {notice !== null ? <span role="alert" className="block pl-5 text-[12px] text-destructive">{notice}</span> : null}
  </div>;
}
