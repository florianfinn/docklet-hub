import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stopIntentTargetSchema, SELF_HEALING_RECOMMENDATION, type StopIntentTarget } from "contract";
import type { DockerEngine } from "./engine.js";
import type { AgentRegistry } from "./registry.js";
import type { SelfHealingStore } from "./self-healing-store.js";
import { isUpdateSnapshotOverrideFileName } from "./compose.js";
import { UpdateBudget } from "./update-budget.js";

export type PendingExchange = { target: StopIntentTarget; containerId: string; containerName: string };
const key = (target: StopIntentTarget) => JSON.stringify(target);
const parkedName = /^(.*)-update-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

// Only identities are persisted; resolved definitions and environments stay out of the journal.
export class UpdateJournal {
  constructor(private readonly file: string) {}
  read(): PendingExchange[] {
    if (!fs.existsSync(this.file)) return [];
    const entries: PendingExchange[] = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (!Array.isArray(entries)) throw new Error("Invalid update journal");
    for (const entry of entries) {
      stopIntentTargetSchema.parse(entry.target);
      if (typeof entry.containerId !== "string" || typeof entry.containerName !== "string") throw new Error("Invalid update identity");
    }
    return entries;
  }
  begin(entry: PendingExchange): void { this.write([...this.read().filter((e) => key(e.target) !== key(entry.target)), entry]); }
  complete(target: StopIntentTarget): void { this.write(this.read().filter((e) => key(e.target) !== key(target))); }
  private write(entries: PendingExchange[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}

export async function recoverUpdateRemnants(deps: {
  engine: Pick<DockerEngine, "listWithComposeLabels">; registry: AgentRegistry; journal: UpdateJournal;
  state: SelfHealingStore; basePath: string; notify: (id: string) => void;
}): Promise<void> {
  const budget = new UpdateBudget(60_000);
  const containers = await budget.run((options) => deps.engine.listWithComposeLabels(options));
  const pending = deps.journal.read();
  const dirs = new Set(deps.registry.knownIds().map((id) => deps.registry.get(id)?.compose?.projectDir).filter((dir): dir is string => Boolean(dir)));
  for (const container of containers) {
    const dir = container.labels["com.docker.compose.project.working_dir"];
    if (dir) dirs.add(dir);
    const match = container.name.match(parkedName);
    if (!match) continue;
    const entry = deps.registry.get(container.id) ?? deps.registry.knownIds().map((id) => deps.registry.get(id)).find((e) => e?.containerName === match[1]);
    const target: StopIntentTarget = entry?.compose?.projectName
      ? { kind: "compose", projectName: entry.compose.projectName, serviceName: entry.compose.serviceName }
      : { kind: "container", containerName: match[1] };
    if (!pending.some((e) => key(e.target) === key(target))) pending.push({ target, containerId: container.id, containerName: match[1] });
  }
  for (const dir of dirs) {
    if (!fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink()) continue;
    const relative = path.relative(fs.realpathSync(deps.basePath), fs.realpathSync(dir));
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (isUpdateSnapshotOverrideFileName(file)) fs.rmSync(path.join(dir, file), { force: true });
    }
  }
  for (const entry of pending) {
    const remnants = containers.filter((c) => c.name.match(parkedName)?.[1] === entry.containerName
      || c.name === entry.containerName && c.id !== entry.containerId);
    const at = new Date().toISOString();
    const names = remnants.length ? remnants.map((c) => c.name).join(", ") : entry.containerName;
    const containerId = remnants[0]?.id ?? entry.containerId;
    deps.state.change((state) => {
      const cause = { exitCode: 0, engineError: `update-interrupted: ${names}` };
      const existing = state.incidents.find((incident) => key(incident.target) === key(entry.target) && !incident.closedAt);
      if (existing) { existing.cause = cause; return; }
      state.incidents.push({ id: randomUUID(), target: entry.target, containerId, openedAt: at,
        closedAt: null, closedReason: null, cause, attempts: [], recommendation: SELF_HEALING_RECOMMENDATION,
        logs: { available: false, reason: "logs-unavailable" } });
    });
    if (remnants.length) for (const container of remnants) deps.notify(container.id);
    else deps.notify(containerId);
    deps.journal.complete(entry.target);
  }
}
