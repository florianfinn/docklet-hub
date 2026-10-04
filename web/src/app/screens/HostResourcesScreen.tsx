import { ChevronLeft } from "lucide-react";
import { lazy, Suspense } from "react";
import { Link, useParams } from "react-router";
import { useTranslations } from "use-intl";

import { useHosts } from "../../domain/hosts";
import type { Role } from "../../platform/session/session-user";
import { detailPageClass } from "./detail-page";

const ResourcesView = lazy(() => import("../../features/resources/ResourcesView.lazy"));

// The resources of one host (#10), reached from its card on the hosts page.
// The route behind it is admin only; for any other role the page asks nothing.
export function HostResourcesScreen({ role }: { role: Role }) {
  const t = useTranslations();
  const { hostId = "" } = useParams();
  const host = useHosts().data?.find((entry) => entry.id === hostId);

  return (
    <div className={detailPageClass(false)}>
      <Link to="/hosts" className="flex w-fit items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
        <ChevronLeft aria-hidden="true" className="size-3.5" />
        {t("resourcesBack")}
      </Link>
      <h1 className="flex items-baseline gap-3 text-[20px] font-medium tracking-[-0.022em]">
        {t("resourcesTitle")}
        {host ? <span className="font-mono text-[15px] font-normal text-muted-foreground">{host.name}</span> : null}
      </h1>
      {role === "admin" ? (
        <Suspense fallback={<p className="text-[13px] text-muted-foreground">{t("loading")}</p>}>
          <ResourcesView key={hostId} hostId={hostId} />
        </Suspense>
      ) : (
        <p className="text-[13px] text-muted-foreground">{t("resourcesAdminOnly")}</p>
      )}
    </div>
  );
}
