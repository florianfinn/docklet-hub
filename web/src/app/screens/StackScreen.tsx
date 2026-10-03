import { ChevronLeft } from "lucide-react";
import type { Messages } from "use-intl";
import { lazy, Suspense, useCallback, useState } from "react";
import { Link, useParams } from "react-router";
import { useTranslations } from "use-intl";

import type { IndentName, MarkView } from "contract";

import type { HostOverview, StackView } from "contract";
import type { Role } from "../../platform/session/session-user";
import { Card } from "../../platform/ui/shadcn/card";
import { hostDisplay } from "../../domain/hosts";
import {
  MarkAssign,
  MarkList,
  setStackIndent,
  setStackMarks,
  useMarks,
  withStackIndent,
  withStackMarks
} from "../../features/marks";
import { OVERVIEW_SLOTS } from "../containers/container-slots";
import { ContainerList, ContainerStateDot, useOverview, useOverviewUpdate } from "../../features/containers";
import { StackIndentSwitch } from "./stack/StackIndentSwitch";
import { detailPageClass } from "./detail-page";
import { stackPath, type StackTab } from "../../platform/routes/stack-path";

// ⚠️ LOADED LAZILY (#258, #265), like the log view of a container.
const StackLogView = lazy(() => import("../../features/logs/StackLogView.lazy"));
const ComposeView = lazy(() => import("../../features/compose/ComposeView.lazy"));

// Die Seite EINES Stacks (D6b, #62). Sie trägt die Farbe ihres Hosts, den
// Namen des Stacks, seinen zusammengefassten Zustand und die Zahl der
// laufenden — dazu die Container-Liste (Artboard hub-palette.html Z. 660–699).
//
// ⚠️ SEIT #35 MIT REITERLEISTE, seit #183 mit DREI Einträgen. Das Artboard
// zeigt fünf neben der Übersicht (Z. 674–681); gebaut sind davon Protokoll
// und Compose. Umgebung, Betrieb und Verlauf gibt es nicht, und die Regel des
// Projekts lautet: was es noch nicht gibt, erscheint nicht. Ein ausgegrauter
// Reiter ist ein Versprechen, das die Fläche nicht halten kann.
//
// ⚠️ DER COMPOSE-REITER STEHT NUR FÜR DEN ADMIN. Alle drei Compose-Routen
// tragen `requireAdmin` als erste Zwischenschicht — eine Compose-Datei nennt
// Pfade, Bind-Mounts und Ports eines fremden Rechners, sie zu lesen ist keine
// Auskunft, sondern eine Karte. Ein Reiter, der für einen Benutzer ohne Rolle
// sichtbar wäre, führte in eine `403`; dieselbe Behandlung wie beim
// Marken-Griff eine Zeile weiter unten. Das Protokoll dagegen liest jede
// Rolle (docs/design/phase-5-write-access.md §4) — bis #183 stand die ganze
// Leiste nur für den Admin, weil sie außer der Übersicht nur Compose trug.
//
// ⚠️ Die Tafel „Was hier zum Stack gehört" (Z. 700–713) ist ebenfalls nicht
// gebaut: sie erklärt im Artboard, was später dazukommt, und ist eine
// Erklärung des Bildes und kein Bauteil.
//
// ⚠️ SEIT D7b/C2 IST SIE DER ORT, AN DEM DIE MARKEN EINES STACKS VERGEBEN
// WERDEN — und der seiner Einrückung. Warum hier und nicht an der Stack-Zeile
// der Übersicht: dort steckt die Marken-Liste in einem `button`
// (`CollapsibleTrigger`, `overview/StackRow.tsx`) und im Deepdive in einem `a`
// (`containers/StackSection.tsx`); ein Bedienelement darin wäre verschachtelte
// Bedienung und ungültiges HTML. Hier steht sie in einer schlichten
// Überschrift, hier ist Platz, und hier stehen ihre Marken ohnehin schon ohne
// Deckel. Zwei Wege zum selben Ziel wären zudem zwei Stellen, die auseinander
// laufen.
//
// ⚠️ KEINE EIGENE ABFRAGE. Die Seite liest `GET /api/overview` wie die beiden
// Listen und sucht ihren Stack darin. Das ist mehr Antwort als nötig — und
// trotzdem richtig: ein zweiter Endpunkt für denselben Stack wäre eine zweite
// Zusammenfassung, und die beiden wichen beim ersten Sonderfall voneinander
// ab. Ein eigener Endpunkt gehört zu dem Paket, das auch die Reiter bringt.

