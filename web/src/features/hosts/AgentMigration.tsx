import { useTranslations } from "use-intl";

import type { DockerHost } from "../../domain/hosts";

// The note on the card of an arm whose agent this hub no longer understands
// (R38, #280). `outdated` means two things (`deriveHostStatus`, server
// `domain/hosts/host-store.ts`): a version below `MIN_AGENT_VERSION`, or a
// protocol number below `CONTRACT_VERSION`. Both are the same step for the
// operator — the agent of this repository replaces the old one — so there is
// one note and not one per cause.
//
// ⚠️ The step is done by hand, once, on the host, and the hub only says so: the
// old agent cannot follow the new image name by itself
// (`target-foreign-repository`). The line to set is the one the hub pins
// (`offer.targetImageRef`), not a literal here — a literal would stay behind
// at the next release.
//
// An arm that is `outdated` only by its protocol but already reads a target
// (`available`, version 0.32.0 or later) moves with the button of
// `AgentUpdate`; a note that sends the operator to the host by hand would
// contradict the button next to it.
export function AgentMigration({ host }: { host: DockerHost }) {
  const t = useTranslations();
  if (host.status !== "outdated" || host.kind === "local") return null;
  const offer = host.agentUpdate;
  if (offer?.state === "available") return null;

  return (
    <div
      role="note"
      className="mx-4 mb-3 rounded-md border border-state-down/40 bg-state-down/10 px-3 py-2.5 text-sm"
      data-testid={`agent-migration-${host.id}`}
    >
      <p className="font-medium text-state-down">{t("hostMigrationTitle")}</p>
      <p className="mt-1 text-muted-foreground">{t("hostMigrationBody")}</p>
      <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-muted-foreground">
        <li>
          {t("hostMigrationStepImage")}
          {offer === null ? null : (
            <code className="mt-1 block break-all font-mono text-xs text-foreground">
              {t("hostAgentUpdateManualLine", { imageRef: offer.targetImageRef })}
            </code>
          )}
        </li>
        <li>
          {t("hostMigrationStepRestart")}
          <code className="mt-1 block font-mono text-xs text-foreground">{t("hostMigrationRestartCommand")}</code>
        </li>
      </ol>
    </div>
  );
}
