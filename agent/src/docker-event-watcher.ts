import { setTimeout } from "node:timers/promises";
import type { DockerMonitorEvent, RawInspect } from "./engine-model.js";
import type { DockerEngine } from "./engine.js";
import { StopIntentStore } from "./stop-intent.js";

type EventEngine = Pick<DockerEngine, "inspect" | "listContainerIds" | "monitorEvents">;
type Listener = (event: Omit<DockerMonitorEvent, "action"> & { action: Exclude<DockerMonitorEvent["action"], "kill"> }) => void;

export class DockerEventWatcher {
  private listeners = new Set<Listener>();
  private unavailableListeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private task: Promise<void> | null = null;
  private observing = false;

  constructor(
    private readonly engine: EventEngine,
    private readonly intents: StopIntentStore,
    private readonly generation: () => string,
    private readonly onError: (error: unknown) => void = (error) => console.error("[agent] Docker event watcher:", error)
  ) {}

  isObserving(): boolean { return this.observing; }

  subscribe(listener: Listener, onUnavailable?: () => void): () => void {
    this.listeners.add(listener);
    if (onUnavailable) this.unavailableListeners.add(onUnavailable);
    return () => {
      this.listeners.delete(listener);
      if (onUnavailable) this.unavailableListeners.delete(onUnavailable);
    };
  }

  start(): void {
    if (this.task) return;
    this.controller = new AbortController();
    this.task = this.run(this.controller.signal);
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.task;
    this.task = null;
    this.observing = false;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let queue = Promise.resolve();
      const containers = new Map<string, RawInspect>();
      try {
        const since = Date.now() / 1_000;
        this.intents.setDaemonGeneration(this.generation());
        for (const id of await this.engine.listContainerIds()) {
          if (signal.aborted) return;
          try {
            const container = await this.engine.inspect(id);
            containers.set(id, container);
            this.intents.reconcile(container);
          } catch (error) {
            if ((error as { status?: number }).status !== 404) throw error;
          }
        }
        if (signal.aborted) return;
        await this.engine.monitorEvents((event) => {
          queue = queue.then(async () => {
            if (signal.aborted || (event.atMs !== undefined && event.atMs < since * 1_000)) return;
            if (event.action === "kill" || event.action === "die" || event.action === "start") {
              let container: RawInspect;
              try {
                container = await this.engine.inspect(event.containerId);
                containers.set(event.containerId, container);
              } catch (error) {
                // Compose can remove a container before its queued die/start.
                if ((error as { status?: number }).status !== 404 || !event.containerName) throw error;
                container = containers.get(event.containerId) ?? {
                  Id: event.containerId, Name: event.containerName,
                  Config: { Labels: event.composeProject && event.composeService ? {
                    "com.docker.compose.project": event.composeProject,
                    "com.docker.compose.service": event.composeService
                  } : {} }
                };
              }
              this.intents.observe(event, container);
              if (event.action === "die") containers.delete(event.containerId);
            }
            // kill is local evidence; the existing monitor stream keeps its shape.
            if (event.action !== "kill") for (const listener of this.listeners) {
              try { listener({ ...event, action: event.action }); } catch (error) { this.onError(error); }
            }
          }).catch((error: unknown) => {
            this.observing = false;
            this.onError(error);
            // Persistence/inspection failures must never leave a healthy flag.
            this.controller?.abort();
          });
        }, signal, { since, onConnected: () => { this.observing = true; } });
        await queue;
        if (!signal.aborted) this.intents.daemonDisconnected();
      } catch (error) {
        await queue;
        if (!signal.aborted) {
          this.onError(error);
          try { this.intents.daemonDisconnected(); } catch (failure) { this.onError(failure); return; }
        }
      } finally {
        this.observing = false;
        for (const listener of this.unavailableListeners) {
          try { listener(); } catch (error) { this.onError(error); }
        }
      }
      if (!signal.aborted) await setTimeout(1_000, undefined, { signal, ref: false }).catch(() => {});
    }
  }
}
