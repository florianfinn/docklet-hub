import {
  registryEntrySchema,
  registryOriginSchema,
  type RegistryEntry as SyncedRegistryEntry,
  type RegistryOrigin
} from "contract";
import fs from "node:fs";
import path from "node:path";

// The agent's own copy of the allowlist (stage plan 3.4).
//
// Two independent copies instead of a single source of truth: the main API keeps
// docker_container_registry in Postgres, the agent keeps this file. The agent
// decides EXCLUSIVELY based on ITS copy — if the API sends a container that is
// not listed here, the action is rejected.
//
// Honest limit of this approach: the copy is maintained through a sync endpoint
// that the main API serves. A fully compromised API could therefore also add
// something here. The protection lies in sync being a separate, separately
// authenticated operation (not part of the normal action path) and in the
// hardening check applying independently of it: a smuggled-in entry gets nobody
// a container with a docker.sock mount or privileged.

// The compose anchor of an adopted container (stage 5d).
//
// Up to 5c the agent derived the directory from the container NAME
// (locationFor). That held as long as it only touched containers it had created
// itself. Adopted container names can differ from their project and service.
// The daemon labels supply the anchor independently of container names.
//
// That is why the anchor now lives IN THE ENTRY. It comes with the sync from the
// main API — which in turn has it from the adoption, i.e. from the labels of the
// running container. Decisive for the security model: the agent still reads it
// from ITS own copy and never from the request of the action (security review
// 5c). The path is checked against the base path nonetheless.
export type RegistryCompose = {
  projectDir: string;
  // Explicit compose project name from the daemon label. S11 strictly needs it
  // for stack actions; it stays optional only so that a registry file from
  // before S11 is not discarded entirely at startup. Such legacy entries remain
  // usable for container actions; stack actions reject them fail-closed until
  // the next sync supplies the field.
  projectName?: string;
  serviceName: string;
  composeFileName: string;
  // Who owns the compose file (stage 5d).
  //
  // 'dashboard' — created by the dashboard, may be rewritten from the
  //               spec.
  // 'adopted'   — belongs to the operator, is never written.
  //
  // ⚠️ 'adopted' was called 'adoptiert' until v0.24.0 (#80). The old wording is
  // still READ (`fromLegacyForms`), but no longer written — and that is no
  // cosmetics here: this value is the only one of the agent that the caller not
  // only reads but SENDS in EVERY entry of `PUT /registry`. Without the
  // transition `isRegistryCompose` would have discarded every entry with an
  // anchor, `replaceAll` would have silently filtered them out and the route
  // would still have acknowledged with 200: every container on every arm locked
  // for every action, without a single error message.
  //
  // ⚠️ Lives here even though the main API already checks the same. The agent is
  // the last authority and must explicitly NOT rely on the API having filtered
  // correctly — a promise that only holds as long as the other side plays
  // along is none. Without this field a bug in the server guard would have been
  // enough for apply-spec to overwrite the operator's file and run it with
  // removeOrphans.
  origin: RegistryOrigin;
};

// The values `registryOriginSchema` (contract) accepts; the contract endpoint
// reports the same list. A third origin has to be added there.
export const REGISTRY_COMPOSE_ORIGINS = registryOriginSchema.options;

