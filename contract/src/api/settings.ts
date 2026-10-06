// `zod/mini` and not `zod`: see `contract/README.md` and `api/hosts.ts`.
import * as z from "zod/mini";

import {
  CHART_STEPS,
  CHROMA_STEPS,
  DEFAULT_GLOBAL_THEME,
  DENSITY_STEPS,
  FOCUS_STEPS,
  FONT_STEPS,
  RADIUS_STEPS,
  SCHEME_STEPS,
  TERMINAL_SCHEME_STEPS,
  TERMINAL_SCROLLBACK_STEPS,
  TERMINAL_SIZE_STEPS,
  TERMINAL_SURFACE_STEPS
} from "../presets.js";
import { selfHealingConfigSchema } from "../agent/self-healing.js";
import { stepSchema } from "./steps.js";

// The response shapes of the settings routes (#248): `GET /api/settings` and
// the four `PUT /api/settings/…` that each answer with the part they wrote.

/**
 * The global theme on the wire: the knobs of `GlobalThemePreset`
 * (`presets.ts`), each falling back to `DEFAULT_GLOBAL_THEME`.
 *
 * ⚠️ `GlobalThemePreset` stays the type — the server also reads it from input
 * (`server/src/platform/theme/knob-input.ts`). The two cannot drift unnoticed: a knob missing here
 * fails `tsc` where the web declares `GlobalThemePreset`, and a knob only
 * here is filled by `z.catch` and fails the server test, which compares the
 * parse result with the body.
 */
export const globalThemeSchema = z.object({
  scheme: stepSchema(SCHEME_STEPS, DEFAULT_GLOBAL_THEME.scheme),
  chroma: stepSchema(CHROMA_STEPS, DEFAULT_GLOBAL_THEME.chroma),
  radius: stepSchema(RADIUS_STEPS, DEFAULT_GLOBAL_THEME.radius),
  density: stepSchema(DENSITY_STEPS, DEFAULT_GLOBAL_THEME.density),
  font: stepSchema(FONT_STEPS, DEFAULT_GLOBAL_THEME.font),
  charts: stepSchema(CHART_STEPS, DEFAULT_GLOBAL_THEME.charts),
  focus: stepSchema(FOCUS_STEPS, DEFAULT_GLOBAL_THEME.focus),
  terminalScheme: stepSchema(TERMINAL_SCHEME_STEPS, DEFAULT_GLOBAL_THEME.terminalScheme),
  terminalSurface: stepSchema(TERMINAL_SURFACE_STEPS, DEFAULT_GLOBAL_THEME.terminalSurface),
  terminalSize: stepSchema(TERMINAL_SIZE_STEPS, DEFAULT_GLOBAL_THEME.terminalSize),
  terminalScrollback: stepSchema(TERMINAL_SCROLLBACK_STEPS, DEFAULT_GLOBAL_THEME.terminalScrollback)
});

/**
 * The four line counts the log view may open with (#5, step H) — the one
 * list the server checks input against and the web builds its picker from.
 *
 * ⚠️ Not above 2000: the agent caps its excerpt there (`MAX_TAIL`,
 * `contract/src/agent/limits.ts`), and
 * `server/src/platform/agent-transport/protocol.test.ts` holds the largest
 * value against it. The coupling is an assertion, not a derivation: an
 * operator's choice of steps and the other side's limit are different
 * things that happen to share a number.
 */
export const LOG_TAIL_LINE_OPTIONS = [200, 500, 1000, 2000] as const;
export type LogTailLines = (typeof LOG_TAIL_LINE_OPTIONS)[number];

/**
 * How many lines of the past the log view shows on opening. One setting of
 * the hub, not one per arm: a preference of the surface.
 *
 * `z.number()` and not the four literals: the value comes from storage, and
 * the server only ever writes one of them (`normalizeLogTailLines`). A value
 * outside the list is not a reason to fail the whole settings response.
 */
export const logSettingsSchema = z.object({
  tailLines: z.number()
});
export type LogSettings = z.infer<typeof logSettingsSchema>;

/**
 * Whether the overview and the container surface show the containers of the
 * control plane itself (hub, agents; server `domain/containers/system-containers.ts`).
 */
export const containerViewSettingsSchema = z.object({
  showSystem: z.boolean()
});
export type ContainerViewSettings = z.infer<typeof containerViewSettingsSchema>;

/**
 * What the hub says about its own reachability (#4).
 *
 * ⚠️ The targets are RESOLVED, `externalEndpoint` is not: the dialog shows
 * with the targets what really goes into a `wg0.conf`, with port; the raw
 * stored value belongs in the settings field. `null` targets mean "not set up
 * yet". `externalTargetUnreachable` is computed by the server — the list of
 * private networks lives once, in server `config.ts`.
 */
export const hubNetworkViewSchema = z.object({
  externalEndpoint: z.nullable(z.string()),
  internalTarget: z.nullable(z.string()),
  externalTarget: z.nullable(z.string()),
  externalTargetUnreachable: z.boolean()
});
export type HubNetworkView = z.infer<typeof hubNetworkViewSchema>;

export const runtimeSettingsSchema = z.strictObject({ applyComposeDefinition: z.boolean() });
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
export const runtimeSettingsResponseSchema = z.object({ runtime: runtimeSettingsSchema });
export const selfHealingDeliverySchema = z.object({
  hostId: z.string(),
  hostName: z.string(),
  status: z.enum(["pending", "synced", "failed"]),
  appliedRevision: z.nullable(z.number()),
  updatedAt: z.nullable(z.string())
});
export type SelfHealingDelivery = z.infer<typeof selfHealingDeliverySchema>;
export const selfHealingSettingsSchema = z.object({
  config: selfHealingConfigSchema,
  revision: z.number(),
  hosts: z.array(selfHealingDeliverySchema)
});
export type SelfHealingSettings = z.infer<typeof selfHealingSettingsSchema>;
export const selfHealingSettingsResponseSchema = z.object({ selfHealing: selfHealingSettingsSchema });
export const selfHealingSettingsRequestSchema = z.strictObject({ config: selfHealingConfigSchema });

/** `GET /api/settings`: every setting of the hub, each under its own key. */
export const settingsSchema = z.object({
  theme: globalThemeSchema,
  logs: logSettingsSchema,
  containers: containerViewSettingsSchema,
  network: hubNetworkViewSchema,
  runtime: runtimeSettingsSchema,
  selfHealing: selfHealingSettingsSchema
});
export type Settings = z.infer<typeof settingsSchema>;

/** `PUT /api/settings/theme`. */
export const themeResponseSchema = z.object({ theme: globalThemeSchema });

/** `PUT /api/settings/logs`. */
export const logSettingsResponseSchema = z.object({ logs: logSettingsSchema });

/** `PUT /api/settings/containers`. */
export const containerViewSettingsResponseSchema = z.object({ containers: containerViewSettingsSchema });

/**
 * `PUT /api/settings/network`: only the stored value comes back, not the
 * resolved targets — the dialog reads those from `GET /api/settings`.
 */
export const hubNetworkResponseSchema = z.object({
  network: z.object({ externalEndpoint: z.nullable(z.string()) })
});
