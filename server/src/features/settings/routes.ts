import type { Router } from "express";
import type { Pool } from "pg";

import type { Auth } from "../../platform/auth/auth.js";
import { requireAdmin } from "../../platform/auth/require-admin.js";
import { withSession } from "../../platform/auth/session.js";
import { normalizeExternalEndpoint, readHubNetwork, writeHubNetwork } from "../../domain/hosts/index.js";
import { failWith, guarded } from "../../platform/http/route-responses.js";
import { changeRuntimeSettings, changeSelfHealingSettings } from "./runtime-service.js";
import type { SelfHealingSync } from "./self-healing-sync.js";
import { readSettings, type SettingsConfig, type SettingsReaders } from "./service.js";

/** The readers of the other surfaces, handed in by `server/src/app/features.ts`. */
export type SettingsRouteOptions = {
  auth: Auth;
  pool: Pool;
  config: SettingsConfig;
  readers: Omit<SettingsReaders, "readNetwork">;
  selfHealingSync: SelfHealingSync;
};

export function registerSettingsRoutes(router: Router, { auth, pool, config, readers, selfHealingSync }: SettingsRouteOptions): void {
  router.get(
    "/settings",
    withSession(auth, async (_request, response) => {
      response.json(
        await readSettings({ ...readers, readNetwork: () => readHubNetwork(pool) }, config)
      );
    })
  );

  router.put("/settings/runtime", requireAdmin(auth), guarded(async (request, response) => {
    const runtime = await changeRuntimeSettings(pool, request.body);
    if (!runtime) { failWith(response, 400, "invalid-input", "Ungültige Laufzeiteinstellungen."); return; }
    response.json({ runtime });
  }));
  router.put("/settings/self-healing", requireAdmin(auth), guarded(async (request, response) => {
    const selfHealing = await changeSelfHealingSettings(pool, request.body, selfHealingSync);
    if (!selfHealing) { failWith(response, 400, "invalid-input", "Ungültige Selbstheilungseinstellungen."); return; }
    response.json({ selfHealing });
  }));

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