type Found = { host: HostOverview; stack: StackView };

// ⚠️ Nicht gefunden ist der NORMALFALL und kein Fehler: die Adresse hängt am
// Paar aus Host-Kennung und Compose-Projekt, und beides kann verschwinden —
// der Host gelöscht, der Stack gestoppt. Deshalb drei Zustände und nicht zwei:
// „wird geholt", „gibt es nicht", „hier ist er".
function findStack(hosts: HostOverview[], hostId: string, project: string): Found | null {
  const host = hosts.find((entry) => entry.host.id === hostId);
  if (host === undefined) return null;
  const stack = host.stacks.find((entry) => entry.project === project);
  return stack === undefined ? null : { host, stack };
}

// Die Reiter, in der Reihenfolge, in der sie stehen.
//
// ⚠️ Eine Liste und keine zwei hingeschriebenen Verweise — dieselbe
// Begründung wie an der Container-Seite: die Leiste zeichnet daraus ihre
// Einträge und vergleicht den geltenden Reiter EINMAL. Zwei hingeschriebene
// Verweise trügen die Auszeichnung „aktiv" zweimal.
//
// ⚠️ DIE REIHENFOLGE IST DIE DES ARTBOARDS (Übersicht · Protokoll · Compose),
// und `adminOnly` steht am Eintrag statt in einer zweiten Liste: die Leiste
// filtert EINMAL, und ein Reiter kann nicht in der einen Liste stehen und in
// der anderen fehlen.
const TABS: { id: StackTab; labelKey: keyof Messages; adminOnly: boolean }[] = [
  { id: "overview", labelKey: "stackTabOverview", adminOnly: false },
  { id: "logs", labelKey: "stackTabLogs", adminOnly: false },
  { id: "compose", labelKey: "stackTabCompose", adminOnly: true }
];

