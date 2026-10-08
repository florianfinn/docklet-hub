import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { stopIntentTargetSchema, SELF_HEALING_RECOMMENDATION, type StopIntentTarget } from "contract";
import type { DockerEngine } from "./engine.js";
import type { AgentRegistry } from "./registry.js";
import type { SelfHealingStore } from "./self-healing-store.js";
import { isUpdateSnapshotOverrideFileName } from "./compose.js";
import { UpdateBudget } from "./update-budget.js";

export type PendingExchange = { target: StopIntentTarget; containerId: string; containerName: string; journalId?: string };
const key = (target: StopIntentTarget) => JSON.stringify(target);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class InvalidUpdateJournal extends Error { constructor() { super("update-journal-invalid"); this.name = "InvalidUpdateJournal"; } }
const parkedName = /^(.*)-update-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

// Only identities are persisted; resolved definitions and environments stay out of the journal.
export class UpdateJournal {
  constructor(private readonly file: string) {}
  read(): PendingExchange[] {
    if (!fs.existsSync(this.file)) return [];
    try {
      const entries: PendingExchange[] = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!Array.isArray(entries)) throw new InvalidUpdateJournal();
      return entries.map((entry) => {
        const target = stopIntentTargetSchema.parse(entry.target);
        if (!entry.containerId || typeof entry.containerId !== "string" || !entry.containerName || typeof entry.containerName !== "string"
          || entry.journalId !== undefined && (typeof entry.journalId !== "string" || !entry.journalId)) throw new InvalidUpdateJournal();
        return { target, containerId: entry.containerId, containerName: entry.containerName,
          journalId: entry.journalId ?? hash([target, entry.containerId]) };
      });
    } catch (error) {
      if (error instanceof Error && "code" in error) throw error;
      throw new InvalidUpdateJournal();
    }
  }
  quarantine(): string {
    const destination = `${this.file}.invalid-${Date.now()}-${randomUUID()}`;
    fs.chmodSync(this.file, 0o600); fs.renameSync(this.file, destination); return path.basename(destination);
  }
  identityForParked(name: string): string | undefined { return this.history()[`identity:${name}`]; }
  seen(entry: PendingExchange, name: string, fingerprint: string): boolean {
    return this.history()[`${entry.journalId}:${name}`] === fingerprint;
  }
  remember(entry: PendingExchange, name: string, fingerprint: string): void {
    const history = this.history(); history[`identity:${name}`] = entry.journalId!; history[`${entry.journalId}:${name}`] = fingerprint;
    this.atomicWrite(`${this.file}.seen`, history);
  }
  private history(): Record<string, string> {
    if (!fs.existsSync(`${this.file}.seen`)) return {};
    const value = JSON.parse(fs.readFileSync(`${this.file}.seen`, "utf8"));
    if (!value || typeof value !== "object" || Object.values(value).some((item) => typeof item !== "string")) throw new Error("Invalid recovery history");
    return value;
  }
  begin(entry: PendingExchange): void {
    this.write([...this.read().filter((e) => key(e.target) !== key(entry.target)), { ...entry, journalId: entry.journalId ?? randomUUID() }]);
  }
  complete(target: StopIntentTarget): void { this.write(this.read().filter((e) => key(e.target) !== key(target))); }
  private write(entries: PendingExchange[]): void {
    this.atomicWrite(this.file, entries);
  }
  private atomicWrite(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
}

export async function recoverUpdateRemnants(deps: {
  engine: Pick<DockerEngine, "listWithComposeLabels">; registry: AgentRegistry; journal: UpdateJournal;
  state: SelfHealingStore; basePath: string; notify: (id: string) => void;
}): Promise<void> {
  const budget = new UpdateBudget(60_000);
  let pending: PendingExchange[];
  try { pending = deps.journal.read(); }
  catch (error) {
    if (!(error instanceof InvalidUpdateJournal)) throw error;
    const quarantined = deps.journal.quarantine();
    appendRecoveryIncident(deps.state, { kind: "container", containerName: "update-journal" }, "unresolved", `update-journal-invalid: ${quarantined}`);
    deps.notify("unresolved"); throw error;
  }
  const base = fs.realpathSync(deps.basePath);
  const containers = await budget.run((options) => deps.engine.listWithComposeLabels(options));
  const dirs = new Set(deps.registry.knownIds().map((id) => deps.registry.get(id)?.compose?.projectDir).filter((dir): dir is string => Boolean(dir)));
  for (const container of containers) {
    const dir = container.labels["com.docker.compose.project.working_dir"];
    if (dir) dirs.add(dir);
    const match = container.name.match(parkedName);
    if (!match) continue;
    const entry = deps.registry.get(container.id) ?? deps.registry.knownIds().map((id) => deps.registry.get(id)).find((e) => e?.containerName === match[1]);
    const journalEntry = pending.find((e) => e.containerName === match[1]);
    if (!journalEntry && entry?.containerName !== match[1]) continue;
    if (!journalEntry && entry?.compose && (container.labels["com.docker.compose.project"] !== entry.compose.projectName
      || container.labels["com.docker.compose.service"] !== entry.compose.serviceName)) continue;
    const target: StopIntentTarget = journalEntry?.target ?? (entry?.compose?.projectName
      ? { kind: "compose", projectName: entry.compose.projectName, serviceName: entry.compose.serviceName }
      : { kind: "container", containerName: match[1] });
    if (!pending.some((e) => key(e.target) === key(target))) pending.push({ target, containerId: container.id, containerName: match[1], journalId: deps.journal.identityForParked(container.name) ?? container.name.slice(match[1].length + 8) });
  }
  for (const dir of dirs) {
    if (!fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink()) continue;
    const relative = path.relative(base, fs.realpathSync(dir));
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (isUpdateSnapshotOverrideFileName(file)) fs.rmSync(path.join(dir, file), { force: true });
    }
  }
  for (const entry of pending) {
    const remnants = containers.filter((c) => c.name.match(parkedName)?.[1] === entry.containerName
      || c.name === entry.containerName && c.id !== entry.containerId);
    const observed = remnants.length ? remnants : [{ id: entry.containerId, name: entry.containerName, imageId: "", status: "missing" }];
    const changed = observed.filter((c) => !deps.journal.seen(entry, c.name, hash([c.id, c.name, c.imageId, c.status])));
    if (changed.length) {
      appendRecoveryIncident(deps.state, entry.target, observed[0].id, `update-interrupted: ${observed.map((c) => c.name).join(", ")}`);
      for (const container of changed) {
        deps.journal.remember(entry, container.name, hash([container.id, container.name, container.imageId, container.status]));
        deps.notify(container.id);
      }
    }
    deps.journal.complete(entry.target);
  }
}

export function appendRecoveryIncident(state: SelfHealingStore, target: StopIntentTarget, containerId: string, message: string): void {
  const at = new Date().toISOString();
  state.change((value) => {
    const existing = value.incidents.find((incident) => key(incident.target) === key(target) && !incident.closedAt);
    if (existing) {
      if (!existing.cause.engineError?.includes(message)) existing.cause.engineError = [existing.cause.engineError, message].filter(Boolean).join("; ");
      return;
    }
    value.incidents.push({ id: randomUUID(), target, containerId, openedAt: at, closedAt: null, closedReason: null,
      cause: { exitCode: 0, engineError: message }, attempts: [], recommendation: SELF_HEALING_RECOMMENDATION,
      logs: { available: false, reason: "logs-unavailable" } });
  });
}
