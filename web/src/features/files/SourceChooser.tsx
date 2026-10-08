import { sourceBlockerKeys } from "./source-blockers";
import type { FileSource } from "contract";
import { Link } from "react-router";
import { useTranslations } from "use-intl";
export function SourceChooser({ sources, pathname, selected }: { sources: FileSource[]; pathname: string; selected?: string }) {
  const t = useTranslations();
  return <div className="flex flex-col gap-2" role="group" aria-label={t("filesSourcesLabel")}>
    {sources.map((source) => <div key={source.sourceId} data-testid="file-source" className="text-sm">
      {source.readable ? <Link aria-current={source.sourceId === selected ? "true" : undefined}
        to={`${pathname}?sourceId=${encodeURIComponent(source.sourceId)}${source.estimatedBytes !== null ? "&edit=" : ""}`}>{source.source} → {source.target}</Link>
        : <span>{source.source} → {source.target}</span>}
      <span> · {t(source.kind === "project" ? "filesSourceProject" : source.kind === "external" ? "filesSourceExternal" : "filesSourceVolume")}</span>
      <span> · {t(source.writable ? "filesSourceWritable" : "filesSourceReadOnly")}</span>
      {source.writeBlocker ? <span> · {t(sourceBlockerKeys[source.writeBlocker])}</span> : null}
    </div>)}
  </div>;
}