export function StackScreen({ role, tab }: { role: Role; tab: StackTab }) {
  const t = useTranslations();
  // ⚠️ Der Wert kommt DEKODIERT herein — react-router nimmt das ab
  // (`decodePath`, siehe stack/stack-path.ts). Ein zweites
  // `decodeURIComponent` machte aus einem Projektnamen mit Prozentzeichen
  // lautlos einen anderen Namen.
  const { hostId = "", project = "" } = useParams();
  // The overview through the cache the overview screen and the container list
  // share (`useOverview`, #282); until #271 this screen loaded it in its own
  // effect. Every mount asks the arms again (stale time zero), as before.
  const overview = useOverview();
  const updateOverview = useOverviewUpdate();
  const hosts: HostOverview[] | null = overview.data ?? null;
  const failed = overview.isError;
  const [composeDirty, setComposeDirty] = useState(false);
  // Die Marken des Hubs — die AUSWAHL, aus der zugeordnet wird. `null` heißt
  // „noch nicht da“ und ist nicht dasselbe wie „es gibt keine“.
  // ⚠️ Ein Benutzer ohne Adminrolle sieht die Marken dieses Stacks, aber
  // keinen Griff daran: die drei Schreibrouten stehen hinter `requireAdmin`.
  // Dieselbe Behandlung wie in `features/marks/MarksPanel.tsx` — er bekommt kein
  // totes Bedienelement, das im 403 endet.
  const editable = role === "admin";

  // ⚠️ DIE ÜBERSICHT WIRD NACH EINEM ANWENDEN NEU GELESEN (#233): `compose up`
  // ersetzt die Container, und der Compose-Reiter fragt mit ihren Kennungen.
  // `reloadOverview` stößt an, `revision` sagt, welche Lesung angekommen ist —
  // auch eine gescheiterte, sonst wartete der Reiter auf etwas, das nicht
  // kommt. Die alte Übersicht bleibt bis dahin stehen.
  //
  // Since #271 the revision is read off the query: each completed read moves
  // `dataUpdatedAt` (an answer) or `errorUpdatedAt` (a failure), so their sum
  // changes exactly when a read has arrived. `refetch` keeps the data on the
  // screen while it asks.
  const revision = overview.dataUpdatedAt + overview.errorUpdatedAt;
  const { refetch } = overview;
  const reloadOverview = useCallback(() => void refetch(), [refetch]);

  // ⚠️ Ein EIGENER Abruf und kein Feld der Übersicht: `GET /api/overview`
  // liefert je Ziel die ZUGEORDNETEN Marken und nicht den Vorrat des Hubs.
  // Ohne ihn stünden in der Auswahl nur die Marken, die dieser Stack schon
  // trägt — und keine ließe sich hinzufügen.
  //
  // ⚠️ Er läuft nur für den Admin. Ein Benutzer ohne Rolle bekommt hier kein
  // Bedienelement, und ein Abruf für eine Liste, die niemand sieht, ist eine
  // Anfrage ohne Leser. Schlägt er fehl, bleibt `hubMarks` auf `null` und die
  // Auswahl sagt „wird geholt“ — die Seite selbst steht davon unberührt da.
  const hubMarks = useMarks({ enabled: editable }).data ?? null;

  const found = hosts === null ? null : findStack(hosts, hostId, project);

  // ⚠️ Der Server antwortet mit dem GESPEICHERTEN Stand, und der wird hier in
  // die Antwort eingetragen, die die Seite schon hält — kein zweiter Abruf und
  // ausdrücklich kein `window.location.reload()`. Die Funktionen sind rein und
  // liegen in `marks/overview-marks.ts`, weil der Deepdive dieselbe Antwort
  // genauso fortschreibt.
  const applyMarks = (marks: MarkView[]) => updateOverview((current) => withStackMarks(current, hostId, project, marks));
  const applyIndent = (indent: IndentName) =>
    updateOverview((current) => withStackIndent(current, hostId, project, indent));

  return (
    <div className={detailPageClass(tab === "logs")}>
      {/* Der Rücksprung des Artboards (Z. 665). Er steht ÜBER der Überschrift
          und nicht in der Seitenleiste: diese Seite hat keinen
          Navigationseintrag, und ohne ihn führte nur der Zurück-Knopf des
          Browsers heraus. */}
      <Link
        to="/"
        className="flex w-fit items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft aria-hidden="true" className="size-3.5" />
        {t("stackBack")}
      </Link>

      {failed ? <p className="text-sm text-destructive">{t("containersFailed")}</p> : null}
      {!failed && hosts === null ? <p className="text-muted-foreground">{t("loading")}</p> : null}

      {hosts !== null && found === null ? (
        <div>
          <h1 className="text-[20px] font-medium tracking-[-0.022em]">{t("stackNotFoundTitle")}</h1>
          <p className="mt-1 max-w-prose text-[13px] text-muted-foreground">{t("stackNotFoundBody")}</p>
        </div>
      ) : null}

      {found !== null ? (
        <>
          {/* ⚠️ DIE LEISTE STEHT ÜBER DER FLÄCHE UND UNTER DEM KOPF, und sie
              erscheint erst, wenn der Stack GEFUNDEN ist: eine Reiterleiste
              über „Diesen Stack gibt es nicht" böte Wege zu einer Seite, die es
              nicht gibt.

              ⚠️ Verweise und keine Knöpfe, aus demselben Grund wie an der
              Container-Seite: der Reiter steht in der ADRESSE. Ein Neuladen
              landet wieder dort, wo der Mensch war — und im Compose-Reiter
              hängt daran ein Entwurf, den er nicht neu tippen soll.

              ⚠️ ABSICHTLICH NICHT `ui/shadcn/tabs.tsx`. Radix führt den aktiven
              Reiter in einem eigenen Zustand und zeichnet `button`s; die
              Adresse wüsste davon nichts. */}
          <nav aria-label={t("stackTabsLabel")} className="flex gap-1 border-b border-border">
              {TABS.filter((entry) => editable || !entry.adminOnly).map((entry) => (
                <Link
                  key={entry.id}
                  to={stackPath(hostId, project, entry.id)}
                  onClick={(event) => {
                    if (entry.id !== tab && composeDirty && !window.confirm(t("composeDiscardConfirm"))) {
                      event.preventDefault();
                    }
                  }}
                  aria-current={entry.id === tab ? "page" : undefined}
                  data-testid={`stack-tab-${entry.id}`}
                  className={
                    entry.id === tab
                      ? "-mb-px border-b-2 border-foreground px-3 py-1.5 text-[13px] font-medium text-foreground"
                      : "-mb-px border-b-2 border-transparent px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground"
                  }
                >
                  {t(entry.labelKey)}
                </Link>
              ))}
            </nav>

          {/* ⚠️ NUR DER GELTENDE REITER WIRD EINGEHÄNGT, und das ist eine
              Zusage und keine Sparmaßnahme: `ComposeView` holt seine Datei,
              sobald es eingehängt ist, und jeder dieser Abrufe schreibt einen
              Audit-Eintrag auf dem Arm. Ein `hidden` versteckte die Fläche und
              schickte die Anfrage trotzdem. */}
          {/* ⚠️ Ein Benutzer ohne Adminrolle, der die Compose-Adresse von Hand
              aufruft, landet auf der Übersicht — derselbe Weg wie bis #183. */}
          {tab === "overview" || (tab === "compose" && !editable) ? (
            <StackDetail
              found={found}
              hubMarks={hubMarks}
              editable={editable}
              onMarksChange={async (markIds) => applyMarks(await setStackMarks(hostId, project, markIds))}
              onIndentChange={async (indent) => applyIndent(await setStackIndent(hostId, project, indent))}
            />
          ) : null}

          {/* Der Reiter „Protokoll" (#183). Er bekommt die Container des
              Stacks und entscheidet selbst, welche er öffnet, siehe
              `StackLogView`. Den Zustandspunkt reicht diese Seite hinein:
              ein Feature importiert keine andere Fläche (#258). */}
          {tab === "logs" ? (
            <Suspense fallback={<p className="text-[13px] text-subtle-foreground">{t("logViewLoading")}</p>}>
              <StackLogView
                hostId={hostId}
                containers={found.stack.containers}
                stateDot={(container) => <ContainerStateDot state={container.state} />}
              />
            </Suspense>
          ) : null}

          {/* ⚠️ DIE CONTAINER-KENNUNGEN SIND DIE KANDIDATEN FÜR DEN ANKER, in
              der Reihenfolge des Stacks. Der Agent löst das Projektverzeichnis
              aus den Labels eines Containers auf; ein Stack hat im Hub keine
              Kennung. `ComposeView` fragt sie der Reihe nach und nimmt den
              ersten, dessen Datei der Arm liefert (#183) — in fester
              Reihenfolge, damit zwei Aufrufe hintereinander denselben
              Audit-Eintrag erzeugen. */}
          {/* ⚠️ The key binds the draft to ONE stack (#286). Moving to the
              compose tab of another stack keeps this route mounted, and
              without the key React reuses the view: the draft typed for stack
              A stayed in the editor while file, anchor and hash came from B.
              Host and project, not the container ids: those change within the
              same stack after an apply (#233), and that must keep the view. */}
          {tab === "compose" && editable ? (
            <Suspense fallback={<p className="text-muted-foreground">{t("loading")}</p>}>
              <ComposeView
                key={JSON.stringify([hostId, project])}
                hostId={hostId}
                containers={found.stack.containers.map((container) => ({ id: container.id, name: container.name }))}
                revision={revision}
                onStackChanged={reloadOverview}
                onDirtyChange={setComposeDirty}
              />
            </Suspense>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// Die Fläche selbst. Getrennt, damit oben die Frage „habe ich den Stack" steht
// und hier die Frage „wie sieht er aus" — und damit `found` hier nicht mehr
// `null` sein kann.
type StackDetailProps = {
  found: Found;
  hubMarks: MarkView[] | null;
  editable: boolean;
  onMarksChange: (markIds: string[]) => Promise<void>;
  onIndentChange: (indent: IndentName) => Promise<void>;
};

function StackDetail({ found, hubMarks, editable, onMarksChange, onIndentChange }: StackDetailProps) {
  const t = useTranslations();
  const { host, stack } = found;
  // Aus der Ablage, nicht aus der Kennung (D7a).
  const display = hostDisplay(host.host);

  return (
    // ⚠️ Dieselben drei Attribute wie an jeder Host-Karte — `data-host`,
    // `data-hue`, `data-ink`. Die Ableitungsregel in web/src/platform/theme/palette.css
    // rechnet daraus die Palette DIESES Teilbaums; eine Variable löst dort
    // auf, wo sie deklariert ist. Ohne sie trüge die Seite den Grundton des
    // Hauses, und „die Seite eines Stacks trägt die Farbe ihres Hosts"
    // (docs/design/hub-color-and-structure.md §5) bliebe eine Behauptung.
    <div
      data-host={host.host.id}
      data-hue={display.hue}
      data-ink={display.ink}
      className="flex max-w-4xl flex-col gap-4"
    >
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2.5">
          <ContainerStateDot state={stack.state} className="size-[9px]" />
          <h1 className="font-mono text-[20px] font-medium tracking-[-0.022em]">{stack.project}</h1>
          {/* ⚠️ OHNE DECKEL, und das ist der Unterschied zu den drei Zeilen.
              „Die Seite eines Stacks trägt die Farbe ihres Hosts und die Marke
              des Stacks" (docs/design/hub-color-and-structure.md §5) — wer sie
              öffnet, will diesen Stack sehen, und hier ist Platz. Ein „+3" auf
              der Fläche, die den Stack ausführlich zeigt, verlangte einen
              weiteren Klick für etwas, das danebenstehen kann.

              Das umgebende `div` trägt schon `flex-wrap`; `MarkList` bekommt
              es dazu, damit die Marken untereinander umbrechen und nicht als
              Block neben der Überschrift kleben. */}
          <MarkList marks={stack.marks} className="flex-wrap" />
          {/* ⚠️ Der Griff steht NEBEN der Marken-Liste und in einer schlichten
              Überschrift — nicht in einem Knopf und nicht in einem Verweis. Das
              umgebende `div` trägt keines von beidem; die Fälle, in denen es
              das täte, sind die Stack-ZEILEN, und die tragen deshalb keinen
              Griff. */}
          {editable ? (
            <MarkAssign
              assigned={stack.marks}
              available={hubMarks}
              label={t("markAssignForStack", { project: stack.project })}
              triggerText={t("markAssignAction")}
              testId="stack-marks"
              onChange={onMarksChange}
            />
          ) : null}
        </div>
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-subtle-foreground">
          <span>{t("stackOnHost", { host: host.host.name })}</span>
          <span aria-hidden="true">·</span>
          {/* ⚠️ Die Zahl der LAUFENDEN steht hier nicht noch einmal: sie
              steht im Kopf der Container-Liste, so wie im Artboard (Z. 694).
              Zweimal dieselbe Zahl auf einer Fläche ist keine Betonung,
              sondern eine Stelle mehr, an der beim nächsten Umbau eine von
              beiden falsch wird. */}
          <span>{t("hostContainersCount", { count: stack.total })}</span>
        </p>
      </div>

      {/* Die Einrückung dieses Stacks — dieselbe Sache, dieselbe Fläche,
          dieselbe Kennung wie seine Marken. Sie steht unter dem Kopf und nicht
          in ihm: sie ist eine Einstellung des Stacks und keine Aussage über
          seinen Zustand. */}
      {editable ? <StackIndentSwitch indent={stack.indent} onChange={onIndentChange} /> : null}

      <Card className="gap-0 overflow-hidden border-card-line bg-body-face py-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-head-face px-4 py-2.5">
          <span className="text-sm font-medium">{t("stackContainersTitle")}</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {t("stackRunningOf", { running: stack.running, total: stack.total })}
          </span>
        </div>
        <div className="p-2">
          {/* Ungefiltert: diese Seite IST der Stack, es gibt nichts
              einzuschränken. Die Gruppe der fremdverwalteten Container steht
              wie überall am Ende — ContainerList trennt sie ab. */}
          <ContainerList containers={stack.containers} hostId={host.host.id} slots={OVERVIEW_SLOTS} />
        </div>
      </Card>
    </div>
  );
}
