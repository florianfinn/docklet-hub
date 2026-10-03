import { FileCode2, FileKey2, Keyboard, Link2, Pencil, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "use-intl";

import type { ComposeResync } from "./api";
import { cn } from "../../platform/ui/lib/cn";
import { Badge } from "../../platform/ui/shadcn/badge";
import { Button } from "../../platform/ui/shadcn/button";
import { Card } from "../../platform/ui/shadcn/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../platform/ui/shadcn/tooltip";
import { AppliedNotice } from "./AppliedNotice";
import { ComposeApply } from "./ComposeApply";
import { ComposeEditor } from "./ComposeEditor";
import { DiffView } from "./DiffView";
import { EnvView } from "./EnvView";
import { composeErrorKey, isComposeFileMissing } from "./compose-errors";
import { ComposeLookupError, useComposeFile, useComposeFileReload } from "./compose-queries";
import { ComposeSelection } from "./ComposeSelection";
import { diffLines } from "./text-diff";
import { YamlCode } from "./YamlCode";

// Der Compose-Reiter eines Stacks (#35).
//
// ⚠️ ER FRAGT ÜBER EINEN CONTAINER UND NICHT ÜBER DEN STACK, und das ist keine
// Umständlichkeit dieser Fläche, sondern die Form der Gegenseite: `GET
// /containers/:id/compose-raw` löst das Projektverzeichnis aus den LABELS des
// laufenden Containers auf. Ein Stack hat im Hub keine Kennung
// (`docs/design/hub-color-and-structure.md` §6) — der Anker in die Datei ist
// einer seiner Container.
//
// ⚠️ UND ZWAR DER ERSTE, DESSEN DATEI DER ARM LIEFERT — nicht blind der erste
// (#183). Gemessen am 2026-09-29 am Arm `unraid`: im Stack
// `minecraft_arc_2026` trug genau der erste Container
// (`arc-2026-bluemap-timelapse`) Labels, die mehr als eine Datei nennen, und
// der Arm antwortete für ihn mit `compose-file-missing`, während die beiden
// anderen Container desselben Stacks die Datei lieferten. Weitergefragt wird
// NUR über genau diesen Grund hinweg: jeder andere Fehler (Allowlist, Arm
// nicht erreichbar, nur lesen) gilt für den Stack und nicht für den einen
// Container, und ein zweiter Versuch brächte dieselbe Antwort und einen
// Audit-Eintrag mehr. Der Container, der die Datei geliefert hat, bleibt der
// Anker auch für Vorschau und Anwenden — beide lösen das Verzeichnis über
// dieselben Labels auf.
//
// ⚠️ EIN STACK OHNE CONTAINER HAT HIER KEINE DATEI, und das wird gesagt statt
// als Fehler gezeigt. Er entsteht zwischen zwei Abrufen, wenn jemand den Stack
// gerade stoppt und entfernt. Ein roter Fehlertext schickte den Betreiber auf
// die Suche nach einer Störung, die es nicht gibt.
//
// ⚠️ DER GANG DURCH DIE KANDIDATEN STEHT SEIT #265 IN `compose-queries.ts`
// (`fetchFirstCompose`, abgefragt über `useComposeFile`); die Begründung dort
// ist die obige, unverändert.
//
// ⚠️ DIESE FLÄCHE HOLT ERST, WENN SIE EINGEHÄNGT IST. Deshalb steht sie in
// `StackScreen` hinter einer Verzweigung und nicht hinter einem `hidden`: ein
// `hidden` versteckte die Fläche und schickte die Anfrage trotzdem, und jede
// Anfrage hier schreibt einen Audit-Eintrag auf dem Arm.
//
// ── DER ENTWURF UND SEIN VERLUST ──────────────────────────────────────────
//
// ⚠️ DER ENTWURF LEBT IM ZUSTAND DIESER FLÄCHE UND NIRGENDS SONST. Er wird
// ausdrücklich NICHT im Browser zwischengespeichert, und das ist eine
// Entscheidung und kein Versäumnis: eine Compose-Datei nennt Pfade, Ports und
// oft genug Zugangsdaten eines fremden Rechners. Sie in `localStorage` zu
// legen hiesse, sie auf dem Gerät des Betreibers liegen zu lassen, wo kein
// Abmelden sie wieder entfernt.
//
// Der Preis ist, dass ein Neuladen den Entwurf verliert — und genau dagegen
// steht die Warnung beim Verlassen. Sie ist die ehrliche Fassung: sie sagt es
// vorher, statt es hinterher zu bedauern.

/** Was gerade zu sehen ist. */
type Pane = "file" | "edit" | "diff" | "apply";

export function ComposeView({
  hostId,
  containers,
  revision,
  onStackChanged,
  onDirtyChange
}: {
  hostId: string;
  /**
   * Die Container des Stacks, in der Reihenfolge, in der sie gefragt werden.
   * The name labels a container whose file is selected by hand (#185).
   */
  containers: { id: string; name: string }[];
  /** Zählt jede neu gelesene Übersicht; `containerIds` stammt aus ihr. */
  revision: number;
  /** Die Übersicht neu lesen — danach steigt `revision`. */
  onStackChanged: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const t = useTranslations();
  const [draft, setDraft] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>("file");
  const [activeFile, setActiveFile] = useState<"compose" | "env">("compose");
  const [side, setSide] = useState(false);
  // ⚠️ NACH DEM ANWENDEN WIRD AUF DIE NEUE ÜBERSICHT GEWARTET (#233). `compose
  // up` ersetzt die Container, und die Kennungen, mit denen dieser Reiter
  // fragt, stammen aus der Übersicht, die `StackScreen` beim Einhängen geholt
  // hat. Ein Neulesen mit ihnen endete im `404 container-unknown` — gemessen am
  // 2026-09-30. Bis die neue Übersicht da ist (`revision` steigt), zeigt der
  // Reiter „wird geladen" statt des alten Standes, und die Abfrage ist
  // ausgesetzt (`enabled`).
  const [awaitedRevision, setAwaitedRevision] = useState<number | null>(null);
  const [applied, setApplied] = useState<ComposeResync | null>(null);
  // The container whose selection by hand is open (#185), or `null`.
  const [selecting, setSelecting] = useState<string | null>(null);
  const containerIds = containers.map((container) => container.id);
  const refreshing = awaitedRevision === revision;
  const lookup = useComposeFile(hostId, containerIds, !refreshing);
  const { reload, forget } = useComposeFileReload(hostId);

  // ⚠️ Der Entwurf wird beim Neuladen ZURÜCKGESETZT, und das ist der Sinn des
  // Knopfes: „Neu laden" heißt „den fremden Stand nehmen". Das geschieht am
  // Knopf (und nach dem Anwenden) und nicht, wenn die Antwort eintrifft.
  const file = refreshing ? null : (lookup.data?.file ?? null);
  const anchorId = refreshing ? null : (lookup.data?.anchorId ?? null);
  const content = file?.content ?? "";
  const dirty = draft !== null && draft !== content;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  // ⚠️ DIE FLÄCHE MELDET „NICHT GEÄNDERT", WENN SIE GEHT. Wer den Reiter nach
  // der Rückfrage verlässt, hat den Entwurf verworfen; ohne diese Meldung hielte
  // `StackScreen` ihn für ungesichert und fragte beim Zurückwechseln ein
  // zweites Mal (#265).
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  // Der Entwurf liegt nirgends sonst; ein Neuladen oder ein geschlossener
  // Browserreiter nehmen ihn mit. Der Browser zeigt dabei seinen eigenen Text
  // und nicht unseren — was hier zählt, ist, DASS er fragt. Den Wechsel des
  // Stack-Reiters sichert `StackScreen` über `onDirtyChange`.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      // Ältere Browser brauchen die Zuweisung, neuere reicht `preventDefault`.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // ⚠️ DER VERGLEICH LÄUFT NUR, WENN ER GEBRAUCHT WIRD (#137) — also nur in
  // den Reitern „diff" und „apply", und `useMemo` hält ihn dort, solange sich
  // nichts ändert. Getippt wird ausschließlich im Reiter „edit", und dort läuft
  // Myers gar nicht: gemessen kostet er bei 8.000 gegen 8.000 verschiedene
  // Zeilen 1.046 ms (#137), und das je Tastendruck.
  const showsDiff = pane === "diff" || pane === "apply";
  const comparison = useMemo(
    () => (showsDiff ? diffLines(content, draft ?? content) : null),
    [showsDiff, content, draft]
  );

  const nameOf = (id: string): string => containers.find((container) => container.id === id)?.name ?? id;

  // After setting or clearing: fetch the file again. The anchor may be another
  // container afterwards — exactly the one that just got a file, when it comes
  // first in the order.
  const afterSelection = (): void => {
    setSelecting(null);
    reload();
  };

  /** The skipped containers as buttons; each one opens its selection. */
  const skippedPicker = (skipped: string[], openId: string | null) => (
    <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground" data-testid="compose-skipped">
      <span>{t("composeSelectionSkipped")}</span>
      {skipped.map((id) => (
        <Button
          key={id}
          size="sm"
          variant="outline"
          aria-pressed={openId === id}
          onClick={() => setSelecting(openId === id ? null : id)}
        >
          {nameOf(id)}
        </Button>
      ))}
    </div>
  );

  if (containerIds.length === 0) {
    return (
      <Card className="p-4" data-testid="compose-no-container">
        <p className="text-[13px] text-muted-foreground">{t("composeNoContainer")}</p>
      </Card>
    );
  }

  if (lookup.error !== null && !refreshing) {
    // The walk through the candidates wraps the error of the last one and
    // remembers where the arm looked (`ComposeLookupError`).
    const failure = lookup.error instanceof ComposeLookupError ? lookup.error : null;
    const errorKey = composeErrorKey(failure === null ? lookup.error : failure.error);
    const searched = failure?.searched ?? [];
    const skipped = failure?.skipped ?? [];
    // Without a file there is nothing else to do: the first skipped container
    // stands open.
    const errorOpenId = selecting ?? skipped[0] ?? null;
    return (
      <div className="flex flex-col gap-2" data-testid="compose-error">
        <p className="text-sm text-destructive">{t(errorKey)}</p>
        {/* ⚠️ DIE PFADE STEHEN DA, WEIL SIE DER WEG ZUR BEHEBUNG SIND (#183):
            ob ein Stack im Basispfad liegt, sieht der Betreiber erst am
            Verzeichnis. Nur für den Fall „keine Datei" — die anderen Fehler
            haben keinen Ort. */}
        {isComposeFileMissing(failure?.error) && searched.length > 0 ? (
          <div className="flex flex-col gap-1 text-[13px] text-muted-foreground">
            <span>{t("composeErrorFileMissingSearched")}</span>
            <ul className="flex flex-col gap-0.5" data-testid="compose-searched">
              {searched.map((dir) => (
                <li key={dir} className="font-mono text-foreground">
                  {dir}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {/* ⚠️ THE SELECTION BY HAND (#185), only where the hub offers it — an
            `outdated` arm and the hub's own stack do not get it. */}
        {failure?.offered === true && errorOpenId !== null ? (
          <>
            {skippedPicker(skipped, errorOpenId)}
            <ComposeSelection
              key={errorOpenId}
              hostId={hostId}
              containerId={errorOpenId}
              containerName={nameOf(errorOpenId)}
              onChanged={afterSelection}
            />
          </>
        ) : null}
      </div>
    );
  }

  if (file === null || anchorId === null) return <p className="text-muted-foreground" data-testid="compose-loading">{t("loading")}</p>;
  const skipped = lookup.data?.skipped ?? [];

  const beginEdit = (): void => {
    if (draft === null) setDraft(content);
    setApplied(null);
    setPane("edit");
  };

  // Den Stand neu lesen, NACHDEM die Übersicht neu gelesen ist — siehe
  // `awaitedRevision`. Der Entwurf ist dabei erledigt: angewandt oder in
  // unbekanntem Zustand, in beiden Fällen gilt, was jetzt auf dem Host steht.
  const refreshAfterApply = (): void => {
    setDraft(null);
    setPane("file");
    // Dropped and not reset: the ids of the cached answer are gone, and a
    // reset would ask at once with them (`useComposeFileReload`).
    forget();
    setAwaitedRevision(revision);
    onStackChanged();
  };

  const discard = (): void => {
    setDraft(null);
    setPane("file");
  };

  const singleFilePane = activeFile === "env" || pane === "file" || pane === "edit";

  return (
    <div className="flex flex-col gap-3" data-testid="compose-view">
      {applied === null ? null : <AppliedNotice resync={applied} />}
      <div className={cn("flex flex-col gap-3", singleFilePane && "compose-single-file")}>
        <Card className="gap-0 overflow-hidden border-accent-line py-0 text-[13px]">
          <div className="flex flex-wrap items-stretch border-b border-accent-line bg-accent-firm">
            <div role="group" aria-label={t("composeFileTabs")} className="flex min-w-0 flex-wrap">
            <button type="button" aria-pressed={activeFile === "compose"} onClick={() => setActiveFile("compose")} disabled={pane === "apply"} className={cn("flex min-w-0 items-center gap-2 border-r border-r-accent-line px-3 py-2 font-semibold", activeFile === "compose" ? "bg-primary text-primary-foreground" : "text-accent-foreground hover:bg-accent-strong")}>
              <FileCode2 aria-hidden="true" className="size-4 shrink-0" />
              <span className="truncate">{file.composeFileName}</span>
              {dirty ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-state-warn" /> : null}
            </button>
            <button type="button" aria-pressed={activeFile === "env"} onClick={() => { setActiveFile("env"); setPane("file"); }} disabled={pane === "apply"} className={cn("flex items-center gap-2 border-r border-r-accent-line px-3 py-2 font-semibold", activeFile === "env" ? "bg-primary text-primary-foreground" : "text-accent-foreground hover:bg-accent-strong")}>
              <FileKey2 aria-hidden="true" className="size-4 shrink-0" />
              {t("composeEnvFileName")}
            </button>
            </div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2 px-3 py-1.5">
              {/* ⚠️ Beim eigenen Stack des Hubs (#183) und bei fremdverwalteten
                  Stacks (#56) gibt es den Knopf nicht — nicht ausgegraut, sondern
                  weg: der Hinweis darunter sagt warum. */}
              {activeFile === "compose" && pane === "file" && !file.hubOwnStack && !file.externallyManaged ? (
                <Button size="sm" className="font-semibold shadow-[0_0_14px_var(--accent-strong)]" disabled={!file.fileReadable} onClick={beginEdit}>
                  <Pencil data-icon="inline-start" aria-hidden="true" />
                  {t("composeEdit")}
                </Button>
              ) : null}
              {/* The selection of the anchor (#185). Only without a draft: a
                  selection fetches the file again and would take it along. */}
              {activeFile === "compose" && pane === "file" && draft === null && file.selectionSupported ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="border-accent-line bg-accent-firm text-accent-foreground hover:bg-accent-strong hover:text-accent-foreground dark:border-accent-line dark:bg-accent-firm dark:hover:bg-accent-strong"
                  data-testid="compose-selection-open"
                  aria-pressed={selecting === anchorId}
                  onClick={() => setSelecting(selecting === anchorId ? null : anchorId)}
                >
                  <Link2 data-icon="inline-start" aria-hidden="true" />
                  {t("composeSelectionOpen")}
                </Button>
              ) : null}
              {/* ⚠️ DIE TASTENBELEGUNG BRAUCHT EINEN ORT FÜR DEN ZEIGER (#157).
                  Seit #135 rückt Tab im Editor ein; der Satz dazu stand bis hierher
                  nur in einem `sr-only`-Absatz am Feld. Wer mit der Maus im Feld
                  landet, bekam eine Einrückung, mit der er nicht gerechnet hat, und
                  fand nirgends, wie er wieder herauskommt.

                  ⚠️ DERSELBE SCHLÜSSEL WIE AM FELD und keine zweite Fassung. Der
                  Tooltip zeigt `composeEditKeyboardHint`, und `ComposeEditor`
                  beschreibt sein Textfeld mit demselben Text. Zwei Fassungen
                  wären zwei Wahrheiten — die ungelesene veraltet still.

                  ⚠️ DER AUSLÖSER BLEIBT IN DER TAB-REIHENFOLGE. Ihn
                  herauszunehmen wäre naheliegend, weil die Vorlesehilfe den Satz
                  am Feld ohnehin bekommt; es nähme aber genau demjenigen den
                  Zugang, um dessen Bedienung es hier geht. Radix öffnet den
                  Tooltip auch bei Fokus, und der Knopf trägt keine Handlung: er
                  kostet einen Tab-Halt und gibt dafür den Satz. */}
              {activeFile === "compose" && pane === "edit" ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button size="icon-sm" variant="ghost" data-testid="compose-keyboard-hint">
                      <Keyboard aria-hidden="true" />
                      <span className="sr-only">{t("composeEditKeyboardTitle")}</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[320px]">{t("composeEditKeyboardHint")}</TooltipContent>
                </Tooltip>
              ) : null}
              {activeFile === "compose" && pane === "edit" ? (
                <Button size="sm" variant="secondary" className="bg-accent-strong text-accent-foreground hover:bg-accent-firm" data-testid="compose-show-diff" onClick={() => setPane("diff")}>
                  {t("composeShowDiff")}
                </Button>
              ) : null}
              {activeFile === "compose" && (pane === "diff" || pane === "apply") ? (
                <Button size="sm" variant="secondary" className="bg-accent-strong text-accent-foreground hover:bg-accent-firm" data-testid="compose-back-to-edit" onClick={() => setPane("edit")}>
                  {t("composeBackToEdit")}
                </Button>
              ) : null}
              {/* ⚠️ „Anwenden" FÜHRT ZUERST IN DIE VORSCHAU und nicht in den
                  Aufruf. Der Wunsch aus #35 ist genau das: sehen, was gleich
                  passiert, bevor es passiert. Der Knopf steht nur da, wenn es
                  etwas anzuwenden GIBT — ein Knopf, der bei jedem Druck „nichts
                  geändert" antwortet, ist ein totes Bedienelement. */}
              {activeFile === "compose" && (pane === "edit" || pane === "diff") && dirty ? (
                <Button size="sm" className="font-semibold shadow-[0_0_14px_var(--accent-strong)]" data-testid="compose-to-apply" onClick={() => setPane("apply")}>
                  {t("composeApply")}
                </Button>
              ) : null}
              {/* ⚠️ „Neu laden" NIMMT DEN ENTWURF MIT, und deshalb steht es hinter
                  einer Rückfrage, sobald etwas zu verlieren ist. Ohne sie kostete
                  ein Fehlgriff die Arbeit von zehn Minuten. */}
              {activeFile === "compose" && draft !== null ? (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="compose-discard"
                  onClick={() => {
                    if (!dirty || window.confirm(t("composeDiscardConfirm"))) discard();
                  }}
                >
                  {t("composeDiscard")}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                className="border-accent-line bg-accent-firm text-accent-foreground hover:bg-accent-strong hover:text-accent-foreground dark:border-accent-line dark:bg-accent-firm dark:hover:bg-accent-strong"
                data-testid="compose-reload"
                onClick={() => {
                  if (!dirty || window.confirm(t("composeDiscardConfirm"))) {
                    setApplied(null);
                    setDraft(null);
                    reload();
                  }
                }}
              >
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
                {t("composeReload")}
              </Button>
            </div>
          </div>
          {activeFile === "compose" ? <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-accent-line bg-accent px-3 py-1.5">
            <span className="min-w-0 truncate font-mono text-[12px] text-muted-foreground" title={file.projectDir}>
              {file.projectDir}
            </span>
            {/* ⚠️ Die Zahl der Services MIT Container und die der Datei stehen
                NEBENEINANDER, wo sie sich unterscheiden. Eine Abweichung ist
                Zustand und kein Fehler — ein Service, den die Datei nennt und zu
                dem es keinen Container gibt, ist genau der Fall, den das Anwenden
                später ausdrücklich bestätigen lässt. */}
            <Badge variant="secondary" className="border-accent-line bg-accent-firm text-accent-foreground">
              {file.services.length === file.servicesInFile.length
                ? t("composeServiceCount", { count: file.services.length })
                : t("composeServiceCountDiffers", {
                    running: file.services.length,
                    inFile: file.servicesInFile.length
                  })}
            </Badge>
            {dirty ? (
              <span data-testid="compose-dirty" className="text-[12px] text-state-warn">
                {t("composeUnsaved")}
              </span>
            ) : null}
          </div> : null}
          {activeFile === "env" ? <EnvView hostId={hostId} containerId={anchorId} /> : null}
          {activeFile === "compose" && file.fileReadable && pane === "file" ? (
            <YamlCode text={content} className="max-h-[70vh] overflow-y-auto py-3" />
          ) : null}
          {activeFile === "compose" && file.fileReadable && pane === "edit" ? (
            <div className="h-[70vh]">
              <ComposeEditor value={draft ?? content} onChange={setDraft} />
            </div>
          ) : null}
        </Card>

        {/* ⚠️ `fileReadable: false` HEISST NICHT „LEER". Der Arm hat den Stack
            gefunden, aber die Datei nicht lesen können — der Inhalt wäre dann
            leer, und eine Fläche, die das ungesagt anzeigt, behauptet eine leere
            Compose-Datei. Bearbeiten ist in diesem Fall gesperrt: was man
            schriebe, überschriebe einen Stand, den niemand gesehen hat. */}
        {activeFile === "compose" && !file.fileReadable ? (
          <Card className="p-4">
            <p className="text-[13px] text-destructive">{t("composeUnreadable")}</p>
          </Card>
        ) : null}

        {activeFile === "compose" && file.hubOwnStack ? (
          <Card className="p-4" data-testid="compose-hub-own-stack">
            <p className="text-[13px] text-muted-foreground">{t("composeHubOwnStack")}</p>
          </Card>
        ) : null}

        {activeFile === "compose" && file.externallyManaged ? (
          <Card className="p-4" data-testid="compose-externally-managed">
            <p className="text-[13px] text-muted-foreground">{t("composeExternallyManaged")}</p>
          </Card>
        ) : null}

        {activeFile === "compose" && file.selectionSupported && skipped.length > 0
          ? skippedPicker(skipped, selecting)
          : null}
        {activeFile === "compose" && file.selectionSupported && selecting !== null ? (
          <ComposeSelection
            key={selecting}
            hostId={hostId}
            containerId={selecting}
            containerName={nameOf(selecting)}
            onChanged={afterSelection}
            onClose={() => setSelecting(null)}
          />
        ) : null}
      </div>

      {/* ⚠️ DER VERGLEICH BLEIBT AUCH BEIM ANWENDEN SICHTBAR. Was der Betreiber
          bestätigt, ist das, was er im Vergleich gesehen hat — die Vorschau
          über den Vergleich zu legen nähme ihm den Gegenstand seiner
          Bestätigung weg. */}
      {activeFile === "compose" && file.fileReadable && pane === "apply" ? (
        <ComposeApply
          hostId={hostId}
          containerId={anchorId}
          draft={draft ?? content}
          expectedComposeHash={file.composeHash}
          changed={dirty}
          onApplied={(resync) => {
            // ⚠️ NEU LADEN UND NICHT BLOSS ZURÜCKSCHALTEN. Nach dem Anwenden
            // hat die Datei einen anderen Hash; ein Editor, der auf dem alten
            // weiterarbeitet, bekommt beim nächsten Versuch
            // `file-changed-externally`.
            setApplied(resync);
            refreshAfterApply();
          }}
          onReload={() => {
            setApplied(null);
            refreshAfterApply();
          }}
          onClose={() => setPane("edit")}
        />
      ) : null}

      {activeFile === "compose" && file.fileReadable && comparison !== null ? (
        <Card className="overflow-hidden p-0">
          <div className="flex items-center gap-4 border-b border-border px-4 py-2 text-[13px]">
            <span className="font-medium">{t("composeDiffTitle")}</span>
            <span className="text-muted-foreground">
              {t("composeDiffCount", { added: comparison.added, removed: comparison.removed })}
            </span>
            {/* ⚠️ EINE Rechnung, zwei Anordnungen. Der Schalter entscheidet
                nur, wie das Ergebnis angeordnet wird — zwei Rechnungen wären
                zwei Wahrheiten darüber, was sich geändert hat. */}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              data-testid="compose-diff-layout"
              onClick={() => setSide((value) => !value)}
            >
              {side ? t("composeDiffUnified") : t("composeDiffSideBySide")}
            </Button>
          </div>
          <div className="max-h-[70vh] overflow-y-auto py-2">
            <DiffView result={comparison} side={side} />
          </div>
        </Card>
      ) : null}
    </div>
  );
}
