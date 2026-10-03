import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";

import {
  applyCompose,
  type ComposeApplyStep,
  type ComposeDryRun,
  type ComposeQuestion,
  type ComposeResync
} from "./api";
import { useComposePreview } from "./compose-queries";
import { Button } from "../../platform/ui/shadcn/button";
import { Card } from "../../platform/ui/shadcn/card";
import { composeErrorKey } from "./compose-errors";
import { composeStepKey } from "./compose-steps";
import {
  NO_CONFIRMATIONS,
  answered,
  applyInputOf,
  blockerOf,
  demandsOf,
  toggled,
  type Blocker,
  type Confirmations
} from "./apply-state";

// Die Strecke vom Entwurf zur angewandten Datei (#35, Etappe E6b).
//
// ── DIE ANZEIGE DES ABLAUFS ───────────────────────────────────────────────
//
// ⚠️ KEIN FORTSCHRITTSBALKEN. `docs/design/phase-5-write-access.md` §5:
// „Erfundene Schritte sind schlechter als ein ehrliches Wort. Ein
// Fortschrittsbalken ohne Signal gibt beim Hängen falsche Sicherheit." Was hier
// steht, sind die Schritte, die der Arm MELDET — jeder mit seinem eigenen
// Namen, und keiner erscheint, bevor er begonnen hat.
//
// ⚠️ EIN ARM UNTER v0.22.0 MELDET KEINE. Er sagt das über `live: false` in der
// Startzeile, und die Anzeige zeigt dann ein WORT statt einer Liste. Eine
// Schrittliste, in der für immer der erste Schritt läuft, sähe aus wie ein
// Hänger.
//
// ── DIE VIER BESTÄTIGUNGEN ────────────────────────────────────────────────
//
// ⚠️ ZWEI VON IHNEN KANN DIESE FLÄCHE NICHT VORAB STELLEN, und das ist keine
// Lücke, sondern eine Eigenschaft der Sache: welche Images auf dem Host fehlen,
// weiß nur der Arm, und neue Härtungsverstösse entstehen ERST NACH dem `up` —
// er misst sie an den laufenden Containern und rollt ohne Bestätigung zurück.
// Sie kommen deshalb als RÜCKFRAGE, mit der Liste des Arms, und der nächste
// Versuch schickt genau diese Liste zurück.
//
// Der Betreiber sieht davon: einen Zwischenschritt, in dem etwas zu bestätigen
// ist, das vorher niemand wissen konnte. Das ist ehrlicher als ein Haken, den
// die Fläche vorab anbietet und dessen Inhalt sie sich ausdenken müsste.

/**
 * Wie viele Schritte die Anzeige höchstens hält. Ältere fallen vorne weg.
 *
 * ⚠️ DER DECKEL IST PFLICHT UND KEINE VORSICHT (#131, Befund 15 aus #117).
 * Vorher wuchs das Feld mit jedem `step`, den der Arm meldet, und wie viele
 * das sind, entscheidet der Arm und nicht diese Fläche — ein Arm in einer
 * Schleife füllt damit den Speicher des Reiters und den DOM-Baum gleichermaßen.
 * Dieselbe Bauart wie `HELD_LINE_CAP` im Log (`features/logs/log-stream.ts`):
 * die neuesten bleiben, die Zahl der verworfenen steht unter der Liste.
 *
 * ⚠️ WARUM 500 UND NICHT 5000. Ein Anwenden meldet in der Größenordnung von
 * zehn Schritten — je Service ein `pull`, ein `create`, ein `start`, dazu die
 * Klammer davor und danach. 500 lässt einen Stack mit hundert Services
 * vollständig stehen und ist damit weit über allem, was aus einer Compose-Datei
 * von höchstens 256 KiB (`MAX_COMPOSE_BYTES`) entstehen kann.
 */
export const HELD_STEP_CAP = 500;

/**
 * What the run has reached once the operator pressed "apply". Before that there
 * is no stage: the card shows the dry run (`useComposePreview`).
 */
type Stage =
  /** `dropped` zählt, was `HELD_STEP_CAP` vorne weggenommen hat. */
  | { kind: "running"; live: boolean; steps: ComposeApplyStep[]; dropped: number }
  | { kind: "question"; question: ComposeQuestion; answerable: boolean }
  /** `reason` ist das Wort aus der `fehler`-Zeile, roh; `null`, wo keines stand. */
  | { kind: "failed"; reason: string | null };

