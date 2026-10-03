import { useTranslations } from "use-intl";

import type { AgentUpdateLastRun } from "./api";
import type { DockerHost } from "../../domain/hosts";
import { describeOutcome } from "./AgentUpdate";
import { useAgentUpdateStatus } from "./host-queries";
import { Timestamp } from "./Timestamp";

// „Letztes Agent-Update“ auf der Karte eines Arms (#205): wann der Watcher
// zuletzt getauscht hat und wie es ausging.
//
// Die Auskunft kommt vom ARM (`GET /self-update`, durchgereicht von
// `GET /api/hosts/:hostId/agent-update`) und nicht aus einer Ablage des Hubs:
// der Watcher schreibt den Ausgang in sein `/state`, auch für einen Tausch,
// den ein anderer Hub oder ein Mensch an der Konsole angestoßen hat.
//
// ⚠️ NUR ZWEI ZEILEN IN DER FELDLISTE, ODER GAR KEINE. Die Route ist
// `requireAdmin`, und ein Arm ohne Antwort hat keinen Stand — in beiden Fällen
// steht die Zeile nicht da, statt einen Fehler zu zeigen, der mit der Karte
// nichts zu tun hat. Wer das Update anstößt, sieht dessen Ausgang ohnehin im
// Knopf daneben.

function Outcome({ run }: { run: AgentUpdateLastRun }) {
  const t = useTranslations();
  const outcome = describeOutcome(t, run);
  return (
    <span className={outcome.tone === "ok" ? "block text-muted-foreground" : "block text-destructive"}>
      {outcome.message}
    </span>
  );
}

export function LastAgentUpdate({ host }: { host: DockerHost }) {
  const t = useTranslations();
  // Read again whenever the list is measured again (`host-queries.ts`).
  const status = useAgentUpdateStatus(host.id);
  const last = status.data?.last;
  const loaded =
    status.data === undefined ? null : last == null ? { kind: "none" as const } : { kind: "run" as const, run: last };

  if (loaded === null) return null;
  return (
    <>
      <dt className="text-muted-foreground">{t("hostLastUpdateLabel")}</dt>
      <dd data-testid={`last-agent-update-${host.id}`}>
        {loaded.kind === "none" ? (
          <span className="text-muted-foreground">{t("hostLastUpdateNone")}</span>
        ) : (
          <>
            {loaded.run.finishedAt === null ? (
              <span className="text-muted-foreground">{t("hostLastUpdateUnknownTime")}</span>
            ) : (
              <Timestamp at={loaded.run.finishedAt} />
            )}
            <Outcome run={loaded.run} />
          </>
        )}
      </dd>
    </>
  );
}