export type RegistryEntry = {
  containerId: string;
  containerName: string;
  // Allowed image ref. A pull may pull exclusively this one.
  imageRef: string;
  allowed: boolean;
  // A container managed by someone else may deliver logs without its registry
  // row also unlocking start/stop, pull or exec (#78).
  // If the field is missing, the previous permission applies. If both switches
  // are true, the narrower observer class wins.
  observeOnly?: boolean;
  // A container whose DEFINITION someone else manages (today Unraid's
  // templates). It stays controllable — start/stop/restart, exec, files —,
  // but whatever changes its definition (pull, recreate, apply-spec, remove)
  // the manager would roll back on the next "Apply Update", so it stays
  // locked (#78, operator decision of 2026-09-30).
  // Only takes effect together with allowed=true; on its own it grants nothing.
  // It is set by the hub, never from the label on the container: the label is
  // only an explanation (S23), a foreign image could claim it.
  externallyManaged?: boolean;
  // Class "secured" (stage 5e, section 6.2): are bind mounts restricted to the
  // container's own universe (project directory)? If the value is missing in an
  // older allowlist file, "normal" (false) applies — the default.
  //
  // As with the compose anchor (security review 5c, finding 4) the agent reads
  // this class for running containers from ITS own copy and never from the
  // request of the respective action. On CREATE, where there is no entry yet,
  // it comes with the request — there it is only a TIGHTENING (the universe is
  // a subset of the base path), so no escalation.
  secured: boolean;
  // The share directory for web FTP (S19 — K6, §5.3). Relative to this
  // container's project directory, without a leading slash.
  //
  // ⚠️ Lives here — and not in the request of the respective action — for the
  // same reason as the compose anchor (security review 5c, finding 4), only
  // with higher stakes: for the file logs (S8) the relative part comes with the
  // request, because there it only allows READING. Through web FTP things are
  // also written and deleted. A root the caller is allowed to name would then
  // no longer be a share directory but a parameter.
  //
  // If the value is missing, there is no file access for this container. That
  // is the default and not a special case.
  sharePath?: string;
  // S20: MULTIPLE shares instead of one. Relative to the project directory,
  // without a leading slash. The agent does not distinguish whether a share
  // comes from a mount switch or from free input — that is information for the
  // UI, not for the check.
  //
  // `freigabePfad` (S19, a single one) is converted into this list when read,
  // so that a registry file from before does not suddenly end up without a
  // share.
  shares?: string[];
  // Missing for containers the dashboard created itself: there the anchor can
  // be derived from the name (locationFor).
  compose?: RegistryCompose;
};

