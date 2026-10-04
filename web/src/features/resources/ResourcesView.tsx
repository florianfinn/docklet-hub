import type { ReactNode } from "react";
import type { Messages } from "use-intl";
import { useTranslations } from "use-intl";

import type {
  HostResourcesView,
  ImageResourceView,
  NetworkResourceView,
  ResourceUser,
  StorageUsage,
  VolumeResourceView
} from "contract";

import { errorCode } from "../../platform/http/transport";
import { byteSize, useLanguage } from "../../platform/i18n";
import { formatClock } from "../../platform/i18n/time-format";
import { knownKey } from "../../platform/i18n/wire-labels";
import { Badge } from "../../platform/ui/shadcn/badge";
import { Button } from "../../platform/ui/shadcn/button";
import { Card } from "../../platform/ui/shadcn/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../platform/ui/shadcn/table";
import { useHostResources } from "./resource-queries";
import { imageLabel, isShared, shortId, usageState, type UsageState } from "./resource-values";

// The resources of one host (#10): disk usage, then images, volumes and
// networks with their users. Read only; nothing on this page offers a change.
// A section that could not be read says so in its own place, and an unknown
// usage is shown as unknown, never as unused.

type Translate = ReturnType<typeof useTranslations>;

const REASON_KEYS: Record<string, keyof Messages> = {
  "engine-timeout": "resourcesReasonTimeout",
  "engine-unreachable": "resourcesReasonUnreachable",
  "engine-refused": "resourcesReasonRefused",
  unreadable: "resourcesReasonUnreadable"
};

const LOAD_ERROR_KEYS: Record<string, keyof Messages> = {
  "agent-outdated": "resourcesOutdated",
  "host-unreachable": "resourcesUnreachable",
  "agent-unreachable": "resourcesUnreachable",
  "host-unknown": "resourcesHostUnknown"
};

const USAGE_KEYS: Record<UsageState, keyof Messages> = {
  "in-use": "resourcesMarkInUse",
  unused: "resourcesMarkUnused",
  unknown: "resourcesMarkUnknown"
};

function reasonText(t: Translate, reason: string): string {
  const key = knownKey(REASON_KEYS, reason);
  return key === null ? t("resourcesReasonOther", { reason }) : t(key);
}

function useBytes(): (value: number | null) => string | null {
  const t = useTranslations();
  const { language } = useLanguage();
  return (value) => {
    if (value === null) return null;
    const size = byteSize(value, language);
    return t(size.key, { value: size.value });
  };
}

