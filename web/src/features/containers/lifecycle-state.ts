import type { HostOverview, OverviewContainer, StackView, RuntimeAction, StopIntentTarget, SelfHealingMaintenanceTarget } from "contract";
import type { Role } from "../../platform/session/session-user";

export type LifecycleTarget = { kind: "container"; hostId: string; container: OverviewContainer }
  | { kind: "stack"; hostId: string; stack: StackView };
export type LifecycleBlocker = "offline" | "role" | "read-only" | "not-allowlisted" | "observe-only" | "self-management-locked"
  | "capability" | "busy" | "unknown-state" | "already-running" | "already-stopped" | "completed";
export const ACTIONS: readonly RuntimeAction[] = ["start", "stop", "restart"];
export const RUNNING_STATES = new Set(["running", "paused", "restarting"]);
export const STOPPED_STATES = new Set(["created", "exited"]);
export function targetContainers(target: LifecycleTarget): OverviewContainer[] {
  return target.kind === "stack" ? target.stack.containers : [target.container];
}
export function targetName(target: LifecycleTarget): string {
  return target.kind === "stack" ? target.stack.project : target.container.name;
}
export function targetKey(target: LifecycleTarget): string {
  return JSON.stringify([target.hostId, target.kind, targetName(target)]);
}
export function targetProject(target: LifecycleTarget): string | null {
  return target.kind === "stack" ? target.stack.project : target.container.compose?.project ?? null;
}
export function intentTarget(container: OverviewContainer): StopIntentTarget {
  return container.compose ? { kind: "compose", projectName: container.compose.project, serviceName: container.compose.service }
    : { kind: "container", containerName: container.name };
}
export function maintenanceTarget(target: LifecycleTarget): SelfHealingMaintenanceTarget {
  return target.kind === "stack" ? { kind: "stack", projectName: target.stack.project } : intentTarget(target.container);
}
export function sameTarget(a: SelfHealingMaintenanceTarget, b: SelfHealingMaintenanceTarget): boolean {
  if (a.kind === "container") return b.kind === "container" && a.containerName === b.containerName;
  if (a.kind === "stack") return b.kind === "stack" && a.projectName === b.projectName;
  return b.kind === "compose" && a.projectName === b.projectName && a.serviceName === b.serviceName;
}
export function controlsBlocker(host: HostOverview | undefined, role: Role, busy: boolean): LifecycleBlocker | null {
  if (!host || host.host.status === "offline" || host.host.status === "pending" || !host.agent?.reachable) return "offline";
  if (role !== "admin") return "role";
  if (host.host.status === "outdated" || (host.agent.contractVersion ?? 0) < 12) return "capability";
  if (busy) return "busy";
  return null;
}
export function runtimeBlocker(target: LifecycleTarget, host: HostOverview | undefined, role: Role, busy: boolean): LifecycleBlocker | null {
  const basic = controlsBlocker(host, role, busy);
  if (basic) return basic;
  if (host?.agent?.reachable && host.agent.readOnly !== false) return "read-only";
  if (target.kind === "stack" ? target.stack.system : target.container.system) return "self-management-locked";
  for (const container of targetContainers(target)) {
    if (!container.runtimeAccess) return "capability";
    if (container.runtimeAccess.blocker) return container.runtimeAccess.blocker;
    if (!RUNNING_STATES.has(container.status) && !STOPPED_STATES.has(container.status)) return "unknown-state";
  }
  return targetContainers(target).length === 0 ? "unknown-state" : null;
}
export function actionBlocker(target: LifecycleTarget, action: RuntimeAction): LifecycleBlocker | null {
  const containers = targetContainers(target);
  const running = containers.some((container) => RUNNING_STATES.has(container.status));
  if (action !== "start") return running ? null : "already-stopped";
  if (target.kind === "container") return running ? "already-running" : null;
  const stopped = containers.filter((container) => STOPPED_STATES.has(container.status));
  if (stopped.some((container) => container.status === "created" || container.exitCode !== 0)) return null;
  return running ? "already-running" : "completed";
}
export function effectiveDefinition(target: LifecycleTarget, host: HostOverview | undefined): boolean {
  return target.kind === "stack" && target.stack.hubOwned === true && host?.lifecycle?.applyDefinition === true;
}
export function requiresConfirmation(target: LifecycleTarget, action: RuntimeAction): boolean {
  return target.kind === "stack" && action !== "start";
}
export function targetsOverlap(a: LifecycleTarget, b: LifecycleTarget): boolean {
  if (a.hostId !== b.hostId) return false;
  if (targetKey(a) === targetKey(b)) return true;
  const project = targetProject(a);
  return project !== null && project === targetProject(b);
}