export class AgentRegistry {
  private entries = new Map<string, RegistryEntry>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) throw new Error("allowlist file is not an array");
      this.entries = entriesOf(parsed);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Fail closed: no file means an empty allowlist, so no container
        // visible at all — not "everything allowed".
        this.entries = new Map();
        return;
      }
      // A broken file must not lead to "everything allowed" either.
      console.error("[registry] allowlist unreadable, continuing with an empty list:", error);
      this.entries = new Map();
    }
  }

  // `PUT /registry` has already refused a list with a broken entry
  // (`registrySyncRequestSchema`); the same filter runs here anyway, because
  // this method is the one way into the copy the agent decides on.
  replaceAll(entries: readonly unknown[]): void {
    this.entries = entriesOf(entries);
    this.persist();
  }

  private persist(): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    // Write via temp + rename, so that a crash in the middle of writing does
    // not leave a half-written file behind.
    const temporary = `${this.filePath}.tmp`;
    // ⚠️ 0o600 instead of the default (0o644 with the usual umask). The file
    // lives in the /state volume and is not configuration but a map: project
    // directories, share paths and the image refs that may be pulled. The same
    // consideration as for the `.env` (env-file.ts) — the mode is set on
    // creation and not afterwards, so there is no window in which it is more
    // widely readable.
    const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify([...this.entries.values()], null, 2), "utf8");
    } finally {
      fs.closeSync(descriptor);
    }
    // Otherwise a file carried over from an earlier version keeps its old
    // permissions, because `rename` does not touch the target's mode.
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.filePath);
  }

  get(containerId: string): RegistryEntry | null {
    return this.entries.get(containerId) ?? null;
  }

  // After a recreate the same container has a new id (stage 5a). Without this
  // move it would no longer be allowlisted immediately after its own recreate —
  // i.e. gone for management, and precisely at the moment when one wants to
  // check whether it worked.
  //
  // The main API updates its own copy separately; if that sync goes nowhere,
  // the agent stays on the NARROWER view (it then knows an id that the API does
  // not know — and the API decides first).
  replaceContainerId(oldId: string, newId: string): boolean {
    const entry = this.entries.get(oldId);
    if (!entry || oldId === newId) return false;
    this.entries.delete(oldId);
    this.entries.set(newId, { ...entry, containerId: newId });
    this.persist();
    return true;
  }

  // The stack path can recreate several services in ONE compose call.
  // All id anchors are therefore moved as one registry step and the file is
  // replaced atomically only once. On a target collision the whole batch is
  // rejected instead of overwriting an already existing entry.
  replaceContainerIds(replacements: ReadonlyMap<string, string>): boolean {
    const changes = [...replacements.entries()].filter(([oldId, newId]) => oldId !== newId);
    if (changes.length === 0) return false;

    const oldIds = new Set(changes.map(([oldId]) => oldId));
    const newIds = new Set<string>();
    for (const [oldId, newId] of changes) {
      if (!this.entries.has(oldId) || !newId || newIds.has(newId)) return false;
      if (this.entries.has(newId) && !oldIds.has(newId)) return false;
      newIds.add(newId);
    }

    const moved = changes.map(([oldId, newId]) => ({
      oldId,
      newId,
      entry: this.entries.get(oldId)!
    }));
    const previous = this.entries;
    this.entries = new Map(previous);
    try {
      for (const { oldId } of moved) this.entries.delete(oldId);
      for (const { newId, entry } of moved) {
        this.entries.set(newId, { ...entry, containerId: newId });
      }
      this.persist();
    } catch (error) {
      this.entries = previous;
      throw error;
    }
    return true;
  }

  // Only for the project-wide authorization in S11. The selection is bound
  // exactly to all three stable compose anchors; the same project name in a
  // different directory must never count as the same stack.
  entriesForCompose(projectDir: string, projectName: string, composeFileName: string): RegistryEntry[] {
    return [...this.entries.values()].filter((entry) =>
      entry.compose?.projectDir === projectDir &&
      entry.compose.projectName === projectName &&
      entry.compose.composeFileName === composeFileName
    );
  }

  // Management permissions only. An observer entry stays present for read
  // paths, but counts neither for actions nor for the container list.
  isAllowed(containerId: string): boolean {
    const entry = this.entries.get(containerId);
    return entry?.allowed === true && entry.observeOnly !== true;
  }

  isObserveOnly(containerId: string): boolean {
    return this.entries.get(containerId)?.observeOnly === true;
  }

  // Only together with a management permission. An observer entry is
  // narrower anyway and does not need this marker.
  isExternallyManaged(containerId: string): boolean {
    return this.isAllowed(containerId) && this.entries.get(containerId)?.externallyManaged === true;
  }

  checkAccess(
    containerId: string,
    mutating: boolean,
    changesDefinition = false
  ): "allowed" | "observe-only" | "externally-managed" | "not-allowlisted" {
    if (this.isObserveOnly(containerId)) return mutating ? "observe-only" : "allowed";
    if (!this.isAllowed(containerId)) return "not-allowlisted";
    return changesDefinition && this.isExternallyManaged(containerId) ? "externally-managed" : "allowed";
  }

  // Includes observer entries for read scopes and conservative stub checks.
  knownIds(): string[] {
    return [...this.entries.keys()];
  }

  allowedIds(): string[] {
    return [...this.entries.keys()].filter((id) => this.isAllowed(id));
  }

  // A pull may only pull exactly this ref (stage plan 3.6).
  expectedImageRef(containerId: string): string | null {
    const entry = this.entries.get(containerId);
    return entry && this.isAllowed(containerId) ? entry.imageRef : null;
  }

  size(): number {
    return this.entries.size;
  }
}

