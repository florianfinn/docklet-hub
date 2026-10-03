import { useTranslations } from "use-intl";

import type { ShareCandidate } from "./api";
import { Button } from "../../platform/ui/shadcn/button";
import { Card } from "../../platform/ui/shadcn/card";

// Die Wahl der Freigabe — der ERSTE der beiden Zustände dieser Fläche und der
// wichtigere.
//
// ⚠️ OHNE GEWÄHLTE FREIGABE GIBT ES KEINEN DATEIZUGRIFF. Der Agent antwortet
// auf jede Anfrage der Fläche mit `409`, und zwar zu Recht: was zugänglich ist,
// entscheidet der Betreiber, nicht die Oberfläche. Diese Fläche ist deshalb
// keine Zwischenstufe auf dem Weg zur Liste, sondern der Normalzustand jedes
// Containers, bei dem noch niemand gewählt hat.
//
// ⚠️ EIN CONTAINER OHNE KANDIDATEN BEKOMMT EINE ERKLÄRUNG UND KEINE LEERE
// LISTE. Eine leere Tabelle sähe aus wie eine Störung oder wie ein noch nicht
// fertiges Laden; tatsächlich ist es eine vollständige und richtige Antwort —
// dieser Container hat keinen Bind-Mount unterhalb seines Projektverzeichnisses.
// Dieselbe Entscheidung wie bei der leeren Allowlist in der Container-Übersicht.
//
// ⚠️ KEIN BAUTEIL, DAS SELBST HOLT. Die Kandidaten kommen als Angabe herein.
// Das ist der Grund, aus dem `web/tests/container-screen.test.tsx` einen
// geschlossenen Reiter auf einen ausgebliebenen Aufruf prüft: ein Bauteil, das
// beim Einhängen holt, schickt seine Anfrage auch dann, wenn es niemand sieht.

export function ShareChooser({
  candidates,
  onChoose,
  pending,
  error
}: {
  candidates: ShareCandidate[];
  onChoose: (relative: string) => void;
  /** Der Pfad, dessen Wahl gerade läuft — `null`, wenn keine läuft. */
  pending: string | null;
  /** Ein fertiger Satz, oder `null`. */
  error: string | null;
}) {
  const t = useTranslations();

  if (candidates.length === 0) {
    return (
      <Card className="gap-1 border-card-line bg-body-face p-4" data-testid="files-share-none">
        <p className="text-sm font-medium">{t("filesShareNoneTitle")}</p>
        <p className="max-w-prose text-[13px] text-muted-foreground">{t("filesShareNoneBody")}</p>
      </Card>
    );
  }

  return (
    <Card className="gap-3 border-card-line bg-body-face p-4" data-testid="files-share-chooser">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{t("filesShareTitle")}</p>
        <p className="max-w-prose text-[13px] text-muted-foreground">{t("filesShareBody")}</p>
      </div>

      {error === null ? null : (
        <p className="text-[13px] text-destructive" data-testid="files-share-error">
          {error}
        </p>
      )}

      <ul className="flex flex-col gap-1.5">
        {candidates.map((candidate) => (
          <li
            key={candidate.relative}
            data-testid="files-share-candidate"
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 rounded-md border border-card-line px-3 py-2"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-mono text-[13px] break-all">{candidate.relative}</span>
              <span className="text-[12px] text-subtle-foreground">
                {/* ⚠️ Das Ziel IM CONTAINER steht daneben und ist nicht das,
                    was gewählt wird: gespeichert wird `relative`, und der
                    Server vergleicht zeichengenau gegen genau dieses Feld
                    seiner eigenen Kandidatenliste. */}
                {t("filesShareDestination", { destination: candidate.destination })}
                {" · "}
                {candidate.writable ? t("filesShareWritable") : t("filesShareReadOnly")}
              </span>
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={pending !== null}
              data-testid={`files-share-choose-${candidate.relative}`}
              onClick={() => onChoose(candidate.relative)}
            >
              {pending === candidate.relative ? t("filesSharePending") : t("filesShareChoose")}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
