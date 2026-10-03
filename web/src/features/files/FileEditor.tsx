import type { Messages } from "use-intl";
import { useState, type ReactNode } from "react";
import { useTranslations } from "use-intl";

import { saveFileText } from "./api";
import { useFileText } from "./file-queries";
import { Button } from "../../platform/ui/shadcn/button";
import { Card } from "../../platform/ui/shadcn/card";
import { fileChangedHash, fileErrorKey } from "./file-errors";

// Der Texteditor einer Datei in der Freigabe — Paket B5, Etappe E5b (#5).
//
// ⚠️ DER KONFLIKT IST DER GRUND, AUS DEM ES DIESE DATEI GIBT. Speichern heißt
// hier: den Text zurückschicken ZUSAMMEN MIT DEM HASH, unter dem er geladen
// wurde. Hat sich die Datei seither geändert, antwortet der Server `409` mit
// `file-changed` UND DEM JETZIGEN HASH. Dieser `409` ist eine Auskunft und kein
// Ausfall: er sagt, dass jemand anderes dieselbe Datei angefasst hat.
//
// Wer ihn als „ging nicht" zeigt, tut zweierlei falsch. Er verschweigt, WARUM
// es nicht ging — der Betreiber sucht dann einen Netzfehler, den es nicht gibt.
// Und er lässt ihn seine Änderung neu tippen, obwohl sie im Textfeld vor ihm
// steht.
//
// ⚠️ DESHALB ZWEI WEGE UND NICHT EINER (und beide sind gebaut, siehe unten):
//
//   1. NEU LADEN UND VERWERFEN — der fremde Stand gewinnt. Der Weg für den
//      Fall, dass die eigene Änderung noch nicht viel war.
//   2. GEGEN DEN NEUEN HASH SPEICHERN — der eigene Stand gewinnt. Der Weg für
//      den Fall, dass die eigene Änderung die Arbeit von zehn Minuten ist.
//
// Nur (1) zu bauen hiesse, jede Konfliktlösung mit einem Datenverlust auf der
// eigenen Seite zu bezahlen; nur (2) zu bauen hiesse, sie mit einem auf der
// fremden zu bezahlen — und zwar stillschweigend. Beide Knöpfe stehen deshalb
// nebeneinander, und der Satz daneben sagt, was jeder von beiden kostet.
//
// ⚠️ WAS AUSDRÜCKLICH NICHT GEBAUT IST: ein VERGLEICH der beiden Stände und
// eine Zusammenführung. Der Server schickt beim `409` den Hash und nicht den
// fremden Inhalt; für einen Vergleich bräuchte diese Fläche ein zweites Laden
// und eine Textdifferenz, und für eine Zusammenführung einen gemeinsamen
// Vorfahren, den niemand aufbewahrt. Das ist eine eigene Etappe wert und keine
// halbe Lösung nebenbei. Genannt statt vorgetäuscht: der Satz
// `filesEditorConflictNoMerge` sagt dem Betreiber, dass er die beiden Stände
// hier nicht nebeneinander sieht.
//
// ⚠️ DIESE FLÄCHE PRÜFT KEINE GRÖSSE. `MAX_TEXT_BYTES` ist ein Wert der
// Gegenseite und steht ausschließlich in `contract/src/agent/`; eine zweite
// Deklaration — auch im Web — macht `web/tests/agent-protocol-values.test.mjs`
// rot. Ein zu großer Text wird vom Server mit `413 too-large` abgelehnt, und
// genau dieser Fehler wird gezeigt.

/**
 * What belongs to ONE open of the text, keyed by the question it answers.
 *
 * ⚠️ A NEW QUESTION STARTS FRESH WITHOUT A `setState` IN AN EFFECT. Until #271
 * an effect loaded the text and reset draft, conflict, error and receipt when
 * it arrived. The text is a query now (`useFileText`); the state that goes
 * with one open carries its `question`, and a state for another question is
 * read as the fresh one (the same comparison `FilesView` used until #263).
 *
 * `draft` is `null` while nobody has typed: the field then shows the loaded
 * text. `savedHash` is the hash of the last save that went through: the next
 * save goes out against it and not against the one of the load.
 */
type Local = {
  question: string;
  draft: string | null;
  savedHash: string | null;
  saved: boolean;
  /** Der Fehler eines SPEICHERNS — der eines Ladens steht an der Abfrage. */
  saveErrorKey: keyof Messages | null;
  /**
   * Der JETZIGE Hash aus einem `409` — `null`, wenn kein Konflikt offen ist.
   *
   * ⚠️ Er steht als eigener Zustand NEBEN dem Fehlersatz und nicht darin: ein
   * Konflikt ist kein Fehlersatz, sondern eine Lage mit zwei Auswegen, und ein
   * gemeinsamer Zustand für beides zwänge die Fläche, aus einem Satz zu raten,
   * ob sie die Knöpfe zeigen darf.
   */
  conflict: string | null;
};

function freshLocal(question: string): Local {
  return { question, draft: null, savedHash: null, saved: false, saveErrorKey: null, conflict: null };
}

