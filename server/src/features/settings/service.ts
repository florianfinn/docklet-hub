import type { ContainerViewSettings, GlobalThemePreset, HubNetworkView, LogSettings, Settings, RuntimeSettings, SelfHealingSettings } from "contract";

import { isUnreachableFromOutside, resolveWireguardEndpoint, type Config } from "../../platform/config/config.js";

/** What `GET /settings` reads; every entry is one reader the app hands in. */
export type SettingsReaders = {
  readTheme: () => Promise<GlobalThemePreset>;
  readLogSettings: () => Promise<LogSettings>;
  readContainerView: () => Promise<ContainerViewSettings>;
  readRuntime: () => Promise<RuntimeSettings>;
  readSelfHealing: () => Promise<SelfHealingSettings>;
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
  const network = await readers.readNetwork();
  const theme = await readers.readTheme();
  const logs = await readers.readLogSettings();
  const containers = await readers.readContainerView();
  const runtime = await readers.readRuntime();
  const selfHealing = await readers.readSelfHealing();
  return { theme, logs, containers, runtime, selfHealing, network: describeNetwork(config, network.externalEndpoint) };
}
