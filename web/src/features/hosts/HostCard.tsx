import { LiveStatusLabel } from "../../domain/hosts";
import { Download, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslations, type Messages } from "use-intl";

import { hostDisplay, HostStatusBadge, HostStatusDot, type DockerHost, type HostCounters, type HostLoad } from "../../domain/hosts";
import { deleteHost, hostArchiveUrl } from "./api";
import { Badge } from "../../platform/ui/shadcn/badge";
import { Button } from "../../platform/ui/shadcn/button";
import { Card, CardContent } from "../../platform/ui/shadcn/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "../../platform/ui/shadcn/dialog";
import { knownKey } from "../../platform/i18n/wire-labels";
import { AgentMigration } from "./AgentMigration";
import { AgentUpdate } from "./AgentUpdate";
import { describeRemoveHostError } from "./host-errors";
import { LastAgentUpdate } from "./LastAgentUpdate";
import { Timestamp } from "./Timestamp";

// Eine Karte je Host — die Panel-Form des Artboards
// (docs/design/mockup/hub-palette.html Z. 474–500): getönter Kopf mit Name,
// Zustand und Zählern, darunter die Angaben zum Arm, darunter die Aktionen.
//
// ⚠️ HIER SITZT DIE ACHSE AUS D0. Die drei Attribute am Karten-Element sind
// kein Beiwerk: `data-host` setzt die Sättigung der Host-Ebene, `data-hue` den
// Ton, `data-ink` die Stufe des Farbeinsatzes — und die Ableitungsregel in
// web/src/platform/theme/palette.css rechnet daraus die ganze Palette DIESES Teilbaums.
// Eine Variable löst dort auf, wo sie deklariert ist; ohne die Attribute an
// der Karte selbst käme unten der Grundton des Hauses an, egal was der Host
// trägt. Wer sie entfernt, sieht keinen Fehler — nur Grau.
//
// ⚠️ `local` bekommt WEDER „Entfernen" NOCH „Archiv erneut laden". Beide
// Routen antworten dort mit `409`: der lokale Arm entstünde beim nächsten
// Start ohnehin wieder, und ein Archiv gibt es für ihn nicht, weil sein Agent
// im Compose-Stack steht und nicht im Tunnel (`buildArchive`,
// hosts/enrollment.ts — „host-is-local"). Beim Archiv wog der überzählige
// Knopf schwerer als beim Entfernen: er war ein `<a download>`, also lud ein
// Klick darauf die Fehlermeldung als Datei herunter, statt sie zu zeigen.

const HOST_KIND_KEYS: Record<DockerHost["kind"], keyof Messages> = {
  local: "hostKindLocal",
  internal: "hostKindInternal",
  external: "hostKindExternal"
};

// Die Zähler im Kopf: „3 Stacks · 21 Container · 18 laufen".
//
// ⚠️ Bei `unavailable` steht hier NICHTS. Der erste Entwurf schrieb „nicht
// erreichbar" — und das war bei einem Host im Zustand `pending` schlicht
// falsch: sein Agent ist nicht unerreichbar, es gibt ihn noch nicht. Bei
// `offline` wäre es richtig, aber überflüssig: die Marke daneben sagt es
// bereits. Eine Zeile, die einmal falsch und einmal doppelt ist, gehört weg.
function HostCounts({ counters }: { counters: HostCounters }) {
  const t = useTranslations();
  if (counters.state === "loading") {
    return <span className="text-xs text-subtle-foreground">{t("loading")}</span>;
  }
  if (counters.state === "unavailable") return null;

  const { stacks, containers, running } = counters.summary;
  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>{t("hostStacksCount", { count: stacks })}</span>
      <span aria-hidden="true">·</span>
      <span>{t("hostContainersCount", { count: containers })}</span>
      <span aria-hidden="true">·</span>
      <span>{t("hostRunningCount", { count: running })}</span>
    </span>
  );
}

