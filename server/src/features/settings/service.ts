import type { ContainerViewSettings, GlobalThemePreset, HubNetworkView, LogSettings, Settings } from "contract";

import { isUnreachableFromOutside, resolveWireguardEndpoint, type Config } from "../../platform/config/config.js";

// The service of the feature `settings` (#269): the answer of `GET /settings`,
// put together from what the other surfaces keep. The route reads the
// parameters, sets the status and writes the answer; `service.test.ts` checks
// the rest without Express and without Postgres.
//
// ⚠️ `settings` IMPORTS NO FEATURE. The settings of `logs`, `appearance` and the
// container view are handed in as readers, by `server/src/app/features.ts`, the
// one place that knows several features (docs/design/feature-architecture.md,
// section 7, decided at #259).

/** What `GET /settings` reads; every entry is one reader the app hands in. */
export type SettingsReaders = {
  readTheme: () => Promise<GlobalThemePreset>;
  readLogSettings: () => Promise<LogSettings>;
  readContainerView: () => Promise<ContainerViewSettings>;
  readNetwork: () => Promise<{ externalEndpoint: string | null }>;
};

export type SettingsConfig = Pick<Config, "wireguardEndpoint" | "wireguardPort">;

/**
 * The address a new arm would be given, or `null` when nothing is set.
 *
 * ⚠️ `resolveWireguardEndpoint` THROWS when nothing is set anywhere. That is no
 * error here but the answer "not set up yet".
 */
function resolveTarget(config: SettingsConfig, external: string | null): string | null {
  try {
    return resolveWireguardEndpoint(config, null, external);
  } catch {
    return null;
  }
}

/**
 * The network part of the settings.
 *
 * ⚠️ RESOLVED and not raw: the dialog shows the address that really goes into
 * the `wg0.conf`, with the port. A raw value ("hub.dyndns.invalid") would be a
 * different string from the one in the archive, and the operator would compare
 * two things that never look alike. `externalEndpoint` stays raw for the field
 * in the settings: what is edited there is what is stored, not the result of a
 * calculation.
 *
 * ⚠️ `externalTargetUnreachable` is calculated HERE and not in the browser. The
 * rule what "provably not reachable from outside" means stands once in
 * `platform/config/config.ts`; a second version in JavaScript would be a third
 * place to keep the same list of private networks.
 */
export function describeNetwork(config: SettingsConfig, externalEndpoint: string | null): HubNetworkView {
  const internalTarget = resolveTarget(config, null);
  const externalTarget = resolveTarget(config, externalEndpoint);
  return {
    externalEndpoint,
    internalTarget,
    externalTarget,
    externalTargetUnreachable: externalTarget !== null && isUnreachableFromOutside(externalTarget)
  };
}

/** Every setting of the hub in one answer. None of them is a secret, so every account may read it. */
export async function readSettings(readers: SettingsReaders, config: SettingsConfig): Promise<Settings> {
  // One after the other and in this order, as the route read them before: a
  // test pool that answers by order of the queries depends on it.
  const network = await readers.readNetwork();
  const theme = await readers.readTheme();
  const logs = await readers.readLogSettings();
  const containers = await readers.readContainerView();
  return { theme, logs, containers, network: describeNetwork(config, network.externalEndpoint) };
}