export function ResourcesView({ hostId }: { hostId: string }) {
  const t = useTranslations();
  const { language } = useLanguage();
  const query = useHostResources(hostId);
  const resources = query.data?.resources;

  let failure: string | null = null;
  if (query.isError) {
    const key = knownKey(LOAD_ERROR_KEYS, errorCode(query.error) ?? "");
    failure = t(key ?? "resourcesFailed");
  }

  return (
    <div className="flex flex-col gap-4" data-testid="host-resources">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-[13px] text-muted-foreground">{t("resourcesReadOnly")}</p>
        {resources ? (
          <p className="text-[13px] text-subtle-foreground" data-testid="resources-read-at">
            {t("resourcesReadAt", { time: formatClock(language, new Date(resources.readAt)) })}
          </p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
          data-testid="resources-reload"
        >
          {t("resourcesReload")}
        </Button>
      </div>
      {failure !== null ? (
        <p role="alert" className="text-[13px] text-destructive" data-testid="resources-failed">
          {failure}
        </p>
      ) : null}
      {resources === undefined && failure === null ? (
        <p className="text-[13px] text-muted-foreground">{t("loading")}</p>
      ) : null}
      {resources === undefined ? null : <ResourceSections resources={resources} />}
    </div>
  );
}

function ResourceSections({ resources }: { resources: HostResourcesView }) {
  const t = useTranslations();
  return (
    <>
      <StorageCard storage={resources.storage} />
      {resources.usage.ok ? null : (
        <p role="status" className="text-[13px] text-destructive" data-testid="resources-usage-unknown">
          {t("resourcesUsageUnknownNote", { reason: reasonText(t, resources.usage.reason) })}
        </p>
      )}
      <Section title={t("resourcesImagesTitle")} section={resources.images} testId="resources-images">
        {(items) => <ImageTable images={items} />}
      </Section>
      <Section
        title={t("resourcesVolumesTitle")}
        hint={t("resourcesVolumesHint")}
        section={resources.volumes}
        testId="resources-volumes"
      >
        {(items) => <VolumeTable volumes={items} />}
      </Section>
      <Section title={t("resourcesNetworksTitle")} section={resources.networks} testId="resources-networks">
        {(items) => <NetworkTable networks={items} />}
      </Section>
    </>
  );
}

function StorageCard({ storage }: { storage: HostResourcesView["storage"] }) {
  const t = useTranslations();
  const bytes = useBytes();
  const title = t("resourcesStorageTitle");
  const rows: Array<[string, keyof Messages, StorageUsage]> = storage.ok
    ? [
        ["images", "resourcesStorageImages", storage.summary.images],
        ["containers", "resourcesStorageContainers", storage.summary.containers],
        ["volumes", "resourcesStorageVolumes", storage.summary.volumes],
        ["build-cache", "resourcesStorageBuildCache", storage.summary.buildCache]
      ]
    : [];
  return (
    <Card className="gap-2 border-card-line bg-body-face p-4" data-testid="resources-storage">
      <p className="text-sm font-medium">{title}</p>
      {storage.ok ? (
        <>
          <p className="text-[13px] text-muted-foreground">{t("resourcesStorageHint")}</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("resourcesStorageKind")}</TableHead>
                <TableHead className="text-right">{t("resourcesStorageCount")}</TableHead>
                <TableHead className="text-right">{t("resourcesStorageSize")}</TableHead>
                <TableHead className="text-right">{t("resourcesStorageUnused")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(([id, label, usage]) => (
                <TableRow key={id} data-testid={`resources-storage-${id}`}>
                  <TableCell>{t(label)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{usage.count}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {bytes(usage.sizeBytes) ?? <Unknown />}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {bytes(usage.unusedBytes) ?? <Unknown />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      ) : (
        <SectionFailure title={title} reason={storage.reason} />
      )}
    </Card>
  );
}

function Section<Item>({
  title,
  hint,
  section,
  testId,
  children
}: {
  title: string;
  hint?: string;
  section: { ok: true; items: Item[] } | { ok: false; reason: string };
  testId: string;
  children: (items: Item[]) => ReactNode;
}) {
  const t = useTranslations();
  return (
    <Card className="gap-2 border-card-line bg-body-face p-4" data-testid={testId}>
      <p className="text-sm font-medium">
        {title}
        {section.ok ? <span className="ml-2 text-xs font-normal text-subtle-foreground">{section.items.length}</span> : null}
      </p>
      {hint ? <p className="text-[13px] text-muted-foreground">{hint}</p> : null}
      {!section.ok ? (
        <SectionFailure title={title} reason={section.reason} />
      ) : section.items.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t("resourcesEmpty")}</p>
      ) : (
        children(section.items)
      )}
    </Card>
  );
}

function SectionFailure({ title, reason }: { title: string; reason: string }) {
  const t = useTranslations();
  return (
    <p role="alert" className="text-[13px] text-destructive" data-testid="resources-section-failed">
      {t("resourcesSectionFailed", { section: title, reason: reasonText(t, reason) })}
    </p>
  );
}

function Unknown() {
  const t = useTranslations();
  return <span className="text-muted-foreground">{t("resourcesSizeUnknown")}</span>;
}

function Mark({ children, tone = "outline" }: { children: ReactNode; tone?: "outline" | "secondary" }) {
  return (
    <Badge variant={tone} className="font-normal">
      {children}
    </Badge>
  );
}

function UsageMarks({ usedBy, system }: { usedBy: ResourceUser[] | null; system: boolean }) {
  const t = useTranslations();
  const state = usageState(usedBy);
  return (
    <>
      <Mark tone={state === "in-use" ? "secondary" : "outline"}>
        <span data-usage={state}>{t(USAGE_KEYS[state])}</span>
      </Mark>
      {isShared(usedBy) ? <Mark>{t("resourcesMarkShared")}</Mark> : null}
      {system ? <Mark>{t("resourcesMarkSystem")}</Mark> : null}
    </>
  );
}

function Users({ usedBy }: { usedBy: ResourceUser[] | null }) {
  const t = useTranslations();
  if (usedBy === null) return <span className="text-muted-foreground">{t("resourcesMarkUnknown")}</span>;
  if (usedBy.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-col">
      {usedBy.map((user) => (
        <span key={user.name} className="font-mono text-[13px]">
          {user.running ? user.name : t("resourcesStopped", { name: user.name })}
        </span>
      ))}
    </span>
  );
}

function MarksCell({ children }: { children: ReactNode }) {
  return (
    <TableCell>
      <span className="flex flex-wrap gap-1">{children}</span>
    </TableCell>
  );
}

function ImageTable({ images }: { images: ImageResourceView[] }) {
  const t = useTranslations();
  const bytes = useBytes();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("resourcesColumnName")}</TableHead>
          <TableHead className="text-right">{t("resourcesColumnSize")}</TableHead>
          <TableHead>{t("resourcesColumnUsedBy")}</TableHead>
          <TableHead>{t("resourcesColumnMarks")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {images.map((image) => (
          <TableRow key={image.id} data-resource={image.id}>
            <TableCell className="font-mono text-[13px]" title={image.id}>
              <span className="flex flex-col">
                <span>{imageLabel(image)}</span>
                {image.tags.slice(1).map((tag) => (
                  <span key={tag} className="text-muted-foreground">
                    {tag}
                  </span>
                ))}
                {image.tags.length > 0 ? <span className="text-xs text-subtle-foreground">{shortId(image.id)}</span> : null}
              </span>
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">{bytes(image.sizeBytes) ?? <Unknown />}</TableCell>
            <TableCell>
              <Users usedBy={image.usedBy} />
            </TableCell>
            <MarksCell>
              <UsageMarks usedBy={image.usedBy} system={image.system} />
              {image.tags.length === 0 ? <Mark>{t("resourcesMarkUntagged")}</Mark> : null}
              {image.sharedSizeBytes !== null && image.sharedSizeBytes > 0 ? (
                <Mark>{t("resourcesMarkSharedLayers", { size: bytes(image.sharedSizeBytes) ?? "" })}</Mark>
              ) : null}
            </MarksCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function VolumeTable({ volumes }: { volumes: VolumeResourceView[] }) {
  const t = useTranslations();
  const bytes = useBytes();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("resourcesColumnName")}</TableHead>
          <TableHead className="text-right">{t("resourcesColumnSize")}</TableHead>
          <TableHead>{t("resourcesColumnUsedBy")}</TableHead>
          <TableHead>{t("resourcesColumnMarks")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {volumes.map((volume) => (
          <TableRow key={volume.name} data-resource={volume.name}>
            <TableCell className="max-w-[24ch] truncate font-mono text-[13px]" title={volume.name}>
              {volume.anonymous ? shortId(volume.name) : volume.name}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">{bytes(volume.sizeBytes) ?? <Unknown />}</TableCell>
            <TableCell>
              <Users usedBy={volume.usedBy} />
            </TableCell>
            <MarksCell>
              <UsageMarks usedBy={volume.usedBy} system={volume.system} />
              {volume.anonymous ? <Mark>{t("resourcesMarkAnonymous")}</Mark> : null}
            </MarksCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function NetworkTable({ networks }: { networks: NetworkResourceView[] }) {
  const t = useTranslations();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("resourcesColumnName")}</TableHead>
          <TableHead>{t("resourcesColumnDriver")}</TableHead>
          <TableHead>{t("resourcesColumnUsedBy")}</TableHead>
          <TableHead>{t("resourcesColumnMarks")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {networks.map((network) => (
          <TableRow key={network.id} data-resource={network.name}>
            <TableCell className="font-mono text-[13px]" title={network.id}>
              {network.name}
            </TableCell>
            <TableCell className="font-mono text-[13px]">{network.driver}</TableCell>
            <TableCell>
              <Users usedBy={network.usedBy} />
            </TableCell>
            <MarksCell>
              <UsageMarks usedBy={network.usedBy} system={network.system} />
              {network.predefined ? <Mark>{t("resourcesMarkPredefined")}</Mark> : null}
              {network.internalOnly ? <Mark>{t("resourcesMarkInternal")}</Mark> : null}
            </MarksCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
