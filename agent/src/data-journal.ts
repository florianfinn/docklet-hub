import fs from "node:fs";
import path from "node:path";
import { stopIntentTargetSchema, type StopIntentTarget } from "contract";
import type { RawInspect } from "./engine.js";

export type DataOperation = { target: StopIntentTarget; kind: "backup" | "restore"; extractStarted: boolean;
  containerId: string; containerName: string; running: boolean; restarting: boolean; paused: boolean };
const key = (target: StopIntentTarget) => JSON.stringify(target);
export class DataJournal {
  constructor(private readonly file: string) {}
  read(): DataOperation[] {
    if (!fs.existsSync(this.file)) return [];
    const value: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (!Array.isArray(value)) throw new Error("data-journal-invalid");
    return value.map((entry) => {
      const target = stopIntentTargetSchema.parse(entry.target);
      if (!["backup", "restore"].includes(entry.kind) || !entry.containerId || typeof entry.containerId !== "string"
        || !entry.containerName || typeof entry.containerName !== "string"
        || [entry.running, entry.restarting, entry.paused, entry.extractStarted].some((field) => typeof field !== "boolean")) throw new Error("data-journal-invalid");
      return { target, kind: entry.kind, containerId: entry.containerId, containerName: entry.containerName,
        running: entry.running, restarting: entry.restarting, paused: entry.paused, extractStarted: entry.extractStarted };
    });
  }
  begin(target: StopIntentTarget, raw: RawInspect, kind: DataOperation["kind"]) {
    const entries = this.read();
    if (entries.some((entry) => key(entry.target) === key(target))) throw new Error("data-operation-pending");
    this.write([...entries, { target, kind,
      containerId: raw.Id, containerName: raw.Name, running: !!raw.State?.Running, restarting: !!raw.State?.Restarting,
      paused: !!raw.State?.Paused, extractStarted: false }]);
  }
  extracting(target: StopIntentTarget) {
    this.write(this.read().map((entry) => key(entry.target) === key(target) ? { ...entry, extractStarted: true } : entry));
  }
  complete(target: StopIntentTarget) { this.write(this.read().filter((entry) => key(entry.target) !== key(target))); }
  private write(entries: DataOperation[]) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(entries), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}
