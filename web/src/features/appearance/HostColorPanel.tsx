import { useQueryClient } from "@tanstack/react-query";
import { useState, type CSSProperties } from "react";
import { useTranslations } from "use-intl";

import {
  HUE_TONES,
  INK_STEPS,
  type HostThemePreset,
  type HueName,
  type HueTone,
  type InkName
} from "contract";
import { hostDisplay, useHostListUpdate, useHosts, type DockerHost } from "../../domain/hosts";
import { Badge } from "../../platform/ui/shadcn/badge";
import { Card } from "../../platform/ui/shadcn/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../../platform/ui/shadcn/select";
import { knownKey } from "../../platform/i18n/wire-labels";
import { queryKeys } from "../../platform/query/query-keys";
import { HUE_LABELS, INK_LABELS } from "../../platform/i18n/theme-labels";
import { setHostDisplay } from "./api";

// Die Tafel „Farbe je Host" (D7a, #62; Artboard hub-palette.html Z. 799–822,
// nachgemessen).
//
// ⚠️ DIES IST DIE TAFEL, DIE `hostHue` AUS #75 ABLÖST. Bis D6b rechnete das
// Web den Ton eines Arms aus seiner Kennung; bei drei Armen bekamen etwa 44
// von 100 Läufen zweimal denselben Ton, und eine Kennfarbe, die zwei Arme
// teilen, benennt nichts mehr. Seit D7a steht der Ton in der Ablage — und
// hier ist der einzige Ort im Hub, an dem jemand ihn vergibt. Ohne diese
// Tafel bliebe jeder Arm für immer auf „neutral" stehen.
//
// ⚠️ KEIN FREIER FARBWÄHLER. Das ist die Lehre aus dashboard-homelab#335 und
// steht als Auflage in #62 (D7): je Stellschraube eine FESTE Stufenliste aus
// `contract/src/presets.ts`. Ein Farbrad erzeugt Werte, für die es in
// `web/src/platform/theme/palette.css` keine Regel gibt, gegen die der Server nicht
// prüfen kann und die im hellen Wertesatz beliebig kontrastarm werden. Die
// sieben Töne und die vier Stufen des Farbeinsatzes hier kommen deshalb
// wörtlich aus `HUE_TONES` und `INK_STEPS` — diese Datei zählt keine einzige
// Stufe selbst auf.
//
// ⚠️ DIE VORSCHAU IST DIESELBE SEITE. Ein gewählter Ton steht sofort an der
// Zeile: die Zeile trägt `data-host`/`data-hue`/`data-ink` wie eine Host-Karte,
// und die Ableitungsregel in `palette.css` rechnet daraus die Palette dieses
// Teilbaums. Es gibt deshalb keine zweite „Vorschau-Fläche" — es gäbe auch
// nichts, was sie zeigen könnte, das die Zeile nicht schon zeigt.
//
// ⚠️ WARUM HIER SOFORT GESCHRIEBEN WIRD UND IN DER TAFEL „DARSTELLUNG" NICHT.
// Zwei Unterschiede, beide am Vertrag ablesbar:
//   - `PUT /api/hosts/:id/display` trägt die Farbe EINES Arms. Ein Klick ist
//     hier schon die vollständige Absicht; ein „Speichern"-Knopf daneben wäre
//     ein zweiter Klick für dieselbe Aussage.
//   - `PUT /api/settings/theme` trägt den GANZEN Satz der sieben globalen
//     Stellschrauben (client.ts sagt warum). Wer dort bei jedem Anfassen
//     schriebe, erzeugte für einen durchprobierten Satz sieben Schreibvorgänge
//     und hätte nach dem dritten keinen Stand mehr, den er benennen kann.
// Und die Reichweite: hier ändert sich die Farbe eines Arms, dort das Aussehen
// des ganzen Hubs für alle Benutzer.
//
// Der Weg ist derselbe wie beim Sprachumschalter (`i18n/LanguageProvider.tsx`):
// zuerst umstellen, dann schreiben, bei einem Fehlschlag ZURÜCKSTELLEN und es
// sagen. Die Oberfläche antwortet damit auf den Klick und nicht auf die
// Laufzeit des Netzes, und sie zeigt am Ende nie eine Farbe, die nirgends
// gespeichert ist.

