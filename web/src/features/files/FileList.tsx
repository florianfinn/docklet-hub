import { useFileSource } from "./source-context";
import { CornerLeftUp, Download, FileText } from "lucide-react";
import { Link } from "react-router";
import { useTranslations } from "use-intl";

import { containerFileUrl, type FileListing, type WebftpEntry } from "./api";
import { byteSize, useLanguage } from "../../platform/i18n";
import { Card } from "../../platform/ui/shadcn/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../../platform/ui/shadcn/table";
import { FileUpload } from "./FileUpload";
import { CreateDirectory, EntryActions } from "./FolderActions";
import { entryKindLabel, formatEntryTime, isDirectory, isDownloadable } from "./file-entries";
import { childPath, parentPath } from "./file-paths";

// Die Liste EINES Verzeichnisses innerhalb der gewählten Freigabe.
//
// ⚠️ SIE HOLT NICHTS. `listing` kommt fertig herein — dieselbe Trennung wie
// zwischen `ContainerScreen` und `LogView`: hier steht, wie ein Verzeichnis
// AUSSIEHT, und nicht, wann es geholt wird.
//
// ⚠️ DAS HINEINGEHEN IST EIN `Link` UND KEIN KNOPF. Der Pfad steht im
// Abfrageteil der Adresse (`files/file-paths.ts`); ein Knopf, der einen Zustand
// setzt, wäre nicht verlinkbar, überstünde kein Neuladen, und die mittlere
// Maustaste öffnete nichts. Aus demselben Grund ist auch der Weg nach oben ein
// Verweis.

/**
 * Der Hinweis am gekürzten Verzeichnis.
 *
 * ⚠️ ER IST KEINE ZIERDE. Eine Liste, die an der Obergrenze des Agenten endet,
 * sieht vollständig aus — nichts an ihr sagt, dass etwas fehlt. Der Betreiber
 * suchte dann eine Datei, die dasteht, in einer Liste, die sie nicht zeigt.
 *
 * ⚠️ DIE ZAHL STEHT NICHT DARIN. `MAX_ENTRIES` ist eine Grenze des AGENTEN und
 * steht ausschließlich in `contract/src/agent/`;
 * `web/tests/agent-protocol-values.test.mjs` macht eine zweite Deklaration
 * rot — auch im Web. Der Satz
 * sagt deshalb, DASS gekürzt wurde, und nicht, bei welcher Zahl.
 */
function TruncatedNote() {
  const t = useTranslations();
  return (
    <p role="alert" className="text-[13px] text-state-warn" data-testid="files-truncated">
      {t("filesTruncated")}
    </p>
  );
}

// Capabilities describe daemon operations, not agent filesystem permissions.
function Diagnostics({ listing }: { listing: FileListing }) {
  const t = useTranslations();
  const diagnostics = listing.diagnostics;

  if (diagnostics === null) {
    return (
      <p className="text-[12px] text-subtle-foreground" data-testid="files-diagnostics-none">
        {t("filesDiagnosticsNone")}
      </p>
    );
  }

  return (
    <p className="flex flex-wrap gap-x-3 text-[12px] text-subtle-foreground" data-testid="files-diagnostics">
      <span>{diagnostics.readable ? t("filesDiagnosticsReadable") : t("filesDiagnosticsNotReadable")}</span>
      <span>{diagnostics.deletable ? t("filesDiagnosticsDeletable") : t("filesDiagnosticsNotDeletable")}</span>
      <span>{diagnostics.uploadable ? t("filesDiagnosticsUploadable") : t("filesDiagnosticsNotUploadable")}</span>
      <span>{t("filesDiagnosticsOwner", { uid: String(diagnostics.uid), gid: String(diagnostics.gid) })}</span>
    </p>
  );
}

/** Die Art eines Eintrags — als eigener Text, oder roh, wenn sie unbekannt ist. */
function KindCell({ entry }: { entry: WebftpEntry }) {
  const t = useTranslations();
  const key = entryKindLabel(entry);
  // ⚠️ EIN UNBEKANNTER WERT DER GEGENSEITE STEHT ROH DA und wird nicht auf
  // „Anderes" abgebildet: das wäre eine Behauptung über etwas, das diese
  // Fassung nicht kennt. Dieselbe Entscheidung wie beim Statustext von Docker.
  return <span data-testid="files-entry-kind">{key === null ? entry.kind : t(key)}</span>;
}

