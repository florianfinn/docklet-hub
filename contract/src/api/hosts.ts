// `zod/mini` and not `zod`: this file ships in the browser bundle, and the
// classic API costs the main chunk four times as much (measured in #247, see
// `contract/README.md`). Same schemas, functional wrappers instead of methods.
import * as z from "zod/mini";

import { DEFAULT_HOST_THEME, HUE_TONES, INK_STEPS } from "../presets.js";
import { stepSchema } from "./steps.js";

// The response shapes of the host routes — the one source the server builds
// them from and the web checks them against (#247). The pattern every further
// shape follows is described in `contract/README.md`.

export const hostKindSchema = z.enum(["local", "internal", "external"]);
export type HostKind = z.infer<typeof hostKindSchema>;

// Two stored states, no third: registered means visible (#19).
export const hostStateSchema = z.enum(["pending", "registered"]);
export type HostState = z.infer<typeof hostStateSchema>;

// Derived on every request, never stored (`deriveHostStatus`, server
// `domain/hosts/host-store.ts`). `pending` outranks the rest: an arm whose agent never
// reported is not offline, it has not arrived yet — and the difference decides
// whether the operator looks for the archive or restarts the host.
//
// ⚠️ Kind, state and status stay strict on purpose. A value a cached bundle
// does not know has no truthful stand-in: showing a new status as "offline"
// would tell the operator something the hub never said. Such a list fails
// the parse and lands in the console (`parseResponse`, web), until a reload
// brings the bundle that knows the value.
export const hostStatusSchema = z.enum(["pending", "online", "offline", "outdated"]);
export type HostStatus = z.infer<typeof hostStatusSchema>;

// What the operator gave this arm in colour (D7a, #62). Same fields as
// `HostThemePreset` in `presets.ts`; the steps come from the same lists.
//
// A step the bundle does not know falls back to `DEFAULT_HOST_THEME` instead
// of failing the list: a newer hub may offer a new hue, and an arm drawn in
// neutral grey is a cosmetic loss, not a false statement. The server test
// still sees an invalid value — it compares the parse result with the body.
export const hostDisplaySchema = z.object({
  hue: stepSchema(HUE_TONES, DEFAULT_HOST_THEME.hue),
  ink: stepSchema(INK_STEPS, DEFAULT_HOST_THEME.ink)
});

// The offer of the "update agent" button (server `domain/hosts/self-update.ts`).
// `available`: the button works. `manual`: the arm does not read the target
// yet, the step is done once by hand. `current`: nothing to do.
export const agentUpdateStateSchema = z.enum(["current", "available", "manual"]);
export type AgentUpdateState = z.infer<typeof agentUpdateStateSchema>;

export const agentUpdateOfferSchema = z.object({
  targetVersion: z.string(),
  targetImageRef: z.string(),
  state: agentUpdateStateSchema
});
export type AgentUpdateOffer = z.infer<typeof agentUpdateOfferSchema>;

/**
 * One host as every host route hands it out (`toHostView`, server
 * `domain/hosts/host-store.ts`).
 *
 * ⚠️ `null` and a missing field are not the same here. Every nullable field
 * is sent on every response, as `null` when there is nothing to say; a
 * response without it is a broken response and fails the parse. The two
 * exceptions are the fields with a harmless fallback (`display` steps and
 * `agentUpdate`, see there): `z.catch` replaces anything it cannot read,
 * a missing value included.
 *
 * ⚠️ Unknown extra fields are stripped, not rejected (`z.object`, not
 * `z.strictObject`): hub and bundle may briefly run different versions — a
 * cached bundle against a newer hub — and a field the bundle does not know
 * yet must not break the host list.
 */
export const hostViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  agentUrl: z.string(),
  kind: hostKindSchema,
  // Two states in the table, four on the surface
  // (docs/design/phase-4-bootstrap-and-registration.md §3). `status` is the
  // derived value and carries the display alone; `state` stays beside it so
  // the stored distinction is not lost.
  state: hostStateSchema,
  status: hostStatusSchema,
  // `null`: unreachable, or a pending arm that is not asked at all.
  agentVersion: z.nullable(z.string()),
  // Only the local host has none: it sits in the compose network.
  tunnelAddress: z.nullable(z.string()),
  // Comes from storage, never computed from the id (#75). An arm nobody has
  // coloured yet carries `DEFAULT_HOST_THEME`, not a missing value.
  display: hostDisplaySchema,
  // `null` for the local arm — its agent follows the hub's pin — and for any
  // arm that names no version right now: without an answer there is nothing
  // to compare.
  //
  // An offer the bundle cannot read (a new `state` from a newer hub) becomes
  // `null`: no button is the one reading that promises nothing.
  agentUpdate: z.catch(z.nullable(agentUpdateOfferSchema), null),
  // When the agent last answered, as an ISO instant; `null`: never since
  // migration 013. For an arm that is offline right now, this is the answer
  // to "since when". A string on the wire, so `z.iso.datetime()` and not
  // `z.date()`.
  lastSeenAt: z.nullable(z.iso.datetime())
});
export type HostView = z.infer<typeof hostViewSchema>;

/** `GET /api/hosts`. */
export const hostListSchema = z.object({
  hosts: z.array(hostViewSchema)
});
export type HostList = z.infer<typeof hostListSchema>;

/**
 * `POST /api/hosts` (201) and `PUT /api/hosts/:hostId/display`: the one host
 * the route created or changed.
 *
 * The envelope is the reason this schema exists: `createHost` once promised a
 * bare `HostView` while the route answered with `{ host: … }`, and a new arm
 * landed in the list with `id: undefined` (D7a, #82).
 */
export const hostResponseSchema = z.object({
  host: hostViewSchema
});
export type HostResponse = z.infer<typeof hostResponseSchema>;

/**
 * What the probe of an agent found (server `domain/hosts/health.ts`).
 *
 * The unreachable branch names no version on purpose: whoever does not answer
 * has said nothing. `entries` is the size of the allowlist the agent holds;
 * `null` means "not named", which an older agent does.
 *
 * `error` is the hub's own sentence about the failure and is shown as is.
 *
 * `contractVersion` is the protocol the agent speaks (`CONTRACT_VERSION` in
 * `contract/src/agent/version.ts`); `null` when it named none. The hub reads
 * an agent below its own number as outdated, like a version below
 * `MIN_AGENT_VERSION`.
 */
export const agentHealthSchema = z.discriminatedUnion("reachable", [
  z.object({
    reachable: z.literal(true),
    version: z.nullable(z.string()),
    contractVersion: z.nullable(z.number()),
    readOnly: z.nullable(z.boolean()),
    entries: z.nullable(z.number())
  }),
  z.object({
    reachable: z.literal(false),
    error: z.string()
  })
]);
export type AgentHealth = z.infer<typeof agentHealthSchema>;
