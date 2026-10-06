// English texts of the feature `settings` (#269). Closes with
// `satisfies typeof deSettingsPage`: a key that is missing here or stands once too
// many fails the type check.

import type { deSettingsPage } from "./de";

export const enSettingsPage = {
  settingsRuntimeTitle: "Runtime actions",
  settingsComposeDefinitionLabel: "Apply Compose definition on start and restart",
  settingsComposeDefinitionHint: "On: hub-owned stacks apply their Compose definition on start; restart recreates all containers. Off: existing containers are reused. Externally managed stacks and individual containers are never recreated.",
  settingsRuntimeSave: "Save",
  settingsRuntimeSaved: "Saved in the hub.",
  settingsRuntimeFailed: "The settings could not be loaded or saved.",
  settingsSelfHealingTitle: "Self-healing",
  settingsSelfHealingHint: "These values apply globally to all agents. Each agent persists them and uses them even when disconnected from the hub.",
  settingsHealingEnabled: "Enable self-healing",
  settingsHealingAttempts: "Number of attempts",
  settingsHealingDelay: "Delay before attempt {attempt} (seconds)",
  settingsHealingStability: "Stability window (seconds)",
  settingsHealingMaintenanceUnlimited: "Unlimited maintenance by default",
  settingsHealingMaintenance: "Default maintenance duration (seconds)",
  settingsHealingLimits: "1–10 attempts, each with a delay of 1–86,400 seconds. Stability: 1–86,400 seconds. Maintenance: 60–604,800 seconds or unlimited. All values are whole numbers.",
  settingsHealingInvalid: "Please use values within the limits and one delay per attempt.",
  settingsSelfHealingDeliveryLabel: "Delivery status per host",
  settingsSelfHealingDeliveryHint: "Unreachable hosts receive the saved configuration on their next connection. Delivered confirms storage in the agent, not a performed healing action.",
  settingsDeliverySynced: "delivered",
  settingsDeliveryFailed: "delivery failed; retry on connection",
  settingsDeliveryPending: "delivery pending",

  settingsTitle: "Settings",
  // Für wen eine Einstellung gilt. Bei der Sprache ist die Antwort: für dieses
  // Konto — sie liegt dort und nicht im Browser (docs/design/language-layer.md).
  settingsLanguageScope: "applies to this account",

  settingsNetworkTitle: "Network",
  settingsNetworkHint:
    "An arm dials this hub, never the other way round. So it is the hub that must be reachable — for arms on the same network under its address there, for arms outside under one that resolves from where they are.",
  settingsNetworkExternalLabel: "Address of this hub from outside",
  settingsNetworkExternalHint:
    "Hostname or IP, optionally with a port — no scheme. Without a port, the port of the hub applies. Empty means there is none, and an external arm can then only be created with an address of its own. For arms on the same network this field changes nothing.",
  settingsNetworkExternalPlaceholder: "e.g. hub.example.net",
  settingsNetworkInternalTarget: "Internal arms dial",
  settingsNetworkExternalTarget: "External arms dial",
  settingsNetworkNoTarget: "— no address yet",
  settingsNetworkUnreachable:
    "This address is a private one. Nothing reaches it from another network: an external arm would get a package whose tunnel never comes up. The hub therefore refuses to create one while this field is empty.",
  settingsNetworkSave: "Save",
  settingsNetworkSaved: "saved",
  settingsNetworkFailed: "The address could not be saved.",
  settingsTabsLabel: "Settings sections",
  settingsTabGeneral: "General",
  settingsTabAppearance: "Appearance",
  settingsTabMarks: "Marks",
  settingsTabContainers: "Containers",
  settingsTabSystem: "Hub & agents"
} satisfies typeof deSettingsPage;
