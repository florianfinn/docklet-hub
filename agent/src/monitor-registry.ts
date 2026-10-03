import { monitorEntrySchema, type MonitorEntry } from "contract";
import fs from "node:fs";
import path from "node:path";

// Second, SEPARATE list copy of the agent for the watch-only class
// (Docker monitoring D1, guard rail W1).
//
// Deliberately NOT the same structure as AgentRegistry: the watch-only class is
// not a control allowlist. There is no `allowed` here, no image ref and no
// controllable Compose anchor — the container name only serves to find the
// container again after a recreate. Nothing is controlled, only observed. The
// existing check chain gate() stays completely untouched and still only knows
// the allowlist. A monitor entry grants NO right to act.
//
// Fail closed like the allowlist: no/broken file means an empty list, i.e. no
// monitored container at all — not "all".

// The shape is `monitorEntrySchema` in the shared contract (#272): the id of
// the main API stays stable across Docker recreates and only serves to assign
// the reduced status response; Docker names are unique per host and are
// preserved across a normal Compose recreate/update, older sync payloads fall
// back to the id.
export type { MonitorEntry };

export class MonitorRegistry {
  private entries = new Map<string, MonitorEntry>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) throw new Error("monitor file is not an array");
      this.entries = entriesMap(parsed);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.error("[monitors] list unreadable, continuing with an empty list:", error);
      }
      this.entries = new Map();
    }
  }

  replaceAll(entries: readonly unknown[]): void {
    this.entries = entriesMap(entries);
    this.persist();
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    // 0o600 for the same reason as for the allowlist (registry.ts): the list
    // names containers the agent gives information about.
    const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(this.list(), null, 2), "utf8");
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.filePath);
  }

  list(): MonitorEntry[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }

  has(containerId: string, containerName?: string): boolean {
    const normalizedName = normalizeContainerName(containerName);
    return [...this.entries.values()].some(
      (entry) =>
        entry.containerId === containerId ||
        (!!normalizedName && normalizeContainerName(entry.containerName) === normalizedName)
    );
  }

  size(): number {
    return this.entries.size;
  }
}

function normalizeContainerName(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/^\/+/, "") ?? "";
  return normalized || null;
}

// Per entry: one broken entry in the file must not cost the others.
function entriesMap(values: readonly unknown[]): Map<string, MonitorEntry> {
  const result = new Map<string, MonitorEntry>();
  for (const value of values) {
    const parsed = monitorEntrySchema.safeParse(value);
    if (!parsed.success) continue;
    const entry = parsed.data;
    const normalized: MonitorEntry = {
      containerId: entry.containerId,
      ...(entry.monitorId ? { monitorId: entry.monitorId } : {}),
      ...(normalizeContainerName(entry.containerName)
        ? { containerName: normalizeContainerName(entry.containerName)! }
        : {})
    };
    result.set(normalized.monitorId ?? normalized.containerId, normalized);
  }
  return result;
}
