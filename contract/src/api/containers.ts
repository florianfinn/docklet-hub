// `zod/mini` and not `zod`: see `contract/README.md` and `api/hosts.ts`.
import * as z from "zod/mini";

import { DEFAULT_STACK_DISPLAY, INDENT_STEPS } from "../presets.js";
import { agentHealthSchema, hostViewSchema } from "./hosts.js";
import { markViewSchema } from "./marks.js";
import { lifecycleSnapshotSchema, runtimeAccessSchema } from "./lifecycle.js";
import { stepSchema } from "./steps.js";

// The response shapes of the container routes: the list of one arm, the
// overview over all arms and the stats of one container (#248).
//
// ⚠️ Instants in this file are `z.string()` and not `z.iso.datetime()`. Every
// one of them (`sampledAt`, `startedAt`) comes from the agent and is passed
// through by the hub as it arrived; the hub never writes them itself. A
// format the agent changes must not take the whole overview down with it —
// the hub mirrors a value of the other side, it does not judge it
// (AGENTS.md, "Sprache").

// One sample from the agent's ring buffer (60 of them, every 10 s, #213).
export const containerStatsSampleSchema = z.object({
  sampledAt: z.string(),
  cpuPercent: z.nullable(z.number()),
  memUsageBytes: z.nullable(z.number()),
  memLimitBytes: z.nullable(z.number())
});
export type ContainerStatsSample = z.infer<typeof containerStatsSampleSchema>;

/**
 * The latest values of one container, plus its history.
 *
 * ⚠️ `null` means "not measurable right now" and NOT zero percent. The UI
 * shows a gap or a dash for it, never a zero.
 *
 * ⚠️ `samples` is ALWAYS empty in the overview and in the list of an arm: the
 * server takes the history out there (server `features/metrics/container-load.ts`).
 * Only `GET …/stats` carries it.
 */
export const containerStatsSchema = z.object({
  cpuPercent: z.nullable(z.number()),
  memUsageBytes: z.nullable(z.number()),
  memLimitBytes: z.nullable(z.number()),
  // When the latest value was taken; `null` while the buffer is empty.
  sampledAt: z.nullable(z.string()),
  samples: z.array(containerStatsSampleSchema)
});
export type ContainerStats = z.infer<typeof containerStatsSchema>;

// Who manages a container when it is not this hub (#20, D6b).
//
// The agent reports `unraid`, `unraid-compose` or `unknown`. `manager` stays a
// string so that a manager added later shows up instead of failing the list.
export const externalManagementSchema = z.object({
  manager: z.string()
});
export type ExternalManagement = z.infer<typeof externalManagementSchema>;

/** One container as the agent reports it and the hub hands it on. */
export const containerEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  status: z.string(),
  running: z.boolean(),
  exitCode: z.optional(z.nullable(z.number())),
  runtimeAccess: z.optional(runtimeAccessSchema),
  startedAt: z.nullable(z.string()),
  health: z.nullable(z.string()),
  compose: z.nullable(z.object({ project: z.string(), service: z.string() })),
  stats: z.nullable(containerStatsSchema),
  // `null` means "managed by nobody else" AND "the agent said nothing about
  // it". The UI may conclude only that nothing is KNOWN — not that the hub
  // is in charge.
  externalManagement: z.nullable(externalManagementSchema)
});
export type ContainerEntry = z.infer<typeof containerEntrySchema>;

// One point in the load caused by containers (#214), one sampling wave.
// `null`: no value could be taken in this wave — a gap.
export const loadPointSchema = z.object({
  sampledAt: z.string(),
  cpuPercent: z.nullable(z.number()),
  memPercent: z.nullable(z.number())
});
export type LoadPoint = z.infer<typeof loadPointSchema>;

/**
 * The load of an arm CAUSED BY ITS CONTAINERS, computed in the server (server
 * `features/metrics/container-load.ts`). Not the load of the host: processes
 * outside Docker and containers outside the agent's allowlist are missing.
 * CPU is scaled to the cores and capped at 100 %.
 */