/**
 * Ein Farbtupfer für EINEN Ton aus dem Vorrat — der Knopf in der Auswahlliste.
 *
 * ⚠️ WARUM HIER KEIN `data-hue` STEHT. Der Wächter
 * `web/tests/host-palette.test.mjs` (Prüfung 2) verlangt für jedes `data-hue`
 * unter `web/src/app/screens/`, dass sein Wert aus `hostDisplay(…)` kommt — also
 * aus der Ablage. Das ist richtig und trifft genau den Fehler, den es zu
 * verhindern gilt: eine Karte, die eine Farbe trägt, die kein Betreiber
 * vergeben hat. Ein Tupfer in der AUSWAHLLISTE zeigt aber notwendig einen Ton,
 * den noch niemand vergeben hat — er ist das Angebot und nicht der Stand.
 *
 * Er nimmt seine Zahlen deshalb direkt aus `HUE_TONES`: `--h` ist der Grad im
 * Farbtonkreis, `--c` die eigene Buntheit, die allein „neutral" trägt. Das ist
 * KEINE zweite Quelle — es sind dieselben Zahlen aus derselben Datei, gegen
 * die `web/tests/theme-presets.test.mjs` die Regeln in `palette.css` hält.
 * `data-host` am Tupfer selbst sorgt dafür, dass die Ableitungsregel dort
 * überhaupt greift: `--primary` ist auf `:root, [data-hue], [data-host], …`
 * deklariert, und eine Variable löst dort auf, wo sie deklariert ist. Ohne das
 * Attribut trüge der Tupfer den Ton seines Vorfahren statt seinen eigenen —
 * und nichts daran wäre rot.
 */
function ToneDot({ tone }: { tone: HueTone }) {
  return (
    <span
      data-host=""
      aria-hidden="true"
      className="size-2.5 shrink-0 rounded-full bg-primary"
      style={
        {
          "--h": tone.hue,
          ...(tone.chroma === null ? {} : { "--c": tone.chroma })
        } as CSSProperties
      }
    />
  );
}

// Die Verengung auf die Stufe kommt aus der Stufenliste selbst und nicht aus
// einer Zusicherung: `onValueChange` von Radix liefert einen `string`, und ein
// `as HueName` wäre eine Behauptung über einen Wert, der nicht aus diesem
// Modul stammt. Steht dort etwas, das es nicht gibt, geschieht nichts.
function isHueName(value: string): value is HueName {
  return HUE_TONES.some((tone) => tone.name === value);
}

function isInkName(value: string): value is InkName {
  return INK_STEPS.some((step) => step.name === value);
}

type HostRowProps = {
  host: DockerHost;
  editable: boolean;
  failed: boolean;
  onChange: (host: DockerHost, display: HostThemePreset) => void;
};

