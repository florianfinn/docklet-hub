import { useTranslations } from "use-intl";

import type { MarkView } from "contract";

import { Card } from "../../platform/ui/shadcn/card";
import { MarkRow } from "./MarkRow";
import { useMarkListUpdate, useMarks } from "./mark-queries";
import { NewMarkForm } from "./NewMarkForm";

// Die Tafel „Eigene Marken" (D7b, #62; docs/design/hub-color-and-structure.md
// §3 und §4).
//
// ⚠️ SIE FÜHRT NUR DIE LISTE. Anlegen, umbenennen, Ton, Darstellung,
// entfernen — und sonst nichts. ZUGEORDNET wird eine Marke an Ort und Stelle,
// auf der Stack-Seite und in der Container-Zeile (Entscheidung des Betreibers
// vom 2026-09-06). Das ist keine Auslassung, sondern der Schnitt: wer hier
// zuordnete, müsste erst Host, dann Stack, dann Container aus drei
// Auswahllisten zusammensuchen — an der Zeile selbst ist die Frage schon
// beantwortet.
//
// ⚠️ KEIN FREIER FARBWÄHLER, wie in `HostColorPanel` und aus demselben Grund
// (#62, Lehre aus dashboard-homelab#335): je Stellschraube eine FESTE
// Stufenliste aus `contract/src/presets.ts`. Diese Datei zählt keine
// einzige Stufe selbst auf — die sieben Töne kommen aus `HUE_TONES`, die zwei
// Darstellungen aus `MARK_STYLE_STEPS`.
//
// ⚠️ JEDE STUFE WIRD ALS DAS GEZEIGT, WAS SIE TUT. In der aufgeklappten Liste
// steht jeder Eintrag als MARKE in genau diesem Ton und in genau dieser
// Darstellung, nicht als Wort daneben. Der Unterschied zwischen „Beschriftung"
// und „Fläche" ist genau das, was man sehen muss, um ihn zu wählen; zwei
// Wörter zeigen ihn nicht. Der zugeklappte Knopf trägt dagegen das Wort — die
// Begründung dafür steht bei `ToneSelect` und ist am Bild gemessen.
//
// ⚠️ WARUM HIER — ANDERS ALS IN `HostColorPanel` — EIN „SPEICHERN" STEHT.
// Dort trägt ein Klick auf eine Auswahlliste schon die vollständige Absicht,
// und `PUT /api/hosts/:id/display` trägt genau sie. Hier trägt der Rumpf
// `{ mark: { name, hue, style } }` den VOLLEN Satz, und der Name kommt aus
// einem Textfeld: wer bei jedem Anschlag schriebe, erzeugte für „Sicherung"
// neun Schreibvorgänge, von denen mehrere auf einen halb getippten Namen
// laufen — und einer davon kann ein 409 „Name schon vergeben" sein, für einen
// Namen, den niemand vergeben wollte. Ein Knopf je Zeile, aktiv nur wenn die
// Zeile vom gespeicherten Stand abweicht.
//
// Die VORSCHAU ist trotzdem sofort da: die Marke links in der Zeile zeigt den
// gewählten Ton und die gewählte Darstellung, bevor gespeichert wird. Sie
// zeigt damit die ABSICHT; der Knopf daneben sagt, dass sie noch nicht in der
// Ablage steht.
//
// ⚠️ SIE LÄDT DIE MARKEN AUCH OHNE ADMINROLLE. `GET /api/marks` steht hinter
// `withSession` (server/src/features/marks/routes.ts, Begründung dort: die Marken stehen
// an Stacks und Container-Zeilen, die jeder angemeldete Benutzer sieht). Was
// einem Benutzer ohne Rolle FEHLT, sind die Bedienelemente — die drei
// schreibenden Routen sind Admin. Er sieht die Liste, den Hinweis „ändern kann
// das nur ein Administrator" und keinen toten Knopf.
//
// ⚠️ LEER IST ERLAUBT, AUSGEGRAUT NICHT (Regel aus D3). Ein Hub ohne Marken
// zeigt das Feld für die erste und einen Satz, der dorthin zeigt.

export function MarksPanel({ role }: { role: "admin" | "user" }) {
  const t = useTranslations();
  const editable = role === "admin";
  // Since #268 the list comes from a query: the same cache entry feeds the
  // stack page and the container list, and a mark created here is in their
  // pick list at once.
  const marksQuery = useMarks();
  const updateMarks = useMarkListUpdate();
  const marks = marksQuery.data ?? null;
  const failed = marksQuery.isError;

  // ⚠️ Die Liste wird nach dem Anlegen NICHT neu geholt. Der Server antwortet
  // mit der angelegten Marke, und ein zweiter Abruf wäre eine zweite Anfrage
  // für eine Auskunft, die schon da ist. Sortiert wird nach dem Namen — so
  // steht die neue Marke da, wo der Betreiber sie sucht, und nicht am Ende.
  const sortByName = (list: MarkView[]) =>
    [...list].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Card className="gap-0 overflow-hidden border-accent-line bg-body-face py-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-head-face px-4 py-2.5">
        <span className="text-sm font-medium">{t("settingsMarksTitle")}</span>
        {marks === null ? null : (
          <span className="ml-auto text-xs text-muted-foreground">
            {t("settingsMarksCount", { count: marks.length })}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-3 px-4 py-4">
        <p className="text-[13px] text-subtle-foreground">{t("settingsMarksHint")}</p>
        {!editable ? (
          <p className="text-[13px] text-muted-foreground">{t("settingsAdminOnly")}</p>
        ) : null}

        {failed ? <p className="text-sm text-destructive">{t("settingsMarksFailed")}</p> : null}
        {!failed && marks === null ? <p className="text-muted-foreground">{t("loading")}</p> : null}

        {editable && marks !== null ? (
          <NewMarkForm onCreated={(created) => updateMarks((current) => sortByName([...current, created]))} />
        ) : null}

        {marks !== null && marks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {editable ? t("settingsMarksEmpty") : t("settingsMarksEmptyReadOnly")}
          </p>
        ) : null}

        {(marks ?? []).map((mark) => (
          <MarkRow
            key={mark.id}
            mark={mark}
            editable={editable}
            onSaved={(saved) =>
              updateMarks((current) => sortByName(current.map((entry) => (entry.id === saved.id ? saved : entry))))
            }
            onRemoved={(markId) => updateMarks((current) => current.filter((entry) => entry.id !== markId))}
          />
        ))}
      </div>
    </Card>
  );
}
