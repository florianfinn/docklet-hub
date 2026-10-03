import type { Router } from "express";
import type { Pool } from "pg";

import type { Auth } from "../../platform/auth/auth.js";
import { requireAdmin } from "../../platform/auth/require-admin.js";
import { withSession } from "../../platform/auth/session.js";
import { normalizeExternalEndpoint, readHubNetwork, writeHubNetwork } from "../../domain/hosts/index.js";
import { failWith, guarded } from "../../platform/http/route-responses.js";
import { readSettings, type SettingsConfig, type SettingsReaders } from "./service.js";

// The routes of the feature `settings` (#269): `GET /settings` with every
// setting of the hub and the address of the hub from outside
// (`PUT /settings/network`, #4). They took the place of the group
// `settings-routes` (B4a-A2, #5). Its other routes went where they belong:
// `PUT /settings/logs` is the feature `logs` (#254), `PUT /settings/theme` the
// feature `appearance` (#268), and `PUT /settings/containers` is the feature
// `containers` (#282).

/** The readers of the other surfaces, handed in by `server/src/app/features.ts`. */
export type SettingsRouteOptions = {
  auth: Auth;
  pool: Pool;
  config: SettingsConfig;
  readers: Omit<SettingsReaders, "readNetwork">;
};

export function registerSettingsRoutes(router: Router, { auth, pool, config, readers }: SettingsRouteOptions): void {
  // Every setting of the hub in ONE answer: the theme, the log lines, the
  // container view and the network. One answer because the surface expects one;
  // reading by target field would mean several requests for it.
  //
  // ⚠️ Behind `withSession` and not behind `requireAdmin`: since #17 an
  // administrator writes, everybody reads. The interface needs these values
  // BEFORE it draws anything (a user without admin rights would otherwise get a
  // shell in default colours and the administrator next to them another) and
  // before the first request to an arm. None of it is a secret: the network
  // targets stand in every `wg0.conf` this hub hands out.
  router.get(
    "/settings",
    withSession(auth, async (_request, response) => {
      response.json(
        await readSettings({ ...readers, readNetwork: () => readHubNetwork(pool) }, config)
      );
    })
  );

  // Set the address of this hub from outside (#4).
  //
  // ⚠️ `requireAdmin`, and for a harder reason than the theme: this value
  // decides whether an external arm can set up a tunnel at all.
  //
  // Body `{ network: { externalEndpoint } }`, under the envelope as the theme.
  // An empty string takes the value out again; that is no special path but the
  // state "this hub has no external arm".
  router.put(
    "/settings/network",
    requireAdmin(auth),
    guarded(async (request, response) => {
      const envelope = (request.body as { network?: unknown } | null)?.network;
      if (typeof envelope !== "object" || envelope === null) {
        failWith(response, 400, "invalid-input", "Erwartet wird ein Rumpf { network: { externalEndpoint } }.");
        return;
      }
      const parsed = normalizeExternalEndpoint((envelope as { externalEndpoint?: unknown }).externalEndpoint);
      if (!parsed.ok) {
        failWith(
          response,
          400,
          "invalid-input",
          "„externalEndpoint“ ist ein Hostname oder eine IP, wahlweise mit Port — ohne Schema, ohne Leerzeichen " +
            "und ohne Schrägstrich. Der Wert steht unmaskiert in der wg0.conf jedes externen Arms."
        );
        return;
      }
      response.json({ network: await writeHubNetwork(pool, { externalEndpoint: parsed.value }) });
    })
  );
}
