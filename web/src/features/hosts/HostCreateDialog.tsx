import { Download, Plus } from "lucide-react";
import { useState } from "react";
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
// `server/src/bootstrap/host-archive-readme.ts`. Dieser Dialog sagt „lege es
// hier an", die README im Paket sagt „hier liegt es"; nennen beide
// verschiedene Orte, sucht der Betreiber im zweiten Schritt an einer Stelle,
// an der nichts ist. Web und Server teilen keinen Code, die Abschrift ist
// unvermeidlich — `web/tests/host-form-defaults.test.mjs` hält sie zusammen.
export const DIRECTORY_NAME = "dashboard-docker-agent";

export function HostCreateDialog({ onCreated }: { onCreated: (host: DockerHost) => void }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<DockerHost | null>(null);
  // Der Basispfad, den der Betreiber gerade eingetragen hat. Er steht NICHT in
  // `created`: `HostView` trägt ihn bewusst nicht (#89). Ohne ihn könnte der
  // Schritt unten nur „in ein Verzeichnis" sagen — und das ist keine Anleitung.
  const [setup, setSetup] = useState<HostSetup | null>(null);

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

      <DialogContent className="sm:max-w-[440px]">
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
            {/* ⚠️ WAS HIER BIS JETZT FEHLTE: der Dialog sagte, was ein erneuter
                Klick anrichtet, und mit keinem Wort, was mit der Datei zu
                geschehen hat. Der Betreiber stand mit einem Archiv da und ohne
                Anleitung — gemeldet beim ersten echten Arm. Die ausführliche
                Fassung liegt IM Paket (`host-archive-readme.ts`), nur liest
                man die erst, wenn man das Paket bereits am richtigen Ort
                ausgepackt hat. Genau dieser eine Schritt gehört deshalb hierhin
                und nicht dorthin.

                Drei Schritte und nicht mehr: der Ort, die Rechte, der Start.
                Alles Weitere steht in der README daneben. */}
            <ol className="flex list-decimal flex-col gap-3 pl-4 text-sm text-muted-foreground">
              <li>
                {t("hostArchiveStepUnpack")}
                {/* Der Pfad, den der Betreiber gerade selbst eingetragen hat,
                    und nicht ein erfundener: unterhalb DIESES Verzeichnisses
                    darf der Agent Bind-Mounts anlegen, und der Compose-Stack
                    des Arms liegt sinnvollerweise darin. */}
                <CommandLine>{`sudo mkdir -p ${setup?.bindBasePath ?? ""}/${DIRECTORY_NAME}`}</CommandLine>
              </li>
              <li>
                {t("hostArchiveStepPermissions")}
                <CommandLine>{t("hostArchiveStepPermissionsCommand")}</CommandLine>
              </li>
              <li>
                {t("hostArchiveStepStart")}
                <CommandLine>{t("hostArchiveStepStartCommand")}</CommandLine>
              </li>
            </ol>

            <p className="text-sm text-muted-foreground">{t("hostArchiveHint")}</p>
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
