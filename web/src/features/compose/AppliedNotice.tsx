import { useTranslations } from "use-intl";

import type { ComposeResync } from "./api";
import { Card } from "../../platform/ui/shadcn/card";
import { resyncWarns } from "./apply-state";

// Der Vermerk „Angewandt." über der neu gelesenen Datei (#233).
//
// ⚠️ ER STEHT ÜBER DER DATEI UND NICHT STATT IHRER. Bis #233 war er eine Karte
// am Ende der Anwende-Strecke, und die Datei darüber war noch der Stand von
// vorher; der Betreiber musste erst „Neu laden" drücken. Jetzt liest der
// Reiter sofort neu, und der Vermerk sagt nur noch, was eben passiert ist.

export function AppliedNotice({ resync }: { resync: ComposeResync }) {
  const t = useTranslations();
  return (
    <Card className="flex flex-col gap-2 p-4" data-testid="compose-applied">
      <p className="text-[13px] font-medium">{t("composeApplied")}</p>
      {/* ⚠️ EIN GESCHEITERTER ABGLEICH WIRD GESAGT. Das Anwenden gilt — die
          Datei ist geschrieben, der Stack läuft —, aber der Arm trägt bis zum
          nächsten Takt die alten Container-Ids, und jede weitere Aktion an
          diesem Stack läuft in eine Ablehnung, die wie ein Rechteproblem
          aussieht. Wer das verschweigt, lässt den Betreiber raten. */}
      {resyncWarns(resync.status) ? (
        <p className="text-[13px] text-state-warn" data-testid="compose-resync-warning">
          {resync.status === null
            ? t("composeResyncFailedWithoutStatus")
            : t("composeResyncFailed", { status: resync.status })}
        </p>
      ) : null}
    </Card>
  );
}
