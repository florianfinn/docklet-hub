import type { useTranslations } from "use-intl";

import type { ComposeQuestion } from "./api";

// The sentence for a follow-up question of the agent, shared by applying a
// draft and creating a project.
export function questionText(t: ReturnType<typeof useTranslations>, question: ComposeQuestion): string {
  switch (question.kind) {
    case "services":
      return t("composeQuestionServices", {
        added: question.added.join(", ") || "—",
        removed: question.removed.join(", ") || "—"
      });
    case "images":
      return t("composeQuestionImages", { list: question.missing.join(", ") });
    case "external-sources":
      return t("composeQuestionExternalSources", { list: question.sources.join(", ") });
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
