// German texts of the feature `settings` (#269): the title of the page, the
// labels of its tabs, the scope line of the language and the panel "Netz". German
// is the source of the message type; `en.ts` closes with
// `satisfies typeof deSettingsPage`.
//
// Put together with the texts of every other surface in
// `web/src/app/i18n/messages.ts`; `platform/` may not import a feature.
//
// ⚠️ THE LABELS OF THE TABS ARE HERE, THE PANELS BEHIND THEM ARE NOT. The tab
// bar is the frame of this feature; which panel stands in which tab is put
// together by `web/src/app/settings/settings-tabs.tsx`, and each panel brings
// the texts of the feature it belongs to. `settingsAdminOnly` and the keys of
// the terminal, the container view and the system containers stay in
// `platform/i18n/messages/` until their features move (#282).
//
// ⚠️ A FLAT LITERAL, NO GROUP `settings: { … }`. `web/tests/languages.test.mjs`
// reads the top level of a flat literal; a second level would be invisible to
// it.

export const deSettingsPage = {
  settingsRuntimeTitle: "Laufzeitaktionen",
  settingsComposeDefinitionLabel: "Compose-Definition bei Start und Neustart anwenden",
  settingsComposeDefinitionHint: "An: Hub-eigene Stacks übernehmen beim Start die Compose-Definition; ein Neustart erstellt alle Container neu. Aus: Bestehende Container werden weiterverwendet. Fremdverwaltete Stacks und einzelne Container werden nie neu erstellt.",
  settingsRuntimeSave: "Speichern",
  settingsRuntimeSaved: "Im Hub gespeichert.",
  settingsRuntimeFailed: "Die Einstellungen konnten nicht geladen oder gespeichert werden.",
  settingsSelfHealingTitle: "Selbstheilung",
  settingsSelfHealingHint: "Diese Werte gelten global für alle Agents. Jeder Agent speichert sie dauerhaft und verwendet sie auch ohne Verbindung zum Hub.",
  settingsHealingEnabled: "Selbstheilung einschalten",
  settingsHealingAttempts: "Anzahl Versuche",
  settingsHealingDelay: "Abstand vor Versuch {attempt} (Sekunden)",
  settingsHealingStability: "Stabilitätsfenster (Sekunden)",
  settingsHealingMaintenanceUnlimited: "Wartung standardmäßig unbegrenzt",
  settingsHealingMaintenance: "Wartungsdauer-Vorgabe (Sekunden)",
  settingsHealingLimits: "1–10 Versuche, je 1–86.400 Sekunden Abstand. Stabilität: 1–86.400 Sekunden. Wartung: 60–604.800 Sekunden oder unbegrenzt. Alle Werte sind ganze Zahlen.",
  settingsHealingInvalid: "Bitte die Wertgrenzen und einen Abstand je Versuch einhalten.",
  settingsSelfHealingDeliveryLabel: "Übertragungsstand je Host",
  settingsSelfHealingDeliveryHint: "Nicht erreichbare Hosts erhalten den gespeicherten Stand bei der nächsten Verbindung. Übertragen bestätigt die Speicherung im Agent, keine ausgeführte Heilung.",
  settingsDeliverySynced: "übertragen",
  settingsDeliveryFailed: "Übertragung fehlgeschlagen; erneuter Versuch bei Verbindung",
  settingsDeliveryPending: "Übertragung ausstehend",

  settingsTitle: "Einstellungen",
  // Für wen eine Einstellung gilt. Bei der Sprache ist die Antwort: für dieses
  // Konto — sie liegt dort und nicht im Browser (docs/design/language-layer.md).
  settingsLanguageScope: "gilt für dieses Konto",

  // Die Tafel „Netz" (#4). Sie trägt eine einzige Angabe — und die entscheidet,
  // ob ein externer Arm überhaupt einen Tunnel aufbauen kann.
  settingsNetworkTitle: "Netz",
  settingsNetworkHint:
    "Ein Arm wählt diesen Hub an, nie umgekehrt. Erreichbar sein muss deshalb der Hub — für Arme im eigenen Netz unter seiner dortigen Adresse, für Arme außerhalb unter einer, die von dort aus auflösbar ist.",
  settingsNetworkExternalLabel: "Adresse dieses Hubs von außen",
  settingsNetworkExternalHint:
    "Hostname oder IP, wahlweise mit Port — ohne Schema. Ohne Portangabe gilt der Port des Hubs. Leer heißt: es gibt keine, und ein externer Arm lässt sich dann nur mit einer eigenen Adresse anlegen. Für Arme im eigenen Netz ändert dieses Feld nichts.",
  settingsNetworkExternalPlaceholder: "z. B. hub.example.net",
  settingsNetworkInternalTarget: "Interne Arme wählen",
  settingsNetworkExternalTarget: "Externe Arme wählen",
  settingsNetworkNoTarget: "— noch keine Adresse",
  settingsNetworkUnreachable:
    "Diese Adresse ist eine private. Aus einem fremden Netz kommt darüber nichts an: ein externer Arm bekäme ein Paket, dessen Tunnel nie zustande kommt. Der Hub weist das Anlegen deshalb ab, solange hier nichts steht.",
  settingsNetworkSave: "Speichern",
  settingsNetworkSaved: "gespeichert",
  settingsNetworkFailed: "Die Adresse konnte nicht gespeichert werden.",
  // Die Reiter. Ihre Reihenfolge steht in `web/src/app/settings/settings-tabs.tsx`
  // und nicht hier.
  settingsTabsLabel: "Bereiche der Einstellungen",
  settingsTabGeneral: "Allgemein",
  settingsTabAppearance: "Darstellung",
  settingsTabMarks: "Marken",
  settingsTabContainers: "Container",
  settingsTabSystem: "Hub & Agenten"
};
