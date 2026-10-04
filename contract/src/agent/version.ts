// `zod/mini` and not `zod`: see `contract/README.md`. The agent schemas follow
// the same rule as `api/`, although the web bundle reads none of them today.
import * as z from "zod/mini";

// The protocol between hub and agent (#272). Since #275 both live in this
// repository and import the schemas under `contract/src/agent/`; a protocol
// change is one commit in which both sides must be green.
//
// What no test of a single commit sees is the distance to agents of older
// releases on foreign hosts. That is what `CONTRACT_VERSION` measures, not the
// software version (docs/design/feature-architecture.md, section 6).

/**
 * The one version number of the agent's protocol. The agent reports it in
 * `GET /health` and `GET /contract`.
 *
 * History, from `agent/CHANGELOG.md`:
 *   1 — v0.28.0, the first numbered contract (#79)
 *   2 — v0.29.0, registry field `observeOnly` (#78)
 *   3 — v0.31.0, registry field `externallyManaged` (#78)
 *   4 — the games runtime routes left the route table (#276)
 *   5 — every request is checked against its schema; a request that does not
 *       fit is answered `400 invalid-request` (or an older key) with `field`
 *       (#272)
 *   6 — every value hub and agent exchange is English: error keys, stream
 *       kinds, steps, enum values, audit names and the route
 *       `/containers/:id/configuration` (#278)
 *   7 — the raw compose editor refuses externally managed stacks with
 *       `403 externally-managed` (#56)
 *   8 — host discovery reports `externalManagement` with the managers
 *       `unraid`, `unraid-compose` and `unknown` (#5)
 *   9 — new stacks get a dry run `POST /stacks/raw-preview`, mount sources
 *       and per-source confirmation of external binds (#3)
 *  10 — the storage overview reads images, volumes and networks with
 *       `GET /resources` (#10)
 */
export const CONTRACT_VERSION = 10;

/** What a field added after the first numbered contract carries. */
export type ContractSince = { since: number };

/**
 * The registry of fields that only exist from a `contractVersion` on.
 *
 * ⚠️ A field registered here is OPTIONAL by construction: an agent below the
 * version neither sends nor reads it. Whoever builds a request for such an
 * agent may leave it out, and whoever reads an older agent's answer must not
 * fail on its absence.
 */
export const contractSince = z.registry<ContractSince>();

/** Marks `schema` as present from `version` on and returns it unchanged. */
export function since<Schema extends z.core.$ZodType>(schema: Schema, version: number): Schema {
  if (!Number.isInteger(version) || version < 2 || version > CONTRACT_VERSION) {
    throw new Error(`contract version ${version} is outside 2..${CONTRACT_VERSION}`);
  }
  contractSince.add(schema, { since: version });
  return schema;
}
