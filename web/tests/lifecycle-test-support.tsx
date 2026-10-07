import { renderInDom, waitFor, settle } from "./dom-harness.js";
import type { HostOverview, OverviewContainer, StackView, HubRuntimeContext } from "contract";
import { CONTRACT_VERSION, DEFAULT_HOST_THEME, DEFAULT_STACK_DISPLAY } from "contract";
import * as React from "react";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { LifecycleProvider } from "../src/features/containers/LifecycleProvider.js";
import { LifecycleControls } from "../src/features/containers/LifecycleControls.js";
import { queryKeys } from "../src/platform/query/query-keys.js";
import type { LifecycleTarget } from "../src/features/containers/lifecycle-state.js";
export function container(status = "running", patch: Partial<OverviewContainer> = {}): OverviewContainer {
  return { id: "demo-web-id", name: "demo-web", image: "nginx:1.27", status, exitCode: null, running: status === "running",
    startedAt: "2026-10-07T01:00:00Z", health: null, compose: { project: "demo", service: "web" }, stats: null,
    runtimeAccess: { blocker: null }, externalManagement: null, state: "ok", marks: [], system: false, ...patch };
}
export function stack(containers = [container()], patch: Partial<StackView> = {}): StackView {
  return { project: "demo", state: "ok", running: containers.filter((entry) => entry.running).length, total: containers.length,
    hubOwned: true, marks: [], indent: DEFAULT_STACK_DISPLAY.indent, hidden: false, system: false, containers, ...patch };
}
export function host(containers = [container()]): HostOverview {
  return { host: { id: "demo-host", name: "Demo", agentUrl: "https://agent.example.org", kind: "internal", state: "registered", status: "online",
    agentVersion: "0.32.0", tunnelAddress: null, display: DEFAULT_HOST_THEME, agentUpdate: null, lastSeenAt: null },
    agent: { reachable: true, version: "0.32.0", contractVersion: CONTRACT_VERSION, readOnly: false, entries: containers.length },
    error: null, loose: [], stacks: [stack(containers)],
    lifecycle: { applyDefinition: true, maintenanceDurationSeconds: 7200,
      stopIntents: { observing: true, intents: [], recentExits: [] }, selfHealing: { observing: true, budgets: [], maintenance: [], incidents: [] } }
  };
}
export function context(current: HostOverview): HubRuntimeContext {
  const stack = current.stacks[0];
  const services = stack.containers.map((entry) => ({ serviceName: entry.compose!.service, containerId: entry.id,
    status: entry.status, startedAt: entry.startedAt, exitCode: entry.exitCode ?? null, allowed: true }));
  return { hubOwned: stack.hubOwned ?? false, applyDefinition: current.lifecycle!.applyDefinition, readOnly: false,
    expectedStack: { projectName: stack.project, projectDir: "/srv/example/demo", composeFileName: "compose.yml", services }, services };
}
export type Call = { path: string; method: string; body: unknown; signal?: AbortSignal | null };
export async function fixture({ kind = "container", current = host(), role = "admin", detail = false, copies = 1, strict = false,
  action }: { kind?: "container" | "stack"; current?: HostOverview; role?: "admin" | "user"; detail?: boolean; copies?: number; strict?: boolean;
  action?: (call: Call) => Promise<Response> | Response } = {}) {
  const fetchBefore = globalThis.fetch;
  const languagesBefore = Object.getOwnPropertyDescriptor(globalThis.navigator, "languages");
  Object.defineProperty(globalThis.navigator, "languages", { configurable: true, value: ["de"] });
  const calls: Call[] = [];
  const state = { host: current, context: context(current) };
  globalThis.fetch = async (input, init = {}) => {
    const call: Call = { path: String(input), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null, signal: init.signal };
    calls.push(call);
    if (call.path.endsWith("/overview")) return Response.json({ hosts: [state.host] });
    if (call.path.endsWith("/context")) return Response.json(state.context);
    if (call.path.includes("self-healing")) return action ? action(call) : Response.json({ ok: true });
    if (action) return action(call);
    const actionName = call.path.split("/").at(-1);
    const runtime = { containerId: current.stacks[0].containers[0].id, status: "running", startedAt: "2026-10-07T02:00:00Z", exitCode: null, health: null };
    return Response.json(kind === "container" ? { ok: true, action: actionName, outcome: "ok", state: runtime } :
      { ok: true, action: actionName, outcome: "ok", applyDefinition: state.context.applyDefinition, services: [{ ...runtime, serviceName: "web", outcome: "ok" }], containerIds: { web: runtime.containerId } });
  };
  const target: LifecycleTarget = kind === "container" ? { kind, hostId: current.host.id, container: current.stacks[0].containers[0] }
    : { kind, hostId: current.host.id, stack: current.stacks[0] };
  const tree = <AppLanguageProvider><LifecycleProvider role={role}>{Array.from({ length: copies }, (_, index) =>
    <LifecycleControls key={index} target={target} detail={detail} />)}</LifecycleProvider></AppLanguageProvider>;
  const mounted = await renderInDom(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree);
  await React.act(async () => { mounted.queryClient.setQueryData(queryKeys.containers.overview(), [current]); });
  await settle();
  return { ...mounted, calls, state, target,
    update: async (next: HostOverview) => {
      state.host = next; state.context = context(next);
      await React.act(async () => { mounted.queryClient.setQueryData(queryKeys.containers.overview(), [next]); }); await settle();
    }, close: async () => { await mounted.unmount(); globalThis.fetch = fetchBefore;
      if (languagesBefore) Object.defineProperty(globalThis.navigator, "languages", languagesBefore);
      else Reflect.deleteProperty(globalThis.navigator, "languages"); }
  };
}
export function button(action: string, copy = 0): HTMLButtonElement {
  const found = document.querySelectorAll<HTMLButtonElement>(`[data-action="${action}"]`)[copy];
  assertFound(found); return found;
}
function assertFound<T>(value: T | null | undefined): asserts value is T { if (!value) throw new Error("missing control"); }
export function textButton(text: string, within: ParentNode = document): HTMLButtonElement {
  const found = [...within.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === text);
  assertFound(found); return found;
}
export async function click(button: HTMLElement) { await React.act(async () => { button.click(); }); await settle(); }
export async function press(target: Element, key: string) {
  await React.act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true })); }); await settle();
}
export { React, waitFor, settle };
