import { ChevronLeft } from "lucide-react";
import { lazy, Suspense, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { useTranslations, type Messages } from "use-intl";

import { useGlobalTheme } from "../../features/appearance";
import type { HostOverview, OverviewContainer, StackView } from "contract";
import { useLanguage } from "../../platform/i18n";
import { cn } from "../../platform/ui/lib/cn";
import { Card } from "../../platform/ui/shadcn/card";
import { formatSignInTime } from "../../platform/i18n/last-sign-in";
import { ContainerMetrics } from "../../features/metrics";
import { containerPath, type ContainerTab } from "../../platform/routes/container-path";
import { detailPageClass } from "./detail-page";
import { hostDisplay } from "../../domain/hosts";
import { MarkList } from "../../features/marks";
import { LifecycleControls, ContainerStateDot, isUnknownManager, managerName, useOverview } from "../../features/containers";
import { stackPath } from "../../platform/routes/stack-path";

// ⚠️ LOADED LAZILY (#258): the log view, its line renderer and the stream
// store are a chunk of their own, fetched when the tab opens. Through the
// door `features/logs/index.ts` it would sit in the main chunk.
const LogView = lazy(() => import("../../features/logs/LogView.lazy"));
const ShellView = lazy(() => import("../../features/shell/ShellView.lazy"));
const FilesView = lazy(() => import("../../features/files/FilesView.lazy"));

// Die Detailseite EINES Containers mit ihren zwei Reitern (#5, Etappe H3).
//
// ⚠️ DER REITER STEHT IN DER ADRESSE UND NICHT IN EINEM ZUSTAND DIESER DATEI
// (Entscheidung des Betreibers vom 2026-09-07). `/container/:hostId/:name`
// zeigt die Übersicht, `/container/:hostId/:name/logs` das Protokoll. Ein
// Lesezeichen und ein Neuladen landen damit wieder dort, wo der Mensch war —
// bei einer Fehlersuche ist genau das der Normalfall: man lädt neu, weil man
// dem Bild nicht traut, und will danach wieder auf das Protokoll schauen.
//
// ⚠️ WELCHER REITER GILT, KOMMT ALS EIGENSCHAFT VON DER ROUTE und wird nicht
// aus `useLocation()` zurückgerechnet. Die beiden Routen stehen ohnehin
// nebeneinander in `web/src/app/routes/AppRoutes.tsx`; dort steht die Zuordnung
// „diese Adresse zeigt jenen Reiter" einmal, sichtbar und vom Wächter
// `web/tests/screen-switching.test.mjs` gelesen. Ein Vergleich auf das Ende
// der Adresse wäre eine zweite Fassung derselben Aussage — und die erste, die
// beim nächsten Reiter vergessen wird.
//
// ⚠️ DIE ADRESSE HÄNGT AM NAMEN, DIE ANFRAGE AN DER KENNUNG. Der Name steht in
// der Adresse, weil er das nächste `compose up` überlebt; die Kennung tut das
// nicht. `LogView` bekommt trotzdem die KENNUNG, denn der Agent führt seine
// Allowlist über Kennungen. Aufgelöst wird der Name genau hier, aus derselben
// Antwort, aus der auch der Rest der Fläche kommt (die ausführliche Begründung
// steht in `container/container-path.ts`).
//
// ⚠️ KEINE EIGENE ABFRAGE, sondern `GET /api/overview` wie die Stack-Seite.
// Das ist mehr Antwort als nötig und trotzdem richtig: ein zweiter Endpunkt
// für denselben Container wäre eine zweite Zusammenfassung, und die beiden
// wichen beim ersten Sonderfall voneinander ab. Er gehört zu dem Paket, das
// auch die Reiter Compose, Umgebung und Verlauf bringt.
//
// ⚠️ KEIN GEMEINSAMER HAKEN für „holen, suchen, drei Zustände". Es gibt im
// Bestand keinen, und einer, der hier entstünde, hätte zwei Benutzer mit
// verschiedenen Suchen (Stack über das Paar Host/Projekt, Container über den
// Namen quer durch Stacks UND die Container ohne Stack). Der zweite Benutzer
// ist der Beweis, dass die Abstraktion trägt — er fehlt noch.

type Found = { host: HostOverview; container: OverviewContainer; stack: StackView | null };

// ⚠️ „Diesen Container gibt es nicht" IST EIN NORMALFALL UND KEIN FEHLER: die
// Adresse hängt am Namen, und ein Container kann seit dem letzten Laden
// entfernt, umbenannt oder aus der Allowlist des Arms genommen worden sein.
// Deshalb drei Zustände und nicht zwei — „wird geholt", „gibt es nicht", „hier
// ist er" —, so wie es die Stack-Seite mit `stackNotFoundTitle` tut. Ein roter
// Fehlertext schickte den Betreiber auf die Suche nach einer Störung, die es
// nicht gibt.
//
// ⚠️ Gesucht wird in den Stacks UND in `loose`. Ein Container ohne Compose
// steht nur in der zweiten Liste, und eine Suche allein über die Stacks fände
// ausgerechnet die von Hand gestarteten nicht — also die, bei denen man am
// ehesten ins Protokoll schaut.
function findContainer(hosts: HostOverview[], hostId: string, name: string): Found | null {
  const host = hosts.find((entry) => entry.host.id === hostId);
  if (host === undefined) return null;

  for (const stack of host.stacks) {
    const inStack = stack.containers.find((entry) => entry.name === name);
    if (inStack !== undefined) return { host, container: inStack, stack };
  }

  const loose = host.loose.find((entry) => entry.name === name);
  return loose === undefined ? null : { host, container: loose, stack: null };
}

// Die zwei Reiter, in der Reihenfolge, in der sie stehen.
//
// ⚠️ Eine Liste und keine zwei hingeschriebenen Verweise: die Leiste zeichnet
// daraus ihre Einträge und vergleicht den geltenden Reiter EINMAL. Zwei
// hingeschriebene Verweise trügen die Auszeichnung „aktiv" zweimal, und der
// dritte Reiter wäre eine dritte Kopie.
const TABS: { id: ContainerTab; labelKey: keyof Messages }[] = [
  { id: "overview", labelKey: "containerTabOverview" },
  { id: "logs", labelKey: "containerTabLogs" },
  // ⚠️ „Dateien" steht HINTER „Protokoll" (Paket B5, Etappe E5a, #5). Die
  // Reihenfolge ist die der Häufigkeit, mit der jemand hinschaut: man öffnet
  // einen Container, um ihn zu sehen, dann um sein Protokoll zu lesen, und erst
  // danach, um an seine Dateien zu gehen. Ein Reiter, der Schreibrechte
  // eröffnet, steht zudem nicht vor einem, der nur liest.
  { id: "files", labelKey: "containerTabFiles" },
  // ⚠️ „Shell" steht GANZ HINTEN (Paket B6, Etappe E6, #5). Dieselbe Ordnung
  // wie bei „Dateien" eine Zeile höher, nur eine Stufe weiter: sehen, lesen,
  // an die Dateien — und ganz zuletzt eine Shell. Sie ist der schreibendste
  // Zugriff, den dieser Hub kennt, und der einzige Reiter, der einen der VIER
  // Sitzungsplätze des Arms belegt, solange er offen ist.
  { id: "shell", labelKey: "containerTabShell" }
];

export function ContainerScreen({ tab }: { tab: ContainerTab }) {
  const t = useTranslations();
  // ⚠️ Der Wert kommt DEKODIERT herein — react-router nimmt das ab. Ein
  // zweites `decodeURIComponent` machte aus einem Namen mit Prozentzeichen
  // lautlos einen anderen (siehe `container/container-path.ts`).
  const { hostId = "", name = "" } = useParams();
  // The overview through the cache the overview screen and the container list
  // share (`useOverview`, #282); until #271 this screen loaded it in its own
  // effect. Every mount asks the arms again (stale time zero), as before.
  const overview = useOverview();
  const hosts: HostOverview[] | null = overview.data ?? null;
  const failed = overview.isError;

  const found = hosts === null ? null : findContainer(hosts, hostId, name);

  return (
    <div className={detailPageClass(tab === "logs")}>
      {/* Der Rücksprung. Er steht ÜBER der Überschrift und nicht in der
          Seitenleiste: diese Seite hat keinen Navigationseintrag, und ohne ihn
          führte nur der Zurück-Knopf des Browsers heraus. Beschriftet mit
          „Zurück zur Übersicht" und nicht bloß „Übersicht" wie auf der
          Stack-Seite — hier heißt schon ein Reiter so, und zwei gleich
          benannte Ziele auf einer Fläche sind eines zu viel. */}
      <Link
        to="/"
        className="flex w-fit items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft aria-hidden="true" className="size-3.5" />
        {t("containerBack")}
      </Link>

      {failed ? <p className="text-sm text-destructive">{t("containersFailed")}</p> : null}
      {!failed && hosts === null ? <p className="text-muted-foreground">{t("loading")}</p> : null}

      {hosts !== null && found === null ? (
        <div data-testid="container-not-found">
          <h1 className="text-[20px] font-medium tracking-[-0.022em]">{t("containerNotFoundTitle")}</h1>
          <p className="mt-1 max-w-prose text-[13px] text-muted-foreground">{t("containerNotFoundBody")}</p>
        </div>
      ) : null}

      {found !== null ? <ContainerDetail found={found} tab={tab} /> : null}
    </div>
  );
}

// Die Fläche selbst. Getrennt, damit oben die Frage „habe ich den Container"
// steht und hier die Frage „wie sieht er aus" — und damit `found` hier nicht
// mehr `null` sein kann.
function ContainerDetail({ found, tab }: { found: Found; tab: ContainerTab }) {
  const t = useTranslations();
  // ⚠️ Die Kennung des Arms kommt aus der GEFUNDENEN Antwort und nicht noch
  // einmal aus den Parametern der Route: gefunden wurde der Container über
  // genau diesen Arm, und eine zweite Quelle für dieselbe Kennung wäre eine,
  // die abweichen kann.
  const { host, container } = found;
  // Aus der Ablage, nicht aus der Kennung (D7a).
  const display = hostDisplay(host.host);

  return (
    // ⚠️ Dieselben drei Attribute wie an jeder Host-Karte und auf der
    // Stack-Seite — `data-host`, `data-hue`, `data-ink`. Die Ableitungsregel in
    // web/src/platform/theme/palette.css rechnet daraus die Palette DIESES Teilbaums;
    // eine Variable löst dort auf, wo sie deklariert ist. Ohne sie trüge die
    // Seite den Grundton des Hauses.
    <div data-host={host.host.id} data-hue={display.hue} data-ink={display.ink} className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2.5">
          <ContainerStateDot state={container.state} className="size-[9px]" />
          {/* Der VOLLSTÄNDIGE Name und nicht der Dienstname. In der Zeile
              eines Stacks steht der Dienst, weil das Projekt schon darüber
              steht; hier ist der Container der Gegenstand der Fläche, und der
              vollständige Name ist die Kennung, mit der man auf dem Arm
              arbeitet. */}
          <h1 className="font-mono text-[20px] font-medium tracking-[-0.022em]">{container.name}</h1>
          {/* Ohne Deckel, wie am Stack: wer diese Seite öffnet, will diesen
              Container sehen, und hier ist Platz. */}
          <MarkList marks={container.marks} className="flex-wrap" />
        </div>
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-subtle-foreground">
          <span>{t("containerOnHost", { host: host.host.name })}</span>
        </p>
      </div>

      {/* ⚠️ ZWEI VERWEISE UND KEIN BEDIENELEMENT IN EINEM ANDEREN. Die Leiste
          ist ein `nav` mit zwei `a` als Geschwistern; der geltende Reiter
          trägt `aria-current="page"` und nicht `disabled`. Ein Reiter, der
          seine eigene Adresse trägt, bleibt anklickbar — das ist der
          Neuladen-Weg, den ein Mensch erwartet, und ein abgeschaltetes
          Element wäre für die Tastatur zudem nicht mehr erreichbar.

          ⚠️ ABSICHTLICH NICHT `web/src/platform/ui/shadcn/tabs.tsx`. Radix führt den
          aktiven Reiter in einem eigenen Zustand und zeichnet `button`s; die
          Adresse wüsste davon nichts, und ein Neuladen fiele auf den ersten
          Reiter zurück. Genau das ist der Fall, den Entscheidung 1 des
          Betreibers ausschließt. */}
      <LifecycleControls target={{ kind: "container", hostId: host.host.id, container }} />
      <nav aria-label={t("containerTabsLabel")} className="flex gap-1 border-b border-border">
        {TABS.map((entry) => (
          <Link
            key={entry.id}
            to={containerPath(host.host.id, container.name, entry.id)}
            aria-current={entry.id === tab ? "page" : undefined}
            data-testid={`container-tab-${entry.id}`}
            className={cn(
              "-mb-px border-b-2 px-3 py-1.5 text-[13px]",
              entry.id === tab
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t(entry.labelKey)}
          </Link>
        ))}
      </nav>

      {/* ⚠️ NUR DER GELTENDE REITER WIRD EINGEHÄNGT, und das ist eine Zusage
          und keine Sparmaßnahme: `LogView` öffnet seinen Strom und `FilesView`
          holt seine Liste, sobald sie eingehängt sind. Ein `hidden` an einem
          eingehängten Bauteil verstecke die Fläche und schickte die Anfrage
          trotzdem — die Log-Route belegte einen der Plätze des Arms, die
          Datei-Route schriebe einen Audit-Eintrag. Geprüft wird das in
          `web/tests/container-screen.test.tsx` („der geschlossene Reiter öffnet
          keinen Strom") am ausgebliebenen Aufruf und nicht am Text. */}
      {tab === "overview" ? <OverviewTab found={found} /> : null}
      {tab === "logs" ? <LogTab found={found} /> : null}
      {tab === "files" ? <FilesTab found={found} /> : null}
      {tab === "shell" ? <ShellTab found={found} /> : null}
    </div>
  );
}

/**
 * Der Hinweis für einen fremdverwalteten Container.
 *
 * ⚠️ ER SAGT, WAS HIER NICHT GEHT, UND NICHT MEHR, DASS NICHTS GEHT. Seit #124
 * trägt der Hub fremdverwaltete Container mit `externallyManaged` beim Arm
 * ein (Entscheidung des Betreibers vom 2026-09-30,
 * `dashboard-docker-agent#78`): Protokoll, Dateien, Shell und Last laufen wie
 * bei jedem anderen Container. Gesperrt sind nur Update, Neuerstellen und
 * Entfernen — der Verwalter baute sie beim nächsten „Apply Update" aus seiner
 * Vorlage zurück. Steht der Container auf dieser Seite, steht er auch in der
 * Allowlist: die Liste kommt aus `GET /containers`, und die führt nur sie.
 *
 * ⚠️ NICHT `ExternalManagementNote` aus `overview/external-management.tsx`.
 * Deren Sätze sprechen über eine GRUPPE („Diese Container legt Unraid aus
 * seinen Vorlagen an"); auf einer Fläche, die genau einen Container zeigt,
 * stünde damit ein Plural über einem Einzelstück. Der Name des Verwalters
 * reist deshalb als Angabe herein, und der Satz gehört dieser Fläche.
 */
function ExternalNote({ manager }: { manager: string }) {
  const t = useTranslations();
  const unknown = isUnknownManager(manager);
  const name = managerName(manager);
  return (
    <Card className="gap-1 border-card-line bg-body-face p-4" data-testid="container-external-note">
      <p className="text-sm font-medium">
        {unknown ? t("containerExternalUnknownTitle") : t("containerExternalTitle", { manager: name })}
      </p>
      <p className="max-w-prose text-[13px] text-muted-foreground">
        {unknown ? t("containerExternalUnknownDefinition") : t("containerExternalDefinition", { manager: name })}
      </p>
    </Card>
  );
}

function OverviewTab({ found }: { found: Found }) {
  const t = useTranslations();
  const { host, container, stack } = found;
  // Die Sprache hängt am Konto und nicht am Browser
  // (docs/design/language-layer.md); das Datum darf nicht in einer anderen
  // Ordnung stehen als die Oberfläche daneben.
  const { language } = useLanguage();
  const management = container.externalManagement;

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      {management === null ? null : <ExternalNote manager={management.manager} />}

      <Card className="gap-0 overflow-hidden border-card-line bg-body-face py-0">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 px-4 py-3 text-[13px]">
          <Fact label={t("containerImage")}>
            <span className="font-mono break-all">{container.image}</span>
          </Fact>
          {/* ⚠️ DER STATUSTEXT DES AGENTEN WIRD NICHT ÜBERSETZT („Up 2 hours",
              „Exited (1) 3 minutes ago"). Er kommt wörtlich von Docker und ist
              kein Text dieser Oberfläche — dieselbe Begründung wie an der
              Container-Zeile (`overview/ContainerRow.tsx`). Übersetzt ist die
              BESCHRIFTUNG daneben, und das ist der Unterschied. */}
          <Fact label={t("containerAgentStatus")}>
            <span data-testid="container-agent-status">{container.status}</span>
          </Fact>
          <Fact label={t("containerStartedAt")}>
            {container.startedAt === null ? t("valueUnknown") : formatSignInTime(container.startedAt, language)}
          </Fact>
          {stack === null ? null : (
            <Fact label={t("containerStack")}>
              {/* Der Weg zurück in die Einheit, in der dieser Container
                  betrieben wird. Er steht als Verweis da und nicht als
                  bloßer Name: die Seite des Stacks zeigt seine Geschwister,
                  und die sind bei einer Fehlersuche der nächste Schritt. */}
              <Link
                to={stackPath(host.host.id, stack.project)}
                className="font-mono underline-offset-2 hover:underline"
              >
                {stack.project}
              </Link>
            </Fact>
          )}
        </dl>
      </Card>

      {/* CPU und RAM mit Verlauf (#213) — seit #124 auch für einen
          fremdverwalteten Container: er steht in der Allowlist des Arms und
          wird dort gemessen wie jeder andere. */}
      <ContainerMetrics hostId={host.host.id} containerId={container.id} running={container.running} />
    </div>
  );
}

/** Eine Zeile der Tafel — Beschriftung links, Wert rechts. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-subtle-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function LogTab({ found }: { found: Found }) {
  const t = useTranslations();
  const { host, container } = found;

  return (
    <Card className="min-h-0 flex-1 overflow-hidden border-card-line bg-body-face p-3">
      {/* ⚠️ DIE KENNUNG UND NICHT DER NAME. Der Agent führt seine Allowlist
          über Kennungen; ein Name träfe sie nicht. Die Auflösung ist die
          Arbeit dieser Seite — die Adresse trägt den Namen, weil der ein
          Neuerstellen überlebt.

          ⚠️ KEINE ZEILENZAHL. `LogView` hat absichtlich keine Eigenschaft
          dafür: die Zahl entscheidet der Server aus der Einstellung des
          Betreibers (Etappe G/H1). Zwei Quellen für dieselbe Frage wären eine
          zu viel, und die gepflegte Einstellung hätte keine Wirkung mehr. */}
      <Suspense fallback={<p className="text-[13px] text-subtle-foreground">{t("logViewLoading")}</p>}>
        <LogView hostId={host.host.id} containerId={container.id} />
      </Suspense>
    </Card>
  );
}

