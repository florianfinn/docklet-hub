// English texts of the feature `settings` (#269). Closes with
// `satisfies typeof deSettingsPage`: a key that is missing here or stands once too
// many fails the type check.

import type { deSettingsPage } from "./de";

export const enSettingsPage = {
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