// TRANSITION (v0.18.1, extended in v0.24.0): read the allowlist in its OLD
// forms — the old key names and, since #80, the old wording of
// `compose.origin`.
//
// v0.17.0 renamed `freigaben` -> `shares`, `freigabePfad` -> `sharePath` and
// `compose.herkunft` -> `compose.origin` — also in this file, which an agent
// BEFORE v0.17.0 wrote and which does not migrate along with the update.
// Without this reader every entry with a compose anchor silently dropped out of
// the allowlist at startup (`isRegistryCompose` does not know `herkunft`), and
// all shares were lost. Found on 2026-09-04 on the live host: 13 entries in the
// file, 6 loaded. The first write would have overwritten the file with the 6 —
// the loss would then no longer have been a load error, but the actual
// inventory.
//
// Both names are read, the new one takes precedence; the old keys disappear
// from the object so that `persist()` writes only the new form. They appear
// here as data in quotes, not as identifiers.
//
// ⚠️ This function runs in TWO places, and the second is the reason why the
// `origin` transition (#80) belongs here and not in `load()`: it also lies on
// the path of `replaceAll`, i.e. on what the caller sends via
// `PUT /registry`. A rename on the type alone would have made the sent wording
// invalid — and `replaceAll` discards a rejected entry without an error, the
// route acknowledges with 200 anyway. The outage would have been complete and
// silent.
//
// Since #80 the name says `Forms` instead of `FileKeys`: it is no longer just
// the keys, and no longer just the file.
export function fromLegacyForms(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  const {
    "freigaben": legacyShares,
    "freigabePfad": legacySharePath,
    ...rest
  } = raw;
  const entry: Record<string, unknown> = { ...rest };
  if (entry.shares === undefined && legacyShares !== undefined) entry.shares = legacyShares;
  if (entry.sharePath === undefined && legacySharePath !== undefined) entry.sharePath = legacySharePath;
  if (entry.compose && typeof entry.compose === "object" && !Array.isArray(entry.compose)) {
    const { "herkunft": legacyOrigin, ...composeRest } = entry.compose as Record<string, unknown>;
    const compose: Record<string, unknown> = { ...composeRest };
    if (compose.origin === undefined && legacyOrigin !== undefined) compose.origin = legacyOrigin;
    // The old wording is mapped onto the new one, not placed next to it:
    // afterwards `registryComposeSchema` (contract) only checks against the two valid values,
    // and `persist()` writes only the new one. The fallback goes away as soon
    // as a version that sends "adopted" runs everywhere.
    if (compose.origin === "adoptiert") compose.origin = "adopted";
    entry.compose = compose;
  }
  return entry;
}

// Fills fields that may be missing in an older allowlist file with their safe
// default. `secured` is new in stage 5e; an entry without the field is
// "normal", not broken — otherwise half the allowlist drops away on the first
// deploy.
function normalizeEntry(entry: SyncedRegistryEntry): RegistryEntry {
  // Merge both forms into ONE list, so that the rest of the agent only knows
  // `shares`. Duplicates drop out; the order is kept.
  const combined = [...(entry.shares ?? []), ...(entry.sharePath ? [entry.sharePath] : [])];
  const allShares = [...new Set(combined.filter((pathname) => pathname.length > 0))];
  return { ...entry, secured: entry.secured === true, shares: allShares };
}

// The shape of an entry is `registryEntrySchema` (contract, #272), the same
// check `PUT /registry` runs on the request. Here it filters per entry: one
// broken entry in the file must not cost the others.
//
// Two of its rules carry the reasoning of the hand-written check it replaced:
//   * `sharePath`/`shares` must be non-empty texts if present. An empty
//     string would be the most dangerous form — it looks like a value and
//     would mean "the whole project directory".
//   * a `compose` anchor must be complete if present, with a known origin and
//     no default to 'dashboard'. Half an anchor would be worse than none: it
//     would look like a value, but would insert undefined somewhere into a
//     path — and of all cases the writing one would be the one you reach by
//     omission.
//
// Unknown keys are dropped (`z.object` strips them), so `persist()` writes
// only what was checked.
function entriesOf(values: readonly unknown[]): Map<string, RegistryEntry> {
  const entries = new Map<string, RegistryEntry>();
  for (const value of values) {
    const parsed = registryEntrySchema.safeParse(fromLegacyForms(value));
    if (parsed.success) entries.set(parsed.data.containerId, normalizeEntry(parsed.data));
  }
  return entries;
}