// Der Bestätigungsdialog vor dem Entfernen.
//
// ⚠️ Er löst `window.confirm` ab, das bis D4 an dieser Stelle stand. Das war
// kein Stilproblem: der Kasten des Browsers trägt weder die Schrift noch die
// Farben dieser Oberfläche, er blockiert den ganzen Reiter, und in der
// gedruckten Zeile steht der deutsche Satz aus der Sprachdatei neben zwei
// englischen Schaltflächen des Systems.
function RemoveHostDialog({ host, onRemoved }: { host: DockerHost; onRemoved: (hostId: string) => void }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = () => {
    setBusy(true);
    setError(null);
    deleteHost(host.id)
      .then(() => {
        setOpen(false);
        onRemoved(host.id);
      })
      .catch((cause: unknown) => setError(describeRemoveHostError(t, cause)))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" className="text-destructive hover:text-destructive">
          <Trash2 aria-hidden="true" />
          {t("hostRemove")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t("hostRemoveTitle")}</DialogTitle>
          <DialogDescription>{t("hostRemoveConfirm")}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" disabled={busy} onClick={remove}>
            {busy ? t("loading") : t("hostRemove")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Die Rückfrage vor dem erneuten Laden des Archivs.
//
// ⚠️ DIESER DIALOG IST DIE HANDLUNG UND NICHT IHRE BESCHRIFTUNG. Bis hierher
// stand an der Karte unmittelbar ein `<a download>` auf die Archivroute, mit
// der Warnung in einem Tooltip daneben. Ein Tooltip erscheint beim Zeigen und
// ist beim Klicken schon wieder weg — auf einem Berührungsgerät erscheint er
// nie. Der Klick aber rotiert Schlüsselpaar, Agent-Secret und Token (§4) und
// sperrt damit einen LAUFENDEN Agenten aus; rückgängig macht ihn nichts, und
// das alte Archiv gibt es nicht mehr. Eine Handlung, die einen arbeitenden Arm
// abhängt, gehört hinter dieselbe Rückfrage wie das Entfernen.
//
// ⚠️ Der Auslöser MUSS ein `button` sein und der `<a download>` ausschließlich
// im Dialog stehen. Wer den Auslöser wieder zu einem Link macht, hat den
// Dialog nicht entschärft, sondern zur Zierde gemacht: die Rotation liefe dann
// beim ERSTEN Klick, und die Rückfrage öffnete sich hinterher. Der Wächter in
// web/tests/host-card-safety.test.tsx prüft genau das.
//
// ⚠️ Kein `fetch` + Blob im Bestätigen-Knopf, aus demselben Grund wie im
// Anlege-Dialog: das verlöre den Dateinamen aus `Content-Disposition` und in
// manchen Browsern die Sitzung. Deshalb bleibt es ein `<a download>`, hier nur
// eine Ebene tiefer.
function ReloadArchiveDialog({ host }: { host: DockerHost }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" data-testid={`archive-reload-${host.id}`}>
          <Download aria-hidden="true" />
          {t("hostArchiveReload")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t("hostArchiveReloadTitle")}</DialogTitle>
          {/* Der Name steht IN der Frage und nicht nur in der Karte dahinter:
              der Dialog verdeckt sie, und bei mehreren Armen ist „dieser Host"
              genau die Auskunft, die dann fehlt. */}
          <DialogDescription>{t("hostArchiveReloadConfirm", { name: host.name })}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t("hostArchiveReloadDetail")}</p>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("cancel")}
            </Button>
          </DialogClose>
          <Button asChild variant="destructive">
            {/* Das Schließen hängt am Klick und nicht an einer Antwort: ein
                Download meldet der Seite nicht, dass er begonnen hat. Bliebe
                der Dialog offen, wäre der nächste Klick eine ZWEITE Rotation —
                und die machte das gerade geladene Archiv wieder ungültig. */}
            <a
              href={hostArchiveUrl(host.id)}
              download
              data-testid={`archive-reload-confirm-${host.id}`}
              onClick={() => setOpen(false)}
            >
              <Download aria-hidden="true" />
              {t("hostArchiveReloadSubmit")}
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The role of the viewer; spelled out here, the type of the session stays in `api/client.ts`. */
export type HostRole = "admin" | "user";

/**
 * What a card shows for the load of an arm (#214): the card knows the slot and
 * not the content. The load view belongs to the feature `metrics` (#283), and
 * a feature imports no other feature, so `app/` puts it in.
 */
export type RenderHostLoad = (hostId: string, load: HostLoad) => ReactNode;

/**
 * Admin actions another feature offers on an arm (#3: a new project). Shown
 * for every kind of arm, the local one included; `app/` puts them in.
 */
export type RenderHostActions = (host: DockerHost) => ReactNode;

type HostCardProps = {
  host: DockerHost;
  role: HostRole;
  counters: HostCounters;
  onRemoved: (hostId: string) => void;
  // Nach dem Ausgang eines Agent-Updates die Liste neu messen.
  onAgentUpdated: () => void;
  renderLoad?: RenderHostLoad;
  renderActions?: RenderHostActions;
};

export function HostCard({ host, role, counters, onRemoved, onAgentUpdated, renderLoad, renderActions }: HostCardProps) {
  const t = useTranslations();
  const kindKey = knownKey(HOST_KIND_KEYS, host.kind);
  // Ton und Farbeinsatz kommen aus der Ablage (D7a) und nicht mehr aus der
  // Kennung. Ein Arm ohne vergebene Farbe steht auf „neutral".
  const display = hostDisplay(host);
  const actions = role === "admin" ? (renderActions?.(host) ?? null) : null;

  return (
    <Card
      data-host={host.id}
      data-hue={display.hue}
      data-ink={display.ink}
      className="gap-0 overflow-hidden border-card-line bg-body-face py-0"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-head-face px-4 py-3">
        <HostStatusDot status={host.status} className="size-[9px]" />
        <span className="font-mono text-[15px] font-medium">{host.name}</span>
        {/* ⚠️ Nachgeschlagen und nicht indiziert (`i18n/wire-labels.ts`):
            `kind` kommt aus der Antwort des Servers, und eine vierte Art
            ließe diese Marke sonst LEER statt falsch — ein Unterschied, den
            auf der Fläche niemand bemerkt. */}
        <Badge variant="secondary" className="font-normal">
          {kindKey === null ? t("hostKindUnknown", { kind: host.kind }) : t(kindKey)}
        </Badge>
        <HostStatusBadge status={host.status} />
        <LiveStatusLabel hostId={host.id} />
        <span className="ml-auto">
          <HostCounts counters={counters} />
        </span>
      </div>

      <CardContent className="px-4 py-3">
        {/* Die Angaben zum Arm als Feldliste — dieselbe Form wie die
            `fields`-Blöcke des Artboards (hub-palette.html Z. 776). Ein `dl`
            und keine Tabelle: es sind Paare aus Bezeichnung und Wert, keine
            Zeilen mit gleichen Spalten. */}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-[13px]">
          <dt className="text-muted-foreground">{t("hostAgentVersionLabel")}</dt>
          <dd className="font-mono">{host.agentVersion ?? t("valueUnknown")}</dd>
          <dt className="text-muted-foreground">{t("hostTunnelAddressLabel")}</dt>
          <dd className="font-mono">{host.tunnelAddress ?? t("valueUnknown")}</dd>
          {/* Ein Arm, der noch auf sein Archiv wartet, hat nie geantwortet —
              „noch nie“ sagt dort nichts, was die Marke nicht schon sagt. */}
          {host.status === "pending" ? null : (
            <>
              <dt className="text-muted-foreground">{t("hostLastSeenLabel")}</dt>
              <dd data-testid={`last-seen-${host.id}`}>
                {host.lastSeenAt === null ? (
                  <span className="text-muted-foreground">{t("hostLastSeenNever")}</span>
                ) : (
                  <Timestamp at={host.lastSeenAt} />
                )}
              </dd>
            </>
          )}
          {/* Nur wo es ein Angebot gibt: dort antwortet der Arm, und der Stand
              seines Watchers ist lesbar. Die Route ist `requireAdmin`. */}
          {role === "admin" && host.kind !== "local" && host.agentUpdate !== null ? <LastAgentUpdate host={host} /> : null}
        </dl>
      </CardContent>

      {/* Ein Arm mit zu altem Agenten: Anleitung zum Umstieg (R38, #280). */}
      <AgentMigration host={host} />

      {/* CPU und RAM durch Container (#214). Nur mit gerechneter Last — ohne
          bekannte Ausstattung des Arms gibt es keinen Nenner. */}
      {counters.state === "ready" && counters.load !== null && renderLoad !== undefined
        ? renderLoad(host.id, counters.load)
        : null}

      {/* Die Aktionen tragen alle `requireAdmin`-Routen aus Phase 4a. Die Rolle
          verbirgt sie hier nur — der Server weist sie ohnehin ab, und das ist
          die Stelle, die zählt (§4, „Rolle nur zum Verbergen"). */}
      {role === "admin" && (host.kind !== "local" || actions !== null) ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
          {actions}
          {host.kind !== "local" ? (
            <>
              <AgentUpdate host={host} onFinished={onAgentUpdated} />
              <ReloadArchiveDialog host={host} />
              <span className="ml-auto">
                <RemoveHostDialog host={host} onRemoved={onRemoved} />
              </span>
            </>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