/**
 * Der Reiter „Dateien" (Paket B5, Etappe E5a, #5).
 *
 * Seit #124 auch für einen fremdverwalteten Container: der Verwalter fasst
 * seine Definition an, nicht seine Dateien (Entscheidung des Betreibers vom
 * 2026-09-30).
 *
 * ⚠️ KEINE `Card` UM DIESE FLÄCHE. Anders als das Protokoll bringt sie ihre
 * eigenen Rahmen mit — die Freigabewahl ist eine Karte, die Liste eine zweite —
 * und zwei Rahmen ineinander sind einer zu viel.
 */
function FilesTab({ found }: { found: Found }) {
  const t = useTranslations();
  const { host, container } = found;

  // ⚠️ DIE KENNUNG UND NICHT DER NAME — wie beim Protokoll. Der Agent führt
  // seine Allowlist über Kennungen; die ABLAGE der Freigabe hängt dagegen am
  // Containernamen (`server/src/domain/containers/shares.ts`), und die Auflösung
  // zwischen beidem ist Sache des Servers und nicht dieser Fläche.
  //
  // The fallback is the text the view shows while it asks for the share: the
  // chunk and the first answer load one after the other, and a second text in
  // between would only flicker.
  return (
    <Suspense fallback={<p className="text-muted-foreground">{t("loading")}</p>}>
      <FilesView hostId={host.host.id} containerId={container.id} />
    </Suspense>
  );
}