function EntryRow({
  entry,
  listing,
  hostId,
  containerId,
  hrefFor,
  editHrefFor,
  onChanged
}: {
  entry: WebftpEntry;
  listing: FileListing;
  hostId: string;
  containerId: string;
  hrefFor: (path: string) => string;
  editHrefFor: (path: string) => string;
  onChanged: () => void;
}) {
  const t = useTranslations();
  const { language } = useLanguage();
  const sourceId = useFileSource();
  const here = childPath(listing.path, entry.name);
  const size = byteSize(entry.size, language);

  return (
    <TableRow data-testid="files-entry" data-kind={entry.kind}>
      <TableCell className="font-mono break-all">
        {/* ⚠️ NUR EIN VERZEICHNIS FÜHRT WEITER. Ein `verweis` tut es
            ausdrücklich nicht: der Agent löst Symlinks nicht auf, die Fläche
            weiß also nicht, was am anderen Ende liegt, und ein Verweis, der
            wie ein Verzeichnis aussieht, verspräche ein Hineingehen, das der
            Agent verweigert. */}
        {isDirectory(entry) ? (
          <Link to={hrefFor(here)} data-testid="files-entry-link" className="underline-offset-2 hover:underline">
            {entry.name}
          </Link>
        ) : (
          <span data-testid="files-entry-name">{entry.name}</span>
        )}
      </TableCell>
      <TableCell>
        <KindCell entry={entry} />
      </TableCell>
      <TableCell className="tabular-nums">
        {/* Die Größe steht nur an einer echten Datei. An einem Verzeichnis ist
            `stat.size` die Größe des Verzeichniseintrags selbst und sagt
            nichts über seinen Inhalt; als Zahl daneben läse sie sich wie eine
            Auskunft, die sie nicht ist. */}
        {isDownloadable(entry) ? t(size.key, { value: size.value }) : t("fileValueNone")}
      </TableCell>
      <TableCell className="whitespace-nowrap" data-testid="files-entry-changed">
        {formatEntryTime(entry, language)}
      </TableCell>
      <TableCell className="text-right">
        <span className="inline-flex flex-wrap items-center justify-end gap-2">
          {isDownloadable(entry) ? (
            // ⚠️ DER EDITOR STEHT NUR AN EINER ECHTEN DATEI. Ein Verzeichnis
            // hat keinen Text, und ein `symlink` hat den seines Ziels — den der
            // Agent ausdrücklich nicht auflöst. Ob die Datei überhaupt Text
            // ist, weiß erst der Arm (er prüft den UTF-8-Rückvergleich); ein
            // Bild ergibt dort einen Fehler und keinen kaputten Editor.
            //
            // ⚠️ EIN `Link` UND KEIN KNOPF: der offene Editor steht im
            // Abfrageteil der Adresse (`files/file-paths.ts`), ist damit
            // verlinkbar und übersteht ein Neuladen.
            <Link
              to={editHrefFor(here)}
              data-testid={`files-edit-${entry.name}`}
              className="inline-flex items-center gap-1 text-[13px] underline-offset-2 hover:underline"
            >
              <FileText aria-hidden="true" className="size-3.5" />
              {t("filesEditOpen")}
            </Link>
          ) : null}
          {isDownloadable(entry) ? (
            // ⚠️ EIN `<a download>` UND KEIN `fetch` + Blob: der Browser holt die
            // Datei selbst, `same-origin`, und schickt die Sitzung wie bei jeder
            // anderen Navigation mit. Ein Blob verlöre den Dateinamen aus
            // `content-disposition` und hielte die ganze Datei im Reiter — für
            // den Download nennt der Agent keine Obergrenze.
            //
            // ⚠️ KEIN react-router-`Link`: das Ziel ist keine Adresse DIESER
            // Anwendung, sondern eine der API. Ein `Link` fingen den Klick ab und
            // suchte eine Route, die es nicht gibt.
            <a
              href={containerFileUrl(hostId, containerId, here, sourceId)}
              download={entry.name}
              data-testid="files-entry-download"
              className="inline-flex items-center gap-1 text-[13px] underline-offset-2 hover:underline"
            >
              <Download aria-hidden="true" className="size-3.5" />
              {t("filesDownload")}
            </a>
          ) : null}
          <EntryActions
            hostId={hostId}
            containerId={containerId}
            listing={listing}
            entry={entry}
            onDone={onChanged}
          />
        </span>
      </TableCell>
    </TableRow>
  );
}

