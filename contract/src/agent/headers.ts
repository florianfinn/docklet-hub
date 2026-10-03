import * as z from "zod/mini";

// The three request headers of the agent protocol. The agent checks the secret
// before anything else, then the tier against its route table
// (`agent/src/route-policy.ts`); the actor only ends up in its audit log.

/** The shared secret of an arm. Missing or wrong: `401 unauthorized`. */
export const SECRET_HEADER = "x-docker-agent-secret";

/** Who acts: `user:<id>` or `system:<name>`. Only recorded, never trusted. */
export const ACTOR_HEADER = "x-docker-agent-actor";

/** Which network path the caller claims. Missing or unknown: `400 tier-missing`. */
export const TIER_HEADER = "x-docker-agent-tier";

/**
 * The values of `x-docker-agent-tier`.
 *
 * ⚠️ FAIL CLOSED: anything else is not "external" but no tier at all, and the
 * agent rejects it (`parseTier` in `agent/src/runtime/http.ts`).
 */
export const agentTierSchema = z.enum(["internal", "external"]);
export type AgentTier = z.infer<typeof agentTierSchema>;

/**
 * The tier THIS hub claims. A constant and not a setting: the hub stands in
 * its own network only, LAN or VPN, never public (SECURITY.md, principle 4).
 * The reasoning is at `agentRequest` in
 * `server/src/platform/agent-transport/protocol.ts`.
 */
export const HUB_TIER = "internal" satisfies AgentTier;