export type ComposeApplyProps = {
  hostId: string;
  containerId: string;
  /** Der Entwurf, so wie er hinausgeht. */
  draft: string;
  /** Der Hash des Standes, auf dem bearbeitet wurde. */
  expectedComposeHash: string;
  /** Ob sich gegenüber dem geladenen Stand überhaupt etwas geändert hat. */
  changed: boolean;
  /**
   * Nach dem Anwenden, SOFORT und ohne Klick: der angewandte Text ist ab jetzt
   * der geladene Stand, und die Fläche darüber lädt neu (#233). `resync` sagt,
   * ob der Arm die neuen Container-Ids schon trägt.
   */
  onApplied: (resync: ComposeResync) => void;
  /** Nach einem unbekannten Ausgang: den Stand neu lesen. */
  onReload: () => void;
  onClose: () => void;
};

export function ComposeApply(props: ComposeApplyProps) {
  const t = useTranslations();
  const [stage, setStage] = useState<Stage | null>(null);
  const [confirmations, setConfirmations] = useState<Confirmations>(NO_CONFIRMATIONS);
  // The failure of the run itself (before the stream stood); the failure of the
  // dry run is `preview.error`.
  const [runErrorKey, setRunErrorKey] = useState<string | null>(null);
  // ⚠️ Der Abbruch gehört dem Bauteil und nicht dem Aufruf: verlässt der
  // Betreiber die Fläche, hört sie auf zuzuhören. Sie HÄLT den Vorgang damit
  // nicht an — der Arm läuft weiter, und das ist so gewollt.
  const listening = useRef<AbortController | null>(null);

  // ⚠️ DIE VORSCHAU IST EINE ABFRAGE, DEREN SCHLÜSSEL DER ENTWURF IST (#265).
  // Bis #265 stand hier ein Effekt und ein Vergleich der Frage mit dem
  // Zustand; jetzt ist ein anderer Text ein anderer Schlüssel, und bis seine
  // Antwort da ist, steht „wird geholt" statt der Vorschau des alten Textes —
  // der Betreiber bestätigte sonst Services, die es in seinem jetzigen Text
  // nicht mehr gibt.
  const preview = useComposePreview(props.hostId, props.containerId, props.draft);

  useEffect(() => {
    return () => listening.current?.abort();
  }, []);

  const run = (withConfirmations: Confirmations): void => {
    const controller = new AbortController();
    listening.current = controller;
    setStage({ kind: "running", live: true, steps: [], dropped: 0 });

    void applyCompose(
      props.hostId,
      props.containerId,
      applyInputOf(props.draft, props.expectedComposeHash, withConfirmations),
      {
        signal: controller.signal,
        onStart: (start) => setStage({ kind: "running", live: start.live, steps: [], dropped: 0 }),
        onStep: (step: ComposeApplyStep) =>
          setStage((current) => {
            if (current?.kind !== "running") return current;
            const steps = [...current.steps, step];
            if (steps.length <= HELD_STEP_CAP) return { ...current, steps };
            const excess = steps.length - HELD_STEP_CAP;
            return { ...current, steps: steps.slice(excess), dropped: current.dropped + excess };
          })
      }
    )
      .then((outcome) => {
        // Diese Fläche hat selbst aufgehört zuzuhören — beim Abbauen. Es gibt
        // niemanden mehr, dem ein Stand zu zeigen wäre.
        if (outcome.kind === "detached") return;
        // ⚠️ KEIN EIGENER ZUSTAND „ANGEWANDT" MIT KNOPF (#233). Bis hierher
        // stand eine Karte da, die erst auf „Neu laden" neu las; wer
        // stattdessen zum Text zurückging, bearbeitete den Stand von vorher
        // weiter, und ein zweites Anwenden lief mit der alten Container-Id in
        // ein `404`. Gemessen am 2026-09-30 am Arm `local`.
        if (outcome.kind === "applied") {
          props.onApplied(outcome.resync);
          return;
        }
        if (outcome.kind === "question") {
          setStage({
            kind: "question",
            question: outcome.question,
            answerable: answered(withConfirmations, outcome.question) !== null
          });
          return;
        }
        setStage({ kind: "failed", reason: outcome.reason });
      })
      .catch((error: unknown) => {
        setRunErrorKey(composeErrorKey(error));
        setStage(null);
      });
  };

  const errorKey = runErrorKey ?? (preview.error === null ? null : composeErrorKey(preview.error));
  if (errorKey !== null) {
    return (
      <Card className="p-4">
        <p className="text-sm text-destructive">{t(errorKey as never)}</p>
        <Button className="mt-3" size="sm" variant="ghost" onClick={props.onClose}>
          {t("cancel")}
        </Button>
      </Card>
    );
  }

  if (stage === null) {
    if (preview.data === undefined) return <Card className="p-4 text-muted-foreground">{t("loading")}</Card>;
    return (
      <PreviewCard
        preview={preview.data}
        changed={props.changed}
        confirmations={confirmations}
        onToggle={setConfirmations}
        onApply={() => run(confirmations)}
        onClose={props.onClose}
      />
    );
  }

  if (stage.kind === "running") {
    return (
      <Card className="flex flex-col gap-2 p-4" data-testid="compose-running">
        <p className="text-[13px] font-medium">{t("composeApplyRunning")}</p>
        {stage.live ? (
          <>
            {/* ⚠️ DIE VERWORFENEN WERDEN GESAGT. Eine Liste, die vorne
                stillschweigend abschneidet, behauptet, der Vorgang habe mit dem
                Schritt begonnen, der jetzt oben steht — und der Betreiber sucht
                dann nach einem Schritt, den es sehr wohl gab. */}
            {stage.dropped === 0 ? null : (
              <p className="text-[12px] text-muted-foreground" data-testid="compose-steps-trimmed">
                {t("composeApplyStepsTrimmed", { count: HELD_STEP_CAP })}
              </p>
            )}
            <ol className="flex flex-col gap-1 text-[12.5px]">
              {stage.steps.map((step, index) => (
                <li key={index} className={index === stage.steps.length - 1 ? "" : "text-muted-foreground"}>
                  {stepText(t, step.step)}
                  {step.detail ? <span className="font-mono"> · {step.detail}</span> : null}
                </li>
              ))}
            </ol>
          </>
        ) : (
          // ⚠️ EIN WORT UND KEINE LISTE. Dieser Arm meldet keine Schritte;
          // eine Liste, in der für immer der erste läuft, sähe aus wie ein
          // Hänger.
          <p className="text-[13px] text-muted-foreground">{t("composeApplySilent")}</p>
        )}
        <p className="text-[12px] text-muted-foreground">{t("composeApplyLeaveNote")}</p>
      </Card>
    );
  }

  if (stage.kind === "question") {
    return (
      <QuestionCard
        question={stage.question}
        answerable={stage.answerable}
        onAnswer={() => {
          const next = answered(confirmations, stage.question);
          if (next === null) return;
          setConfirmations(next);
          run(next);
        }}
        onClose={props.onClose}
      />
    );
  }

  return (
    <Card className="flex flex-col gap-2 p-4" data-testid="compose-failed">
      {/* ⚠️ „UNBEKANNT" UND NICHT „NICHT ANGEWANDT". Der Strom endete ohne
          Abschlusszeile oder mit einer Ausnahme; die Datei kann geschrieben und
          der Stack halb gestartet sein. Wer daraus „ging nicht" macht, schickt
          den Betreiber in einen zweiten Versuch gegen einen Hash, der nicht
          mehr stimmt. */}
      <p className="text-[13px] font-medium text-destructive">{t("composeApplyUnknown")}</p>
      {/* Der Grund steht roh da, wenn es einen gibt — und gar nicht, wenn
          keiner kam (#176). Eine leere oder erfundene Zeile sähe aus wie eine
          Auskunft. */}
      {stage.reason === null ? null : (
        <p className="font-mono text-[12px] text-muted-foreground" data-testid="compose-failed-reason">
          {stage.reason}
        </p>
      )}
      <Button className="self-start" size="sm" onClick={props.onReload}>
        {t("composeReload")}
      </Button>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function ConfirmList({
  title,
  note,
  entries,
  checked,
  onToggle,
  testId
}: {
  title: string;
  note?: string;
  entries: readonly string[];
  checked: ReadonlySet<string>;
  onToggle: (value: string) => void;
  testId: string;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[13px] font-medium">{title}</p>
      {note ? <p className="text-[12px] text-muted-foreground">{note}</p> : null}
      {entries.map((entry) => (
        <label key={entry} className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            data-testid={`${testId}-${entry}`}
            checked={checked.has(entry)}
            onChange={() => onToggle(entry)}
          />
          <span className="font-mono text-[12.5px]">{entry}</span>
        </label>
      ))}
    </div>
  );
}

function PreviewCard({
  preview,
  changed,
  confirmations,
  onToggle,
  onApply,
  onClose
}: {
  preview: ComposeDryRun;
  changed: boolean;
  confirmations: Confirmations;
  onToggle: (next: Confirmations) => void;
  onApply: () => void;
  onClose: () => void;
}) {
  const t = useTranslations();
  const demands = demandsOf(preview);
  const blocker = blockerOf(preview, confirmations, changed);

  return (
    <Card className="flex flex-col gap-4 p-4" data-testid="compose-preview">
      <div className="flex items-baseline gap-3">
        <p className="text-[13px] font-medium">{t("composePreviewTitle")}</p>
        {/* ⚠️ WER GERECHNET HAT, STEHT DA. Beim eigenen Rechenweg sind
            `extends`, `include` und Profile NICHT aufgelöst, und die fehlenden
            Images kennt niemand. Eine Vorschau, die verschweigt, dass sie eine
            Näherung ist, wiegt den Betreiber in Sicherheit. */}
        <span className="text-[12px] text-muted-foreground" data-testid="compose-preview-source">
          {preview.source === "agent" ? t("composePreviewByAgent") : t("composePreviewByHub")}
        </span>
      </div>

      {!preview.valid ? (
        <p className="text-[13px] text-destructive" data-testid="compose-preview-invalid">
          {t("composePreviewInvalid", { reason: preview.reason ?? "" })}
        </p>
      ) : null}
      {preview.configError !== null ? (
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[12px] text-destructive">
          {preview.configError}
        </pre>
      ) : null}

      <ConfirmList
        title={t("composeConfirmNew")}
        note={t("composeConfirmNewNote")}
        entries={demands.services}
        checked={confirmations.services}
        onToggle={(value) => onToggle({ ...confirmations, services: toggled(confirmations.services, value) })}
        testId="confirm-new"
      />
      <ConfirmList
        title={t("composeConfirmRemoved")}
        note={t("composeConfirmRemovedNote")}
        entries={demands.removed}
        checked={confirmations.removed}
        onToggle={(value) => onToggle({ ...confirmations, removed: toggled(confirmations.removed, value) })}
        testId="confirm-removed"
      />

      {/* ⚠️ `null` HEISST „NICHT ERHOBEN" UND NICHT „KEINE FEHLEN". Ein leerer
          Abschnitt hiesse „nichts zu ziehen" — eine Beruhigung über etwas, das
          niemand geprüft hat. */}
      {demands.images === null ? (
        <p className="text-[12px] text-muted-foreground" data-testid="compose-images-unknown">
          {t("composeImagesUnknown")}
        </p>
      ) : (
        <ConfirmList
          title={t("composeConfirmImages")}
          note={t("composeConfirmImagesNote")}
          entries={demands.images}
          checked={confirmations.images}
          onToggle={(value) => onToggle({ ...confirmations, images: toggled(confirmations.images, value) })}
          testId="confirm-image"
        />
      )}

      {/* Die Härtung: bestehende Befunde als Auskunft, neue als Ansage. */}
      {preview.inventoryViolations.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-[13px] font-medium">{t("composeExistingViolations")}</p>
          <p className="text-[12px] text-muted-foreground">{t("composeExistingViolationsNote")}</p>
          <ul className="font-mono text-[12.5px] text-muted-foreground">
            {preview.inventoryViolations.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-[12px] text-muted-foreground">{t("composeHardeningLater")}</p>

      {preview.uncertainties.length > 0 ? (
        <p className="text-[12px] text-state-warn" data-testid="compose-uncertainties">
          {t("composeUncertainties", { list: preview.uncertainties.join(", ") })}
        </p>
      ) : null}

      {/* ⚠️ DIE SCHRITTE STEHEN VORHER DA, ALS LISTE OHNE VERLAUF. Sie sagen,
          was gleich passiert — nicht, wie weit es ist. */}
      <div className="flex flex-col gap-1">
        <p className="text-[13px] font-medium">{t("composeStepsTitle")}</p>
        <ol className="flex flex-wrap gap-x-3 text-[12px] text-muted-foreground" data-testid="compose-steps">
          {preview.steps.map((step) => (
            <li key={step}>{stepText(t, step)}</li>
          ))}
        </ol>
      </div>

      <div className="flex items-center gap-3">
        <Button size="sm" disabled={blocker !== null} data-testid="compose-apply" onClick={onApply}>
          {t("composeApply")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("cancel")}
        </Button>
        {blocker !== null ? (
          <span className="text-[12px] text-muted-foreground" data-testid="compose-blocker">
            {blockerText(t, blocker)}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

/** Ein Schritt der Strecke als Text; ein unbekannter steht wörtlich da. */
function stepText(t: ReturnType<typeof useTranslations>, step: string): string {
  const key = composeStepKey(step);
  return key === null ? step : t(key);
}

/** Warum der Knopf noch nicht geht — in einem Satz, der den Grund nennt. */
function blockerText(t: ReturnType<typeof useTranslations>, blocker: Blocker): string {
  switch (blocker.reason) {
    case "unchanged":
      return t("composeBlockerNoChange");
    case "invalid":
      return t("composeBlockerInvalid");
    case "stale-confirmation":
      return t("composeBlockerStale");
    case "unconfirmed-images":
      return t("composeBlockerImages", { count: blocker.missing.length });
    case "unconfirmed-removed":
      return t("composeBlockerRemoved", { count: blocker.missing.length });
    default:
      return t("composeBlockerServices", { count: blocker.missing.length });
  }
}

function QuestionCard({
  question,
  answerable,
  onAnswer,
  onClose
}: {
  question: ComposeQuestion;
  answerable: boolean;
  onAnswer: () => void;
  onClose: () => void;
}) {
  const t = useTranslations();
  const rolledBack =
    "rolledBack" in question ? question.rolledBack : null;

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="compose-question">
      <p className="text-[13px] font-medium">{t("composeQuestionTitle")}</p>
      <p className="text-[13px]">{questionText(t, question)}</p>

      {/* ⚠️ `rolledBack: false` IST DIE WICHTIGSTE ZEILE DIESER KARTE. Bei den
          Fragen, die NACH dem Schreiben entstehen, steht der Host dann in einem
          Zustand, den niemand gewollt hat — die neue Datei liegt da, der Stack
          läuft nicht wie vorher. Das darf nicht neben „bitte bestätigen"
          verschwinden. */}
      {rolledBack === false ? (
        <p className="text-[13px] text-destructive" data-testid="compose-not-rolled-back">
          {t("composeNotRolledBack")}
        </p>
      ) : null}
      {rolledBack === true ? (
        <p className="text-[12px] text-muted-foreground">{t("composeRolledBack")}</p>
      ) : null}

      <div className="flex gap-3">
        {answerable ? (
          <Button size="sm" data-testid="compose-answer" onClick={onAnswer}>
            {t("composeAnswerAndRetry")}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("cancel")}
        </Button>
      </div>
    </Card>
  );
}

function questionText(t: ReturnType<typeof useTranslations>, question: ComposeQuestion): string {
  switch (question.kind) {
    case "services":
      return t("composeQuestionServices", {
        added: question.added.join(", ") || "—",
        removed: question.removed.join(", ") || "—"
      });
    case "images":
      return t("composeQuestionImages", { list: question.missing.join(", ") });
    case "hardening":
      return t("composeQuestionHardening", { list: question.newViolations.join(", ") });
    case "changed-elsewhere":
      return t("composeQuestionChangedElsewhere");
    case "start-failed":
      return t("composeQuestionStartFailed", { detail: question.detail });
    case "container-missing":
      return t("composeQuestionContainerMissing", { detail: question.detail });
    case "anchor-stale":
      return t("composeQuestionAnchorStale");
    case "image-ref-unreadable":
      return t("composeQuestionImageRefUnreadable", { ref: question.ref });
    default:
      return t("composeQuestionInvalidDraft", { detail: question.detail });
  }
}