/**
 * Der Reiter „Shell" (Paket B6, Etappe E6, #5).
 *
 * Seit #124 auch für einen fremdverwalteten Container: der Arm sperrt an ihm
 * nur, was seine Definition ändert, und eine Shell tut das nicht.
 *
 * ⚠️ KEINE `Card` UM DIESE FLÄCHE — wie bei den Dateien und anders als beim
 * Protokoll. Das Terminal bringt seinen eigenen Rahmen mit, und der trägt die
 * Fläche aus `--terminal-surface`; eine Karte darum wäre ein zweiter Rahmen
 * in einer anderen Farbe.
 */
function ShellTab({ found }: { found: Found }) {
  const { host, container } = found;
  const t = useTranslations();
  // The view is a feature and may not import the provider; it gets the set of
  // knobs as a prop (#261).
  const { theme } = useGlobalTheme();

  // Die KENNUNG und nicht der Name — wie beim Protokoll und bei den Dateien.
  // Der Agent führt seine Allowlist über Kennungen, und die Exec-Route des
  // Hubs hält die Kennung aus dem Pfad gegen den Eintrag im Sitzungsregister
  // (`server/src/features/shell/routes.ts`).
  return (
    <Suspense fallback={<p className="text-[13px] text-subtle-foreground">{t("shellLoading")}</p>}>
      <ShellView hostId={host.host.id} containerId={container.id} theme={theme} />
    </Suspense>
  );
}
