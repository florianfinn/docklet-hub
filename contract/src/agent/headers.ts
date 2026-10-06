// The two request headers of the agent protocol. The agent checks the secret
// before anything else; the actor ends up in its audit log and binds the
// routes that serve exactly one caller (`agent/src/route-policy.ts`).

/** The shared secret of an arm. Missing or wrong: `401 unauthorized`. */
export const SECRET_HEADER = "x-docker-agent-secret";

/** Who acts: `user:<id>` or `system:<name>`. Only recorded, never trusted. */
export const ACTOR_HEADER = "x-docker-agent-actor";
