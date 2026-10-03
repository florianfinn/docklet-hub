import type {
  HostCycleOutcome,
  HostRecord,
  HostRouteAccessResult,
  HostRouteRequest,
  RouteWriting
} from "../../domain/hosts/index.js";
import { AgentError, type Actor } from "../../platform/agent-transport/protocol.js";
import type { RouteFailure } from "../../platform/http/route-failure.js";
import { MAX_COMPOSE_BYTES } from "./agent-client.js";
import * as projectClient from "./project-client.js";
import type { ProjectPreview } from "./project-client.js";
import type { ComposeQuestion } from "./types.js";

// Creating a hub-owned project (#3, decisions in #128): the dry run and the
// create on a host, before any container exists. The agent derives the
// directory from the name and checks every confirmation itself; the hub only
// refuses what costs nothing to refuse and reconciles the registry afterwards.

export type ProjectAgent = Pick<typeof projectClient, "previewProjectOnAgent" | "createProjectOnAgent">;

export type ProjectServiceDeps = {
  openHost: (request: HostRouteRequest, writing: RouteWriting) => Promise<HostRouteAccessResult>;
  /** The reconciliation after a create; absent means "not wired", and the answer says so. */
  resyncHost?: (record: HostRecord, actor: Actor) => Promise<HostCycleOutcome>;
  agent?: ProjectAgent;
};

type Failed = { ok: false; failure: RouteFailure };

export type ProjectCreateOutcome =
  | { kind: "created"; project: Record<string, unknown>; resync: { status: string; error: string | null } }
  | { kind: "question"; question: ComposeQuestion; projectDirRemoved: boolean | null };

export type ProjectService = {
  preview: (ref: HostRouteRequest, body: unknown) => Promise<Failed | { ok: true; preview: ProjectPreview }>;
  create: (ref: HostRouteRequest, body: unknown) => Promise<Failed | { ok: true; outcome: ProjectCreateOutcome }>;
};

function problem(status: number, error: string, message: string): Failed {
  return { ok: false, failure: { kind: "problem", status, error, message } };
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function listField(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

type Draft = { name: string; content: string; fields: Record<string, unknown> };

/** Name and size, checked before the agent is asked; the agent decides the rest. */
function draftOf(body: unknown): Failed | { ok: true; draft: Draft } {
  const fields = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const name = textField(fields.name).trim();
  const content = textField(fields.content);
  if (name.length === 0) return problem(400, "project-name-missing", "Ein neues Projekt braucht einen Namen.");
  if (Buffer.byteLength(content, "utf8") > MAX_COMPOSE_BYTES) {
    return problem(413, "too-large", `Eine Compose-Datei darf höchstens ${MAX_COMPOSE_BYTES} Bytes tragen.`);
  }
  return { ok: true, draft: { name, content, fields } };
}

export function createProjectService(deps: ProjectServiceDeps): ProjectService {
  const agent: ProjectAgent = deps.agent ?? projectClient;

  async function asked<T>(call: () => Promise<T>): Promise<{ ok: true; value: T } | Failed> {
    try {
      return { ok: true, value: await call() };
    } catch (error) {
      if (!(error instanceof AgentError)) throw error;
      return { ok: false, failure: { kind: "agent-error", error } };
    }
  }

  // A failed reconciliation does not undo a create; it is reported next to it,
  // because the new containers stay unreachable until the registry knows them.
  async function resync(host: HostRecord, actor: Actor): Promise<{ status: string; error: string | null }> {
    if (!deps.resyncHost) return { status: "skipped", error: null };
    try {
      const outcome = await deps.resyncHost(host, actor);
      return { status: outcome.status, error: outcome.error };
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    // Opens as `writes`: the dry run puts a directory under the base path for
    // the duration of the check, and it only prepares a create.
    preview: async (ref, body) => {
      const parsed = draftOf(body);
      if (!parsed.ok) return parsed;
      const opened = await deps.openHost(ref, "writes");
      if (!opened.ok) return opened;
      const { access } = opened;
      const preview = await asked(() =>
        agent.previewProjectOnAgent(access.target, parsed.draft.name, parsed.draft.content, access.options)
      );
      return preview.ok ? { ok: true, preview: preview.value } : preview;
    },

    create: async (ref, body) => {
      const parsed = draftOf(body);
      if (!parsed.ok) return parsed;
      const opened = await deps.openHost(ref, "writes");
      if (!opened.ok) return opened;
      const { access } = opened;
      const { name, content, fields } = parsed.draft;
      const created = await asked(() =>
        agent.createProjectOnAgent(
          access.target,
          {
            name,
            content,
            confirmNew: listField(fields.confirmNew),
            acknowledgeImagePull: listField(fields.acknowledgeImagePull),
            acknowledgeHardening: listField(fields.acknowledgeHardening),
            confirmExternalSources: listField(fields.confirmExternalSources)
          },
          access.options
        )
      );
      if (!created.ok) return created;
      if (!created.value.ok) {
        return {
          ok: true,
          outcome: {
            kind: "question",
            question: created.value.question,
            projectDirRemoved: created.value.projectDirRemoved
          }
        };
      }
      // Awaited before answering: the surface reloads right after, and the new
      // containers must already be in the agent's registry by then.
      const resynced = await resync(access.host, access.options.actor);
      return { ok: true, outcome: { kind: "created", project: created.value.body, resync: resynced } };
    }
  };
}
