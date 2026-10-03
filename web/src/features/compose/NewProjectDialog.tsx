import { FolderPlus } from "lucide-react";
import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Messages } from "use-intl";
import { useTranslations } from "use-intl";

import type { MountSource } from "contract";
import { queryKeys } from "../../platform/query/query-keys";
import { Button } from "../../platform/ui/shadcn/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "../../platform/ui/shadcn/dialog";
import { Input } from "../../platform/ui/shadcn/input";
import { Label } from "../../platform/ui/shadcn/label";
import { resyncWarns, toggled } from "./apply-state";
import { ComposeEditor } from "./ComposeEditor";
import { ConfirmList } from "./ConfirmList";
import { questionText } from "./compose-question-text";
import { projectErrorKey } from "./project-errors";
import {
  createProject,
  previewProject,
  projectDirRemovedOf,
  type ComposeQuestion,
  type ComposeResync,
  type ProjectPreview
} from "./api";
import {
  NO_PROJECT_CONFIRMATIONS,
  projectAnswered,
  projectBlockerOf,
  projectDemandsOf,
  projectInputOf,
  type ProjectBlocker,
  type ProjectConfirmations
} from "./project-state";

// "New project" on a host (#3): name and compose draft, the agent's dry run,
// the confirmations it asks for, then the create. The agent decides every
// check; this dialog only collects the answers it names.

const TEMPLATE = "services:\n  app:\n    image: \n    restart: unless-stopped\n";

type Failure = { error: unknown; projectDirRemoved: boolean | null };

type Phase =
  | { kind: "editing" }
  | { kind: "creating" }
  | { kind: "question"; question: ComposeQuestion; projectDirRemoved: boolean | null }
  | { kind: "created"; project: Record<string, unknown>; resync: ComposeResync };

const SOURCE_KIND_KEYS: Record<MountSource["kind"], keyof Messages> = {
  project: "projectSourceProject",
  external: "projectSourceExternal",
  volume: "projectSourceVolume"
};

