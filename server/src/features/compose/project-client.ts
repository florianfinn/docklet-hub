import { mountSourceSchema, type MountSource } from "contract";
import { AgentError, agentPost, type AgentTarget } from "../../platform/agent-transport/protocol.js";
import { COMPOSE_APPLY_TIMEOUT_MS } from "./agent-client.js";
import { composeQuestionOf } from "./reasons.js";
import type { ComposeQuestion, ComposeRequestOptions } from "./types.js";
import { asFlag, asRecord, asText, asTextList, asTextMap } from "./wire-readers.js";

// The agent side of creating a hub-owned project (#3): the dry run
// `POST /stacks/raw-preview` and the create `POST /stacks/raw`. Both name the
// project only by its name; the agent derives the directory from it.

/** The dry run of a new project, as the agent reported it. */
export type ProjectPreview = {
  projectDir: string;
  stackName: string;
  valid: boolean;
  reason: string | null;
  errors: string[];
  configError: string | null;
  services: string[] | null;
  imagesByService: Record<string, string>;
  missingImages: string[] | null;
  servicesWithoutImage: string[];
  mountSources: MountSource[];
  externalSources: string[];
};

/** Everything the person confirmed; the agent compares each list itself. */
export type ProjectCreateInput = {
  name: string;
  content: string;
  confirmNew: string[];
  acknowledgeImagePull: string[];
  acknowledgeHardening: string[];
  confirmExternalSources: string[];
};

// `projectDirRemoved` is the agent's cleanup after a failed create: `false`
// means a container left data in the directory, `null` that it did not say.
export type ProjectCreateResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; question: ComposeQuestion; projectDirRemoved: boolean | null };

const PREVIEW_ROUTE = "/stacks/raw-preview";
const CREATE_ROUTE = "/stacks/raw";

/** Unreadable entries are dropped: the agent is a foreign side. */
export function mountSourcesOf(value: unknown): MountSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = mountSourceSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export async function previewProjectOnAgent(
  target: AgentTarget,
  name: string,
  content: string,
  options: ComposeRequestOptions
): Promise<ProjectPreview> {
  const answer = asRecord(await agentPost(target, PREVIEW_ROUTE, { name, content }, options), PREVIEW_ROUTE);
  return {
    projectDir: asText(answer.projectDir),
    stackName: asText(answer.stackName),
    valid: asFlag(answer.valid),
    reason: typeof answer.reason === "string" ? answer.reason : null,
    errors: asTextList(answer.errors),
    configError: typeof answer.configError === "string" ? answer.configError : null,
    services: Array.isArray(answer.services) ? asTextList(answer.services) : null,
    imagesByService: asTextMap(answer.imagesByService),
    // `null` is "not surveyed", `[]` is "none missing".
    missingImages: Array.isArray(answer.missingImages) ? asTextList(answer.missingImages) : null,
    servicesWithoutImage: asTextList(answer.servicesWithoutImage),
    mountSources: mountSourcesOf(answer.mountSources),
    externalSources: asTextList(answer.externalSources)
  };
}

/** A refusal that names what to confirm is a question, not a failure. */
export async function createProjectOnAgent(
  target: AgentTarget,
  input: ProjectCreateInput,
  options: ComposeRequestOptions
): Promise<ProjectCreateResult> {
  try {
    const answer = await agentPost(target, CREATE_ROUTE, input, {
      ...options,
      // Same deadline as applying: the agent may pull, start and roll back.
      timeoutMs: options.timeoutMs ?? COMPOSE_APPLY_TIMEOUT_MS
    });
    return { ok: true, body: asRecord(answer, CREATE_ROUTE) };
  } catch (error) {
    if (!(error instanceof AgentError)) throw error;
    const question = composeQuestionOf(error);
    if (question === null) throw error;
    const removed = (error.detail as Record<string, unknown>).projectDirRemoved;
    return { ok: false, question, projectDirRemoved: typeof removed === "boolean" ? removed : null };
  }
}