function HostRow({ host, editable, failed, onChange }: HostRowProps) {
  const t = useTranslations();
  // Der Stand der Ablage — und während eines laufenden Schreibvorgangs der
  // Stand, den der Betreiber gerade gewählt hat. Beides derselbe Weg: die
  // Fläche hält die Arme im Zustand, und die Zeile liest daraus.
  const display = hostDisplay(host);
  const tone = HUE_TONES.find((entry) => entry.name === display.hue);
  const hueKey = knownKey(HUE_LABELS, display.hue);
  const inkKey = knownKey(INK_LABELS, display.ink);

  // ⚠️ Die drei Attribute stehen an der ZEILE und nicht am Kasten darum. Sie
  // sind die Vorschau: `palette.css` rechnet aus ihnen die Palette dieses
  // Teilbaums, der getönte Kopfstreifen (`bg-head-face`) und die Fläche
  // darunter (`bg-body-face`) folgen daraus. So ist an derselben Zeile zu
  // sehen, was die Stufe „Kopf getönt" von „Karte getönt" unterscheidet —
  // ohne ein zweites Musterbild, das dasselbe noch einmal behauptet.
  return (
    <div
      data-host={host.id}
      data-hue={display.hue}
      data-ink={display.ink}
      // ⚠️ `border-card-line` und NICHT `border-accent-line`: die Kante ist
      // seit D7a selbst eine Stufe des Farbeinsatzes, und genau hier wird sie
      // gewählt. Mit der festen Kante trügen „ohne Farbe" und „nur Kante"
      // dieselbe — die Vorschau zeigte den Unterschied nicht, den sie zu
      // zeigen verspricht.
      className="overflow-hidden rounded-md border border-card-line bg-body-face"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-head-face px-3 py-2">
        <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-primary" />
        <span className="font-mono text-[14px] font-medium">{host.name}</span>
        {/* ⚠️ Nachgeschlagen und nicht indiziert (`i18n/wire-labels.ts`): der
            Ton kommt aus der ABLAGE über die Leitung, nicht aus der Liste
            daneben. Fällt ein Voreinstellungsname aus `HUE_TONES` heraus,
            während ein Arm ihn noch trägt, stand hier bis zum 2026-09-07
            nichts — `t(undefined)` wird von `use-intl` abgefangen.

            Der Rückfall ist der ROHE Name und kein eigener Satz: er ist ein
            Wert der Gegenseite wie der Statustext eines Containers und kein
            Text dieser Oberfläche (dieselbe Begründung wie in
            `screens/overview/ContainerRow.tsx`). */}
        <Badge variant="secondary" className="font-normal">
          {hueKey === null ? display.hue : t(hueKey)}
          {tone === undefined ? null : (
            <>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{tone.hue}</span>
            </>
          )}
        </Badge>
        <Badge variant="outline" className="font-normal">
          {inkKey === null ? display.ink : t(inkKey)}
        </Badge>
      </div>

      {editable ? (
        <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
          <Select
            value={display.hue}
            onValueChange={(value) => {
              if (isHueName(value)) onChange(host, { ...display, hue: value });
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-[13rem]"
              aria-label={t("settingsHueForHost", { host: host.name })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HUE_TONES.map((entry) => (
                <SelectItem key={entry.name} value={entry.name}>
                  <ToneDot tone={entry} />
                  {t(HUE_LABELS[entry.name])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={display.ink}
            onValueChange={(value) => {
              if (isInkName(value)) onChange(host, { ...display, ink: value });
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-[13rem]"
              aria-label={t("settingsInkForHost", { host: host.name })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INK_STEPS.map((step) => (
                <SelectItem key={step.name} value={step.name}>
                  {t(INK_LABELS[step.name])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Der Fehlschlag steht an DER ZEILE, zu der er gehört. Eine
              Meldung am Kopf der Tafel ließe offen, welcher Arm nicht
              gespeichert wurde — und die Farbe steht dann bereits wieder auf
              dem alten Stand, also sähe man es auch nicht. */}
          {failed ? <span className="text-[13px] text-destructive">{t("settingsColorSaveFailed")}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Die Tafel selbst.
 *
 * ⚠️ SIE LÄDT DIE ARME AUCH OHNE ADMINROLLE. `GET /api/hosts` steht hinter
 * `withSession` und nicht hinter `requireAdmin` — anders als die Konten-Liste
 * in `AccountScreen`, die für einen Benutzer ohne Rolle gar nicht erst
 * abgerufen wird, weil dort eine 403 feststünde. Hier steht keine fest, also
 * wird gefragt; was NICHT erscheint, sind die Auswahllisten
 * (`PUT /api/hosts/:id/display` ist Admin).
 *
 * ⚠️ Die Zahl der Stacks je Arm, die das Artboard in der letzten Spalte zeigt,
 * steht hier NICHT. Sie liegt nicht an `GET /api/hosts` (`DockerHost` in
 * `web/src/domain/hosts/host-types.ts` führt kein solches Feld); sie entstünde erst aus
 * `GET /api/hosts/:id/containers` je Arm — also einer Agent-Anfrage pro Zeile,
 * die für einen Arm im Zustand `pending` oder `offline` gar keine Antwort hat.
 * Eine Spalte, die genau bei den Armen leer bleibt, denen der Betreiber gerade
 * eine Farbe gibt, sagt weniger als keine. Erfunden wird sie nicht.
 */
export function HostColorPanel({ role }: { role: "admin" | "user" }) {
  const t = useTranslations();
  const editable = role === "admin";
  // Since #256 the list comes from the same cache entry as the hosts screen:
  // one request for both, and a saved colour is on the host cards at once.
  const hostsQuery = useHosts();
  const updateHosts = useHostListUpdate();
  const queryClient = useQueryClient();
  const hosts = hostsQuery.data ?? null;
  const failed = hostsQuery.isError;
  // Die Kennung des Arms, dessen letzter Schreibvorgang scheiterte — und nicht
  // ein schlichtes `true`: bei drei Armen muss die Meldung sagen, welcher.
  const [saveFailed, setSaveFailed] = useState<string | null>(null);

  const applyDisplay = (hostId: string, display: HostThemePreset) => {
    updateHosts((current) => current.map((entry) => (entry.id === hostId ? { ...entry, display } : entry)));
  };

  const chooseDisplay = (host: DockerHost, next: HostThemePreset) => {
    const previous = hostDisplay(host);
    // A load still running would overwrite the change below with the state
    // from before it; it is cancelled, the change is what the hub will answer.
    void queryClient.cancelQueries({ queryKey: queryKeys.hosts.list() });
    // Zuerst umstellen: der Ton steht an der Zeile, bevor das Netz antwortet.
    applyDisplay(host.id, next);
    setSaveFailed(null);
    void setHostDisplay(host.id, next)
      .then((saved) => {
        // Übernommen wird der ARM, den der Server zurückgibt, und nicht das,
        // was gesendet wurde — dafür antwortet die Route mit ihm. Ein zweiter
        // Abruf ist damit unnötig, und wenn der Server eine Stufe zurechtrückt,
        // steht sein Stand auf dem Schirm und nicht die Absicht des Browsers.
        updateHosts((current) => current.map((entry) => (entry.id === saved.id ? saved : entry)));
      })
      .catch(() => {
        // Zurückstellen, damit die Zeile nicht eine Farbe trägt, die nirgends
        // gespeichert ist — beim nächsten Laden wäre sie sonst weg, ohne dass
        // jemand erführe, warum.
        applyDisplay(host.id, previous);
        setSaveFailed(host.id);
      });
  };

  return (
    <Card className="gap-0 overflow-hidden border-accent-line bg-body-face py-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-head-face px-4 py-2.5">
        <span className="text-sm font-medium">{t("settingsHostColorTitle")}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {t("settingsHostColorTones", { count: HUE_TONES.length })}
        </span>
      </div>

      <div className="flex flex-col gap-3 px-4 py-4">
        <p className="text-[13px] text-subtle-foreground">{t("settingsHostColorHint")}</p>
        {!editable ? (
          <p className="text-[13px] text-muted-foreground">{t("settingsAdminOnly")}</p>
        ) : null}

        {failed ? <p className="text-sm text-destructive">{t("hostsFailed")}</p> : null}
        {!failed && hosts === null ? <p className="text-muted-foreground">{t("loading")}</p> : null}
        {hosts !== null && hosts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("hostsEmpty")}</p>
        ) : null}

        {(hosts ?? []).map((host) => (
          <HostRow
            key={host.id}
            host={host}
            editable={editable}
            failed={saveFailed === host.id}
            onChange={chooseDisplay}
          />
        ))}
      </div>
    </Card>
  );
}