export function NewProjectDialog({ hostId, hostName }: { hostId: string; hostName: string }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [content, setContent] = useState(TEMPLATE);
  const [preview, setPreview] = useState<ProjectPreview | null>(null);
  const [previewedFor, setPreviewedFor] = useState<{ name: string; content: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirmations, setConfirmations] = useState<ProjectConfirmations>(NO_PROJECT_CONFIRMATIONS);
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });
  const [failure, setFailure] = useState<Failure | null>(null);

  const blockerId = useId();
  const previewed = previewedFor !== null && previewedFor.name === name.trim() && previewedFor.content === content;
  const blocker = projectBlockerOf(name, preview, previewed, confirmations);

  // An open question belongs to the checked draft; editing ends it, so it can
  // never be answered for a draft the dry run did not see.
  const edited = (apply: () => void): void => {
    apply();
    if (phase.kind === "question") setPhase({ kind: "editing" });
  };

  const reset = (): void => {
    setName("");
    setContent(TEMPLATE);
    setPreview(null);
    setPreviewedFor(null);
    setConfirmations(NO_PROJECT_CONFIRMATIONS);
    setPhase({ kind: "editing" });
    setFailure(null);
  };

  const check = async (): Promise<void> => {
    setChecking(true);
    setFailure(null);
    setPhase({ kind: "editing" });
    try {
      const next = await previewProject(hostId, name.trim(), content);
      setPreview(next);
      setPreviewedFor({ name: name.trim(), content });
      setConfirmations(NO_PROJECT_CONFIRMATIONS);
    } catch (error) {
      setFailure({ error, projectDirRemoved: null });
    } finally {
      setChecking(false);
    }
  };

  const create = async (answers: ProjectConfirmations): Promise<void> => {
    setPhase({ kind: "creating" });
    setFailure(null);
    try {
      const outcome = await createProject(hostId, projectInputOf(name, content, answers));
      if (outcome.kind === "created") {
        await queryClient.invalidateQueries({ queryKey: queryKeys.hosts.all });
        await queryClient.invalidateQueries({ queryKey: queryKeys.containers.overview() });
        setPhase({ kind: "created", project: outcome.project, resync: outcome.resync });
        return;
      }
      setPhase({ kind: "question", question: outcome.question, projectDirRemoved: outcome.projectDirRemoved });
    } catch (error) {
      setFailure({ error, projectDirRemoved: projectDirRemovedOf(error) });
      setPhase({ kind: "editing" });
    }
  };

  const answer = (question: ComposeQuestion): void => {
    const next = projectAnswered(confirmations, question);
    if (next === null || !previewed) return;
    setConfirmations(next);
    void create(next);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A running create continues at the agent; closing only stops watching.
        setOpen(next);
        if (!next && phase.kind !== "creating") reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" data-testid={`project-new-${hostId}`}>
          <FolderPlus aria-hidden="true" />
          {t("projectNewAction")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("projectNewTitle", { host: hostName })}</DialogTitle>
          <DialogDescription>{t("projectNewDescription")}</DialogDescription>
        </DialogHeader>

        {phase.kind === "created" ? (
          <CreatedCard project={phase.project} resync={phase.resync} onClose={() => setOpen(false)} />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`project-name-${hostId}`}>{t("projectNameLabel")}</Label>
              <Input
                id={`project-name-${hostId}`}
                value={name}
                onChange={(event) => {
                  const value = event.target.value;
                  edited(() => setName(value));
                }}
                disabled={phase.kind === "creating"}
                autoComplete="off"
                spellCheck={false}
                data-testid="project-name"
              />
              <p className="text-[12px] text-muted-foreground">{t("projectNameHint")}</p>
            </div>

            <div className="overflow-hidden rounded-md border border-border">
              <ComposeEditor
                value={content}
                onChange={(value) => edited(() => setContent(value))}
                disabled={phase.kind === "creating"}
              />
            </div>

            <div className="flex items-center gap-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={checking || phase.kind === "creating" || name.trim().length === 0}
                onClick={() => void check()}
                data-testid="project-check"
              >
                {t("projectCheck")}
              </Button>
              {preview !== null && !previewed ? (
                <span className="text-[12px] text-muted-foreground">{t("projectPreviewStale")}</span>
              ) : null}
            </div>

            {failure !== null ? <FailureNote failure={failure} /> : null}

            {preview !== null && previewed ? (
              <PreviewSection preview={preview} confirmations={confirmations} onChange={setConfirmations} />
            ) : null}

            {phase.kind === "question" ? (
              <QuestionNote
                question={phase.question}
                projectDirRemoved={phase.projectDirRemoved}
                onAnswer={() => answer(phase.question)}
              />
            ) : null}

            {phase.kind === "creating" ? (
              <p className="text-[13px]" role="status" data-testid="project-creating">
                {t("projectCreating")}
              </p>
            ) : null}

            <div className="flex items-center gap-3">
              <Button
                type="button"
                size="sm"
                disabled={blocker !== null || phase.kind === "creating"}
                onClick={() => void create(confirmations)}
                aria-describedby={blocker !== null ? blockerId : undefined}
                data-testid="project-create"
              >
                {t("projectCreate")}
              </Button>
              {blocker !== null ? (
                <span id={blockerId} className="text-[12px] text-muted-foreground" data-testid="project-blocker">
                  {blockerText(t, blocker)}
                </span>
              ) : null}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PreviewSection({
  preview,
  confirmations,
  onChange
}: {
  preview: ProjectPreview;
  confirmations: ProjectConfirmations;
  onChange: (next: ProjectConfirmations) => void;
}) {
  const t = useTranslations();
  const demands = projectDemandsOf(preview);
  return (
    <div className="flex flex-col gap-4 rounded-md border border-border p-4" data-testid="project-preview">
      <p className="text-[13px]">
        {t("projectDirectory")} <span className="font-mono">{preview.projectDir}</span>
      </p>
      {!preview.valid ? (
        <p className="text-[13px] text-destructive">{t("composePreviewInvalid", { reason: preview.reason ?? "" })}</p>
      ) : null}
      {preview.configError !== null ? (
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[12px] text-destructive">{preview.configError}</pre>
      ) : null}

      <ConfirmList
        title={t("projectConfirmServices")}
        entries={demands.services}
        checked={confirmations.services}
        onToggle={(value) => onChange({ ...confirmations, services: toggled(confirmations.services, value) })}
        testId="project-confirm-service"
      />
      {demands.images === null ? (
        <p className="text-[12px] text-muted-foreground">{t("composeImagesUnknown")}</p>
      ) : (
        <ConfirmList
          title={t("composeConfirmImages")}
          note={t("composeConfirmImagesNote")}
          entries={demands.images}
          checked={confirmations.images}
          onToggle={(value) => onChange({ ...confirmations, images: toggled(confirmations.images, value) })}
          testId="project-confirm-image"
        />
      )}

      {preview.mountSources.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-[13px] font-medium">{t("projectSources")}</p>
          <ul className="flex flex-col gap-0.5 text-[12.5px]" data-testid="project-sources">
            {preview.mountSources.map((source, index) => (
              <li key={`${source.service}-${source.target}-${index}`} className="flex flex-wrap gap-x-2">
                <span className="font-mono">{source.service}</span>
                <span className="text-muted-foreground">{t(SOURCE_KIND_KEYS[source.kind])}</span>
                <span className="font-mono">{source.source ?? t("projectSourceAnonymous")}</span>
                <span className="text-muted-foreground">→</span>
                <span className="font-mono">{source.target}</span>
                {source.readOnly ? <span className="text-muted-foreground">{t("projectSourceReadOnly")}</span> : null}
                {source.shared ? <span className="text-state-warn">{t("projectSourceShared")}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ConfirmList
        title={t("projectConfirmExternal")}
        note={t("projectConfirmExternalNote")}
        entries={demands.external}
        checked={confirmations.external}
        onToggle={(value) => onChange({ ...confirmations, external: toggled(confirmations.external, value) })}
        testId="project-confirm-external"
      />
      <p className="text-[12px] text-muted-foreground">{t("composeHardeningLater")}</p>
    </div>
  );
}

function QuestionNote({
  question,
  projectDirRemoved,
  onAnswer
}: {
  question: ComposeQuestion;
  projectDirRemoved: boolean | null;
  onAnswer: () => void;
}) {
  const t = useTranslations();
  const answerable = projectAnswered(NO_PROJECT_CONFIRMATIONS, question) !== null;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-4" data-testid="project-question">
      <p className="text-[13px]">{questionText(t, question)}</p>
      {"rolledBack" in question && question.rolledBack === false ? (
        <p className="text-[13px] text-destructive">{t("composeNotRolledBack")}</p>
      ) : null}
      {projectDirRemoved === false ? (
        <p className="text-[13px] text-state-warn">{t("projectDirectoryLeft")}</p>
      ) : null}
      {answerable ? (
        <Button type="button" size="sm" className="self-start" onClick={onAnswer} data-testid="project-answer">
          {t("projectAnswerAndRetry")}
        </Button>
      ) : null}
    </div>
  );
}

function FailureNote({ failure }: { failure: Failure }) {
  const t = useTranslations();
  return (
    <div className="flex flex-col gap-1" data-testid="project-failure">
      <p className="text-[13px] text-destructive">{t(projectErrorKey(failure.error))}</p>
      {failure.projectDirRemoved === false ? (
        <p className="text-[13px] text-state-warn">{t("projectDirectoryLeft")}</p>
      ) : null}
    </div>
  );
}

function CreatedCard({
  project,
  resync,
  onClose
}: {
  project: Record<string, unknown>;
  resync: ComposeResync;
  onClose: () => void;
}) {
  const t = useTranslations();
  const projectDir = typeof project.projectDir === "string" ? project.projectDir : "";
  const restartLooping = Array.isArray(project.restartLooping) ? project.restartLooping.length : 0;
  return (
    <div className="flex flex-col gap-2" data-testid="project-created">
      <p className="text-[13px] font-medium">{t("projectCreated")}</p>
      <p className="font-mono text-[12.5px]">{projectDir}</p>
      {restartLooping > 0 ? (
        <p className="text-[13px] text-state-warn">{t("projectRestartLooping", { count: restartLooping })}</p>
      ) : null}
      {project.hubOwned === false ? (
        <p className="text-[13px] text-state-warn">{t("projectMarkerMissing")}</p>
      ) : null}
      {resyncWarns(resync.status) ? (
        <p className="text-[13px] text-state-warn">{t("projectResyncWarning")}</p>
      ) : null}
      <Button type="button" size="sm" className="self-start" onClick={onClose}>
        {t("composeSelectionClose")}
      </Button>
    </div>
  );
}

function blockerText(t: ReturnType<typeof useTranslations>, blocker: ProjectBlocker): string {
  switch (blocker.reason) {
    case "name-missing":
      return t("projectBlockerName");
    case "not-previewed":
      return t("projectBlockerCheck");
    case "invalid":
      return t("composeBlockerInvalid");
    case "unconfirmed-services":
      return t("composeBlockerServices", { count: blocker.missing.length });
    case "unconfirmed-images":
      return t("composeBlockerImages", { count: blocker.missing.length });
    case "unconfirmed-external":
      return t("projectBlockerExternal", { count: blocker.missing.length });
    default:
      return t("projectBlockerStale");
  }
}
