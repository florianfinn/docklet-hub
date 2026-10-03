import type { Pool } from "pg";

import type { TunnelNetwork } from "../../platform/config/config.js";
import type { HostRecord } from "./host-record.js";
import {
  consumeRegistrationToken,
  createHost,
  findHost,
  findHostByTunnelAddress,
  listHostRecords,
  recordFailedRegistration,
  removeHost,
  rotateHostCredentials,
  type CreateHostInput,
  type RegistrationClaim,
  type RotateHostInput
} from "./host-store.js";

/**
 * The way to the host inventory, as an interface and not as a `Pool`.
 *
 * ⚠️ The reason is testability, not purity: the integration test of the
 * enrollment (`app/enrollment-integration.test.ts`) runs the whole flow
 * without Postgres, against a store that fulfils THIS signature. What it checks
 * there (order of the steps, content of the written wg0.conf, the answer to a
 * spent token) depends on no line of SQL. What it does NOT check is in
 * `host-store.test.ts`: whether the SQL does what it should.
 *
 * Moved here from `hosts/enrollment.ts` with #251: every route that resolves a
 * host reads it, and the enrollment is only one of them.
 */
export type HostRepository = {
  list: () => Promise<HostRecord[]>;
  find: (id: string) => Promise<HostRecord | null>;
  findByTunnelAddress: (address: string) => Promise<HostRecord | null>;
  create: (input: CreateHostInput) => Promise<HostRecord>;
  rotate: (id: string, input: RotateHostInput) => Promise<HostRecord | null>;
  remove: (id: string) => Promise<boolean>;
  consumeToken: (claim: RegistrationClaim) => Promise<HostRecord | null>;
  recordFailure: (id: string) => Promise<number | null>;
};

export function createPoolRepository(pool: Pool, network: TunnelNetwork): HostRepository {
  return {
    list: () => listHostRecords(pool),
    find: (id) => findHost(pool, id),
    findByTunnelAddress: (address) => findHostByTunnelAddress(pool, address),
    create: (input) => createHost(pool, network, input),
    rotate: (id, input) => rotateHostCredentials(pool, id, input),
    remove: (id) => removeHost(pool, id),
    consumeToken: (claim) => consumeRegistrationToken(pool, claim),
    recordFailure: (id) => recordFailedRegistration(pool, id)
  };
}
