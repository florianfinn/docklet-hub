import { ArrowUpCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";

import { startAgentUpdate, type AgentUpdateLastRun } from "./api";
import { watchAgentUpdate } from "./agent-update-watch";
import type { DockerHost } from "../../domain/hosts";
import { ApiError, errorCode } from "../../platform/http/transport";
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

// Der Knopf „Agent aktualisieren" auf der Karte eines Arms (#7).
//
// Der Hub stößt nur an: der Agent legt einen Auftrag ab, sein Watcher zieht,
// prüft und tauscht (server/src/domain/hosts/self-update.ts). Diese Fläche fragt
// danach nach, bis der letzte Lauf des Arms die Auftragsnummer trägt, die der
// Anstoß zurückgab — erst dann ist der Ausgang DIESES Auftrags bekannt und
// nicht der eines früheren.
//
// ⚠️ WÄHREND DES TAUSCHS ANTWORTET DER ARM NICHT. Ein Fehler beim Nachfragen
// ist deshalb „läuft noch" und kein Abbruch; erst die Frist macht daraus eine
// Meldung. Sie ist großzügig, weil der Pull eines Images auf einem Arm hinter
// einer langsamen Leitung Minuten dauern kann.
//
// Both numbers (`POLL_MS`, `DEADLINE_MS`) and the loop itself stand in
// `agent-update-watch.ts` since #271.

type Translate = ReturnType<typeof useTranslations>;

type Phase =
  | { kind: "idle" }
  | { kind: "running"; jobId: string; startedAt: number }
  | { kind: "done"; tone: "ok" | "error"; message: string };

/** Der Schlüssel des Arms (`reason`) aus einer Fehlerantwort des Hubs. */
function agentReason(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  try {
    const parsed = JSON.parse(error.message) as { reason?: unknown };
    return typeof parsed.reason === "string" && parsed.reason !== "" ? parsed.reason : null;
  } catch {
    return null;
  }
}

export function describeStartError(t: Translate, error: unknown): string {
  const code = errorCode(error);
  const reason = agentReason(error);
  if (code === "agent-update-unavailable") return t("hostAgentUpdateUnavailable");
  // Die Schlüssel des Agenten stehen wörtlich da (AGENTS.md, Sprache): der Hub
  // spiegelt sie und übersetzt sie nicht.
  if (reason === "already-running") return t("hostAgentUpdateBusy");
  if (reason === "read-only") return t("hostAgentUpdateReadOnly");
  return reason === null ? t("hostAgentUpdateStartFailed") : t("hostAgentUpdateStartRejected", { reason });
}

export function describeOutcome(t: Translate, run: AgentUpdateLastRun): { tone: "ok" | "error"; message: string } {
  const reason = run.reason ?? t("hostAgentUpdateNoReason");
  switch (run.outcome) {
    case "ok":
      return { tone: "ok", message: t("hostAgentUpdateOk", { version: run.toVersion ?? "?" }) };
    case "unchanged":
      return { tone: "ok", message: t("hostAgentUpdateUnchanged") };
    case "aborted":
      return { tone: "error", message: t("hostAgentUpdateAborted", { reason }) };
    case "rolled-back":
      return { tone: "error", message: t("hostAgentUpdateRolledBack", { reason }) };
    case "failed":
      return { tone: "error", message: t("hostAgentUpdateFailed", { reason }) };
    default:
      return { tone: "error", message: t("hostAgentUpdateOutcomeUnknown", { outcome: run.outcome, reason }) };
  }
}

type AgentUpdateProps = {
  host: DockerHost;
  // Nach einem Ausgang: die Liste neu messen, damit Fassung und Angebot der
  // Karte stimmen.
  onFinished: () => void;
};

export function AgentUpdate({ host, onFinished }: AgentUpdateProps) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // Über eine Ref und nicht als Abhängigkeit: die Elternfläche reicht bei
  // jedem Zeichnen eine neue Funktion, und das Nachfragen begänne dann jedes
  // Mal von vorn.
  const finished = useRef(onFinished);
  useEffect(() => {
    finished.current = onFinished;
  }, [onFinished]);

  useEffect(() => {
    if (phase.kind !== "running") return;
    return watchAgentUpdate({
      hostId: host.id,
      jobId: phase.jobId,
      startedAt: phase.startedAt,
      onTimeout: () => setPhase({ kind: "done", tone: "error", message: t("hostAgentUpdateTimeout") }),
      onOutcome: (last) => {
        setPhase({ kind: "done", ...describeOutcome(t, last) });
        finished.current();
      }
    });
  }, [phase, host.id, t]);

  const start = () => {
    setBusy(true);
    setError(null);
    startAgentUpdate(host.id)
      .then((accepted) => {
        setOpen(false);
        setPhase({ kind: "running", jobId: accepted.jobId, startedAt: Date.now() });
      })
      .catch((cause: unknown) => setError(describeStartError(t, cause)))
      .finally(() => setBusy(false));
  };

  const offer = host.agentUpdate;
  const status =
    phase.kind === "running" ? (
      <p className="basis-full text-sm text-muted-foreground" role="status" data-testid={`agent-update-status-${host.id}`}>
        {t("hostAgentUpdateRunning")}
      </p>
    ) : phase.kind === "done" ? (
      <p
        className={phase.tone === "ok" ? "basis-full text-sm text-muted-foreground" : "basis-full text-sm text-destructive"}
        role="status"
        data-testid={`agent-update-status-${host.id}`}
      >
        {phase.message}
      </p>
    ) : null;

  // An `outdated` arm carries the same line in its migration note
  // (`AgentMigration`); two copies of one step on one card help nobody.
  if (offer?.state === "manual" && phase.kind === "idle" && host.status !== "outdated") {
    return (
      <div className="basis-full text-sm text-muted-foreground" data-testid={`agent-update-manual-${host.id}`}>
        <p>{t("hostAgentUpdateManual", { version: offer.targetVersion })}</p>
        <code className="mt-1 block break-all font-mono text-xs text-foreground">
          {t("hostAgentUpdateManualLine", { imageRef: offer.targetImageRef })}
        </code>
      </div>
    );
  }

  return (
    <>
      {/* Bei `current` steht der Knopf trotzdem da, gesperrt und mit der
          Fassung: der Betreiber sieht, dass es die Funktion gibt und warum sie
          gerade nichts zu tun hat. Ein ausgeblendeter Knopf las sich am
          2026-09-29 auf dem ersten Arm mit v0.30.0 als „fehlt“ (#202).
          Gesperrt und nicht drückbar: der Watcher zöge denselben Pin und
          meldete nur `unchanged`, und der Server nimmt nur `available` an. */}
      {offer?.state === "current" && phase.kind !== "running" ? (
        <Button type="button" variant="outline" size="sm" disabled data-testid={`agent-update-${host.id}`}>
          <ArrowUpCircle aria-hidden="true" />
          {t("hostAgentUpdateCurrent", { version: offer.targetVersion })}
        </Button>
      ) : null}
      {offer?.state === "available" && phase.kind !== "running" ? (
        <Dialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setError(null);
          }}
        >
          <DialogTrigger asChild>
            <Button type="button" variant="outline" size="sm" data-testid={`agent-update-${host.id}`}>
              <ArrowUpCircle aria-hidden="true" />
              {t("hostAgentUpdate", { version: offer.targetVersion })}
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[440px]">
            <DialogHeader>
              <DialogTitle>{t("hostAgentUpdateTitle")}</DialogTitle>
              <DialogDescription>
                {t("hostAgentUpdateConfirm", { name: host.name, version: offer.targetVersion })}
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">{t("hostAgentUpdateDetail")}</p>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  {t("cancel")}
                </Button>
              </DialogClose>
              <Button
                type="button"
                disabled={busy}
                onClick={start}
                data-testid={`agent-update-confirm-${host.id}`}
              >
                {busy ? t("loading") : t("hostAgentUpdateSubmit")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      {status}
    </>
  );
}