export function FileEditor({
  hostId,
  containerId,
  path,
  onClose,
  onSaved
}: {
  hostId: string;
  containerId: string;
  /** Der Pfad der Datei INNERHALB der Freigabe — nie leer. */
  path: string;
  onClose: () => void;
  /**
   * After a save that went through. Size and change time of the file are new,
   * so the list below the editor is loaded again (#263).
   */
  onSaved: () => void;
}) {
  const t = useTranslations();

  const [busy, setBusy] = useState(false);
  // Ein Zähler und kein Neuladen: nach „verwerfen" muss dieselbe Frage noch
  // einmal gestellt werden, und weder Adresse noch Pfad haben sich geändert.
  const [round, setRound] = useState(0);

  // Die Frage, die dieses Bauteil gerade stellt — in EINEM Text, damit der
  // Vergleich mit `local.question` einer ist und nicht vier.
  const question = `${hostId}|${containerId}|${path}|${round}`;
  const text = useFileText(hostId, containerId, path, round);

  const [stored, setStored] = useState<Local>(() => freshLocal(question));
  const local = stored.question === question ? stored : freshLocal(question);
  const update = (patch: Partial<Omit<Local, "question">>): void =>
    setStored((current) => ({ ...(current.question === question ? current : freshLocal(question)), ...patch }));
  const { conflict, saved, saveErrorKey } = local;
  const draft = local.draft ?? text.data?.content ?? "";

  /**
   * Speichern gegen einen bestimmten Hash.
   *
   * ⚠️ DER HASH IST EIN ARGUMENT UND KEIN FESTER WERT. Beim ersten Speichern
   * ist es der aus dem LADEN, beim „trotzdem speichern" der aus dem `409`.
   * Ein Aufruf ohne ihn — oder mit einem erfundenen — hebt die einzige Sperre
   * gegen das stille Überschreiben fremder Änderungen auf; der Server lehnt
   * einen fehlenden mit `400` ab, aber ein fest eingesetzter käme durch, sobald
   * er zufällig stimmt.
   */
  const save = (expectedHash: string): void => {
    setBusy(true);
    update({ saveErrorKey: null, conflict: null, saved: false });

    void saveFileText(hostId, containerId, path, draft, expectedHash)
      .then(({ hash }) => {
        // ⚠️ DER NEUE HASH WIRD ÜBERNOMMEN. Ohne das ginge ein zweites
        // Speichern gegen den Hash von vorhin hinaus — und der Server
        // antwortete `409` auf eine Änderung, die niemand sonst gemacht hat.
        update({ draft, savedHash: hash, saved: true });
        onSaved();
      })
      .catch((error: unknown) => {
        // ⚠️ DER KONFLIKT ZUERST. `fileErrorKey` bildet JEDEN `409` auf
        // „unbekannter Freigabepfad" ab — für diesen hier wäre das ein
        // falscher Satz über eine richtige Lage.
        const current = fileChangedHash(error);
        if (current !== null) {
          update({ conflict: current });
          return;
        }
        update({ saveErrorKey: fileErrorKey(error) });
      })
      .finally(() => setBusy(false));
  };

  const shell = (children: ReactNode) => (
    <Card className="gap-3 border-card-line bg-body-face p-4" data-testid="files-editor">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <p className="font-mono text-[13px] break-all" data-testid="files-editor-path">
          {path}
        </p>
        <Button type="button" size="sm" variant="ghost" data-testid="files-editor-close" onClick={onClose}>
          {t("filesEditorClose")}
        </Button>
      </div>
      {children}
    </Card>
  );

  if (text.isError) {
    return shell(
      <p className="text-[13px] text-destructive" data-testid="files-editor-error">
        {t(fileErrorKey(text.error))}
      </p>
    );
  }
  if (text.data === undefined) {
    return shell(<p className="text-[13px] text-muted-foreground">{t("loading")}</p>);
  }
  const loaded = { content: text.data.content, hash: local.savedHash ?? text.data.hash };

  return shell(
    <>
      {/* ⚠️ `role="alert"` und `text-state-warn` wie in `LogView.tsx`: ein
          Hinweis, der auffallen soll, braucht beides. `text-warning-foreground`
          gibt es in diesem Theme nicht — er stünde in Fließtextfarbe da. */}
      {conflict === null ? null : (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border border-card-line p-3 text-[13px] text-state-warn"
          data-testid="files-editor-conflict"
        >
          <p className="font-medium">{t("filesEditorConflictTitle")}</p>
          <p className="max-w-prose">{t("filesEditorConflictBody")}</p>
          <p className="max-w-prose text-subtle-foreground">{t("filesEditorConflictNoMerge")}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy}
              data-testid="files-editor-conflict-reload"
              onClick={() => setRound((current) => current + 1)}
            >
              {t("filesEditorConflictReload")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy}
              data-testid="files-editor-conflict-overwrite"
              onClick={() => save(conflict)}
            >
              {t("filesEditorConflictOverwrite")}
            </Button>
          </div>
        </div>
      )}

      {saveErrorKey === null ? null : (
        <p className="text-[13px] text-destructive" data-testid="files-editor-error">
          {t(saveErrorKey)}
        </p>
      )}

      {/* Kein shadcn-Baustein: ein `textarea` gibt es dort in diesem Bestand
          nicht, und einen halben dafür anzulegen wäre eine Abschrift ohne
          Herkunftsnachweis (`ui/shadcn/PROVENANCE.md`). */}
      <textarea
        aria-label={t("filesEditorLabel")}
        data-testid="files-editor-input"
        className="min-h-64 w-full rounded-md border border-input bg-transparent p-3 font-mono text-[13px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        value={draft}
        spellCheck={false}
        onChange={(event) => update({ draft: event.target.value, saved: false })}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          data-testid="files-editor-save"
          onClick={() => save(loaded.hash)}
        >
          {busy ? t("filesEditorSaving") : t("filesEditorSave")}
        </Button>
        {saved ? (
          <span className="text-[13px] text-subtle-foreground" data-testid="files-editor-saved">
            {t("filesEditorSaved")}
          </span>
        ) : null}
      </div>
    </>
  );
}