export const hostLoadSchema = z.object({
  cpuPercent: z.nullable(z.number()),
  memPercent: z.nullable(z.number()),
  memUsageBytes: z.nullable(z.number()),
  cpuCores: z.nullable(z.number()),
  memTotalBytes: z.nullable(z.number()),
  series: z.array(loadPointSchema)
});
export type HostLoad = z.infer<typeof hostLoadSchema>;

/**
 * `GET /api/hosts/:hostId/containers`: the state of the agent and its
 * containers in one answer — an empty list means something entirely
 * different depending on whether the agent answers.
 */
export const hostContainersSchema = z.object({
  host: hostViewSchema,
  agent: agentHealthSchema,
  containers: z.nullable(z.array(containerEntrySchema)),
  // `null`: the arm does not answer, or the hub does not know its hardware
  // (cores, memory) yet.
  load: z.nullable(hostLoadSchema),
  error: z.nullable(z.string())
});
export type HostContainers = z.infer<typeof hostContainersSchema>;

/** `GET /api/hosts/:hostId/containers/:containerId/stats`. */
export const containerStatsResponseSchema = z.object({
  stats: z.nullable(containerStatsSchema)
});
export type ContainerStatsResponse = z.infer<typeof containerStatsResponseSchema>;

/**
 * The state of a container or a stack, decided in the server (server
 * `domain/containers/stacks.ts`): the worst container decides the stack.
 *
 * The same three steps as `--state-ok/warn/down` in `web/src/platform/theme/tokens.css`.
 * ⚠️ STATES, not colours — which tone they become is up to the UI. And
 * strict: a state the bundle does not know has no truthful stand-in; showing
 * it as `ok` would tell the operator something the hub never said.
 */
export const containerStateSchema = z.enum(["ok", "warn", "down"]);
export type ContainerState = z.infer<typeof containerStateSchema>;

/**
 * A container as the overview hands it out: the agent's record plus its
 * state, its own marks and whether it belongs to the hub itself.
 *
 * ⚠️ `marks` is ALWAYS present, empty while the operator has assigned none.
 * A container in a stack carries ITS OWN marks, not those of its stack.
 *
 * ⚠️ `system` says whether the container belongs to the control plane itself
 * (hub, agent, their companions; rule in server
 * `domain/containers/system-containers.ts`). In a stack it carries its stack's value.
 */
export const overviewContainerSchema = z.extend(containerEntrySchema, {
  state: containerStateSchema,
  marks: z.array(markViewSchema),
  system: z.boolean()
});
export type OverviewContainer = z.infer<typeof overviewContainerSchema>;

export const stackViewSchema = z.object({
  project: z.string(),
  hubOwned: z.optional(z.boolean()),
  state: containerStateSchema,
  running: z.number(),
  // The stack's own marks, in the operator's order; never re-sorted.
  marks: z.array(markViewSchema),
  // Whether the containers sit indented below the stack — per stack, not
  // global (D0 §4). An unknown step falls back to the default: cosmetic.
  indent: stepSchema(INDENT_STEPS, DEFAULT_STACK_DISPLAY.indent),
  // Whether the operator hid this stack on the overview; it then moves to the
  // end of its host, into a collapsed section.
  hidden: z.boolean(),
  // ⚠️ The number of containers IN THIS STACK, not the length of the list
  // below: the UI filters that one, and "6 of 8 running" is a statement about
  // the stack.
  total: z.number(),
  system: z.boolean(),
  containers: z.array(overviewContainerSchema)
});
export type StackView = z.infer<typeof stackViewSchema>;

export const hostOverviewSchema = z.object({
  lifecycle: z.optional(lifecycleSnapshotSchema),
  host: hostViewSchema,
  // ⚠️ `null` means NOT ASKED (the arm still waits for its registration) and
  // is not the same as "unreachable".
  agent: z.nullable(agentHealthSchema),
  stacks: z.array(stackViewSchema),
  // Containers without a compose project, next to the stacks.
  loose: z.array(overviewContainerSchema),
  // The agent's text when it answers, but not with containers.
  error: z.nullable(z.string())
});
export type HostOverview = z.infer<typeof hostOverviewSchema>;

/** `GET /api/overview`. */
export const overviewSchema = z.object({
  hosts: z.array(hostOverviewSchema)
});
export type Overview = z.infer<typeof overviewSchema>;
