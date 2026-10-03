// German texts of the feature `shell` (#261): the tab with the terminal of a
// container, its states and every error the hub can answer with. German is the
// source of the message type; `en.ts` closes with `satisfies typeof deShell`.
//
// Put together with the texts of every other surface in
// `web/src/app/i18n/messages.ts`; `platform/` may not import a feature.
//
// ⚠️ A FLAT LITERAL, NO GROUP `shell: { … }`. `web/tests/languages.test.mjs`
// reads the top level of a flat literal; a second level would be invisible to
// it, and its assertions would fall away without a test going red.

export const deShell = {
  // Der Reiter selbst.
  containerTabShell: "Shell",

  // Das Nachladen von @xterm.
  shellLoading: "Das Terminal wird geladen …",
  shellLoadFailed:
    "Das Terminal konnte nicht geladen werden. Der Reiter holt es beim Öffnen nach; neu laden hilft meistens.",
  shellTerminalLabel: "Terminal des Containers",

  // ── Der Kopf: fünf Zustände, jeder mit eigenem Text ──────────────────────
  shellConnecting: "Verbindet …",
  // ⚠️ Der Containername kommt aus der `start`-Zeile des Hubs und nicht aus
  // der Adresse: die Adresse trägt den Namen, den der Mensch angeklickt hat,
  // die Zeile den, unter dem die Sitzung wirklich läuft.
  shellConnected: "Verbunden mit {container}",
  // ⚠️ ZWEI SÄTZE FÜR ZWEI AUSKÜNFTE, und sie sind keine Varianten
  // voneinander. Eine Zahl heißt: der Prozess ist von selbst zu Ende
  // gegangen. `null` heißt: der Agent hat abgeriegelt — und WELCHES seiner
  // beiden Zeitlimits (30 Minuten Gesamtdauer, 15 Minuten Leerlauf), kann der
  // Hub nicht wissen; das steht nur im Audit-Log des Arms. Wer beide gleich
  // beschriftet, behauptet eine Auskunft, die niemand hat.
  shellEnded: "Beendet mit Code {code}. Eine neue Shell geht über die Schaltfläche auf.",
  shellBroken:
    "Die Verbindung ist beendet worden, ohne dass der Grund hier bekannt ist. Warum, steht im Audit-Log des Arms.",
  shellReconnect: "Neu verbinden",

  // Die drei Gründe, die der Hub IM Strom schickt, dazu der Rückfall.
  shellFailureRevoked:
    "Das Recht auf diese Shell ist entzogen worden, während sie lief. Die Verbindung ist deshalb beendet.",
  // ⚠️ Kein Fehler: die Shell ist auf Auftrag zu, aus einem anderen Reiter
  // derselben Anmeldung oder weil ihre Höchstdauer um ist.
  shellFailureClosed: "Diese Shell ist geschlossen worden. Eine neue geht über die Schaltfläche auf.",
  shellFailureAgentBroken: "Die Verbindung zum Arm ist ohne Abschluss abgerissen.",
  // ⚠️ Der Rückfall NENNT den rohen Grund. „Ein Fehler ist aufgetreten" nähme
  // dem Menschen die einzige Auskunft, die auf der Leitung stand.
  shellFailureUnknown: "Die Verbindung ist beendet worden ({reason}).",

  // ── Jede Kennung des Hubs bekommt einen Text ─────────────────────────────
  shellErrorUnauthenticated: "Diese Sitzung ist nicht mehr angemeldet. Nach einer neuen Anmeldung geht die Shell auf.",
  shellErrorAdminRequired: "Eine Shell öffnet nur ein Administrator. Diese Anmeldung hat die Rolle Benutzer.",
  shellErrorHostUnknown: "Diesen Arm führt der Hub nicht mehr.",
  shellErrorHostUnreachable: "Dieser Arm antwortet nicht. Ohne ihn gibt es keine Shell.",
  shellErrorAgentOutdated:
    "Der Agent dieses Arms ist zu alt für eine Shell. Lesen geht weiter; hierfür braucht er eine neuere Fassung.",
  shellErrorContainerUnknown: "Diesen Container führt dieser Arm nicht.",
  shellErrorContainerNotRunning: "Dieser Container läuft nicht. Eine Shell braucht einen laufenden Prozess.",
  shellErrorNoShell:
    "In diesem Image gibt es weder bash noch sh. Ohne Shell im Container lässt sich kein Terminal öffnen.",
  // ⚠️ Der Deckel des ARMS — gilt für alle Menschen zusammen. Man wartet.
  shellErrorTooManySessions:
    "Dieser Arm führt bereits so viele Shells, wie er zulässt. Sobald jemand eine schließt, wird ein Platz frei.",
  // ⚠️ Der EIGENE Deckel — man schließt eine eigene. Ein gemeinsamer Satz mit
  // dem darüber gäbe der Hälfte der Leser den falschen Rat.
  shellErrorOwnSessionLimit:
    "Auf diesem Arm sind schon so viele eigene Shells offen, wie erlaubt sind. Eine davon schließen, dann geht die nächste auf.",
  shellErrorAgentReadOnly: "Dieser Arm steht auf „nur lesen“. Eine Shell öffnet er nicht, solange der Kill-Switch liegt.",
  shellErrorAgentForbidden: "Diesen Container führt der Arm nicht in seiner Allowlist.",
  shellErrorContainerObserveOnly:
    "Dieser Container ist nur zum Beobachten freigegeben. Der Arm öffnet dort keine Shell und nimmt keine Eingabe an.",
  shellErrorAgentUnreachable: "Der Arm konnte die Shell nicht anlegen.",
  shellErrorSessionUnknown:
    "Diese Shell-Sitzung gibt es nicht mehr. Sie ist geschlossen, abgelaufen oder gehört zu einem anderen Container.",
  shellErrorInvalidInput: "Der Hub hat diese Eingabe nicht angenommen. Das ist ein Fehler dieser Oberfläche.",
  shellErrorInputTooLarge: "Diese Eingabe ist dem Arm zu groß. Er nimmt je Anfrage rund 48 KiB rohe Bytes an.",
  // ⚠️ Der Rückfall auf eine Kennung, die diese Fläche nicht führt. Er zeigt
  // sie ROH — ein leerer Kopf wäre die schlechtere Auskunft, und der
  // Log-Ansicht ist genau das schon einmal aufgefallen.
  shellErrorUnknown: "Die Shell ist abgelehnt worden ({reason}).",
  // ⚠️ Gar keine Kennung (#176) — ein Netzfehler etwa, oder eine Antwort ohne
  // lesbaren Rumpf. Eine eigene Zeile statt einer leeren Klammer.
  shellErrorWithoutReason: "Die Shell ist abgelehnt worden, ohne dass ein lesbarer Grund zurückkam."
};
