import { useEffect, useState } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import type { HostContainers, HostOverview, HostView, LiveStatus } from "contract";

import { queryKeys } from "../../platform/query/query-keys";

export type LiveState = { transport: boolean; hosts: Record<string, LiveStatus>; unavailable?: Record<string, boolean> };
const INITIAL_LIVE_STATE: LiveState = { transport: false, hosts: {} };
export function useLiveStale(hostId: string): boolean {
  const { data } = useQuery<LiveState>({
    queryKey: queryKeys.hosts.live(), queryFn: skipToken, initialData: INITIAL_LIVE_STATE, gcTime: Infinity
  });
  return !data?.transport || data.hosts[hostId] !== "connected" || data.unavailable?.[hostId] === true;
}
export function LiveStatusLabel({ hostId, state }: { hostId: string; state: HostView["state"] }) {
  const t = useTranslations();
  const stale = useLiveStale(hostId);
  return state === "registered" && stale ? <span role="status" data-testid={`live-stale-${hostId}`} className="text-xs text-muted-foreground">{t("liveStateStale")}</span> : null;
}
export function MeasurementStale({ hostId, sampledAt }: { hostId?: string; sampledAt: string | null }) {
  const t = useTranslations();
  const disconnected = useLiveStale(hostId ?? "");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);
  const timestamp = sampledAt === null ? NaN : Date.parse(sampledAt);
  const stale = (hostId !== undefined && disconnected) || !Number.isFinite(timestamp) || now - timestamp > 30_000;
  return stale ? <span data-testid="measurement-stale" className="text-xs text-muted-foreground">{t("liveMeasurementStale")}</span> : null;
}

/** An unavailable host cannot erase its last successful readings. */
export function retainHostContainers(next: HostContainers, previous?: HostContainers): HostContainers {
  return next.containers === null && previous ? { ...next, containers: previous.containers, load: previous.load } : next;
}
export function retainHostOverview(next: HostOverview, previous?: HostOverview): HostOverview {
  return next.error !== null && previous ? { ...next, stacks: previous.stacks, loose: previous.loose } : next;
}