export function FileList({
  listing,
  maxUploadBytes,
  hostId,
  containerId,
  hrefFor,
  editHrefFor,
  onChanged
}: {
  listing: FileListing;
  /**
   * Die Grenze des Arms für einen Upload, in Bytes — durchgereicht an
   * `FileUpload` (#136).
   *
   * ⚠️ SIE STEHT NICHT IN `listing`. Jene Form ist die des Agenten; diese Zahl
   * kommt daneben aus dem Umschlag von `GET …/files`.
   */
  maxUploadBytes: number;
  hostId: string;
  containerId: string;
  /** Die Adresse dieser Fläche für einen anderen Pfad in derselben Freigabe. */
  hrefFor: (path: string) => string;
  /** Die Adresse dieser Fläche mit geöffnetem Editor für diese Datei. */
  editHrefFor: (path: string) => string;
  /**
   * Nach einer Handlung, die das Verzeichnis verändert hat: noch einmal holen.
   *
   * ⚠️ SIE HOLT AUCH DANN NICHTS SELBST. Diese Datei sagt, wie ein Verzeichnis
   * AUSSIEHT; wann es geholt wird, steht in `FilesView` — dieselbe Trennung
   * wie zwischen `ContainerScreen` und `LogView`, und die Zusage „der
   * geschlossene Reiter öffnet keinen Strom" hängt daran.
   */
  onChanged: () => void;
}) {
  const t = useTranslations();

  return (
    <div className="flex flex-col gap-2" data-testid="files-list">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="font-mono text-[13px] break-all" data-testid="files-current-path">
          {listing.path === "" ? t("filesRootLabel") : listing.path}
        </p>
        {/* Der Weg zurück nach oben. Er steht nur da, wo es ein Oben gibt — in
            der Wurzel der Freigabe wäre er ein Verweis auf die eigene
            Adresse. */}
        {listing.path === "" ? null : (
          <Link
            to={hrefFor(parentPath(listing.path))}
            data-testid="files-up"
            className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
          >
            <CornerLeftUp aria-hidden="true" className="size-3.5" />
            {t("filesUp")}
          </Link>
        )}
      </div>

      {listing.truncated ? <TruncatedNote /> : null}
      <Diagnostics listing={listing} />

      {/* Die beiden Handlungen, die das VERZEICHNIS betreffen und nicht einen
          Eintrag — deshalb stehen sie über der Tabelle und nicht in einer
          Zeile. Der Hinweis „keine Auskunft"/„nicht beschreibbar" steht hier
          EINMAL und nicht an jeder Zeile: zwanzig gleiche Hinweise sind keiner. */}
      <div className="flex flex-col gap-2 rounded-md border border-card-line p-3">
        <FileUpload
          hostId={hostId}
          containerId={containerId}
          listing={listing}
          maxUploadBytes={maxUploadBytes}
          onUploaded={onChanged}
        />
        <CreateDirectory hostId={hostId} containerId={containerId} listing={listing} onDone={onChanged} />
      </div>

      <Card className="gap-0 overflow-hidden border-card-line bg-body-face py-0">
        {listing.entries.length === 0 ? (
          <p className="px-4 py-3 text-[13px] text-muted-foreground" data-testid="files-empty">
            {t("filesEmpty")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("filesColumnName")}</TableHead>
                  <TableHead>{t("filesColumnKind")}</TableHead>
                  <TableHead>{t("filesColumnSize")}</TableHead>
                  <TableHead>{t("filesColumnChanged")}</TableHead>
                  <TableHead className="text-right">{t("filesColumnActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listing.entries.map((entry) => (
                  <EntryRow
                    key={entry.name}
                    entry={entry}
                    listing={listing}
                    hostId={hostId}
                    containerId={containerId}
                    hrefFor={hrefFor}
                    editHrefFor={editHrefFor}
                    onChanged={onChanged}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
