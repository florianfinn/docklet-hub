import { Download, Plus, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslations } from "use-intl";

import type { DockerHost } from "../../domain/hosts";
import { hostArchiveUrl } from "./api";
import { Button } from "../../platform/ui/shadcn/button";
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
import { CommandLine } from "../../platform/ui/CommandLine";
import { HostForm, type HostSetup } from "./HostForm";

// „Host hinzufügen" als Dialog (D5, Artboard
// docs/design/mockup/container-module.html Z. 140).
//
// Der Dialog hat ZWEI Schritte, und der zweite ist der Grund für seine
// Bauweise: nach dem Anlegen steht hier das Archiv und nicht wieder das
// Formular. Laut Vertrag (§4) gibt es kein „noch einmal herunterladen" —
// jeder Aufruf der Archivroute rotiert Schlüsselpaar, Agent-Secret und Token
// neu und sperrt einen laufenden Agenten mit dem alten Archiv aus. Wer den
// Dialog nach dem Anlegen sofort schlösse, käme an das Archiv nur noch über
// die Aktion an der Karte, und die erzeugt ein neues.
//
// ⚠️ Der Schritt wird beim Schließen zurückgesetzt (`reset` in
// `onOpenChange`). Ohne das zeigte der Dialog beim nächsten Öffnen das Archiv
// des zuletzt angelegten Hosts — ein Herunterladen dort rotierte die
// Zugangsdaten eines Arms, den gerade niemand angefasst hat.

// Der Name des Verzeichnisses, das der Arm auf dem Zielhost bekommt.
//
// ⚠️ ZWEITE FASSUNG — die erste ist `DIRECTORY_NAME` in
// `server/src/features/hosts/bootstrap/host-archive-readme.ts`. Dieser Dialog sagt „lege es
// hier an", die README im Paket sagt „hier liegt es"; nennen beide
// verschiedene Orte, sucht der Betreiber im zweiten Schritt an einer Stelle,
// an der nichts ist. Web und Server teilen keinen Code, die Abschrift ist
// unvermeidlich — `web/tests/host-form-defaults.test.mjs` hält sie zusammen.
export const DIRECTORY_NAME = "docklet-agent";

export function HostCreateDialog({ onCreated }: { onCreated: (host: DockerHost) => void }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<DockerHost | null>(null);
  // Der Basispfad, den der Betreiber gerade eingetragen hat. Er steht NICHT in
  // `created`: `HostView` trägt ihn bewusst nicht (#89). Ohne ihn könnte der
  // Schritt unten nur „in ein Verzeichnis" sagen — und das ist keine Anleitung.
  const [setup, setSetup] = useState<HostSetup | null>(null);
  const target = `${setup?.bindBasePath ?? ""}/${DIRECTORY_NAME}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setCreated(null);
          setSetup(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button">
          <Plus aria-hidden="true" />
          {t("hostCreateAction")}
        </Button>
      </DialogTrigger>

      {/* `minmax(0,1fr)` keeps the grid column from growing to a long command's
          min-content width; CommandLine scrolls inside its own row instead.
          The archive step shows full paths and gets more room, capped well
          below the viewport. */}
      <DialogContent
        className={
          created === null
            ? "grid-cols-[minmax(0,1fr)] sm:max-w-[440px]"
            : "grid-cols-[minmax(0,1fr)] sm:max-w-[min(48rem,calc(100%-4rem))]"
        }
      >
        <DialogHeader>
          <DialogTitle>{t("hostCreateTitle")}</DialogTitle>
          {/* Die Beschreibung ist keine Zierde: `DialogContent` verbindet sie
              über `aria-describedby` mit dem Dialog. Fehlt sie, warnt Radix,
              und der Dialog kündigt sich beim Screenreader nur mit seinem
              Titel an. */}
          <DialogDescription>
            {created === null ? t("hostCreateDescription") : t("hostArchiveReadyHint")}
          </DialogDescription>
        </DialogHeader>

        {created === null ? (
          <HostForm
            onCreated={(host, created) => {
              setCreated(host);
              setSetup(created);
              onCreated(host);
            }}
          />
        ) : (
          <div className="flex flex-col gap-4">
            {/* Only the first three steps on the target host: location, permissions,
                start. The README in the archive carries the rest. */}
            <ol className="flex flex-col gap-4">
              {/* The path the operator just entered, not an invented one: the
                  agent may create bind mounts below it. */}
              <ArchiveStep number={1} title={t("hostArchiveStepUnpackTitle")} text={t("hostArchiveStepUnpack")}>
                <CommandLine prompt highlight={target}>{`sudo mkdir -p ${target}`}</CommandLine>
              </ArchiveStep>
              <ArchiveStep number={2} title={t("hostArchiveStepPermissionsTitle")} text={t("hostArchiveStepPermissions")}>
                <CommandLine prompt>{t("hostArchiveStepPermissionsCommand")}</CommandLine>
              </ArchiveStep>
              <ArchiveStep number={3} title={t("hostArchiveStepStartTitle")} text={t("hostArchiveStepStart")}>
                <CommandLine prompt>{t("hostArchiveStepStartCommand")}</CommandLine>
              </ArchiveStep>
            </ol>

            <p
              role="note"
              className="flex items-start gap-2 rounded-md border border-state-warn/40 bg-state-warn/10 px-3 py-2 text-sm text-foreground"
            >
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-state-warn" />
              <span>{t("hostArchiveHint")}</span>
            </p>
            {/* Kein `fetch` + Blob: das verlöre den Dateinamen aus
                `Content-Disposition` und in manchen Browsern die Sitzung.
                Deshalb ein `<a download>`, das die Sitzung wie jede andere
                Navigation mitschickt — als Schaltfläche gestaltet über
                `asChild`, damit hier nicht ein zweites Aussehen für dieselbe
                Handlung entsteht. */}
            <Button asChild>
              <a href={hostArchiveUrl(created.id)} download>
                <Download aria-hidden="true" />
                {t("hostArchiveDownload")}
              </a>
            </Button>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  {t("done")}
                </Button>
              </DialogClose>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// One step on the target host: number and title carry the sequence, the muted
// text the reason, the command what to type.
function ArchiveStep({
  number,
  title,
  text,
  children
}: {
  number: number;
  title: string;
  text: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary"
      >
        {number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-sm font-semibold text-foreground">{title}</span>
        <span className="text-xs text-muted-foreground">{text}</span>
        {children}
      </div>
    </li>
  );
}
