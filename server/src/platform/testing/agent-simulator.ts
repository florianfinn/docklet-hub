// Ein nachgebauter Anmelde-Client des Agenten — die Gegenseite dieser Fläche.
//
// Vorlage: dashboard-docker-agent, Tag `v0.19.1`, `src/bootstrap-registration.ts`
// (`registerBootstrapOnce`, `nextRegistrationStep`) — die Datei ist dort seit
// v0.18.1 byteweise unverändert, verglichen am 2026-09-06. Nachgebaut und NICHT
// importiert: der Agent ist ein eigenes, unabhängig deploytes Repo, und eine
// Abhängigkeit darauf gäbe es im Hub nicht zu installieren.
//
// ⚠️ Wozu er da ist: der Integrationstest soll nicht prüfen, ob die App auf
// eine selbst gebaute Anfrage antwortet, sondern ob sie auf die Anfrage
// antwortet, die WIRKLICH kommt — mit derselben Methode, derselben Kopfzeile,
// denselben Rumpffeldern und derselben Auswertung. Ein Hub, der sein eigenes
// Protokoll gegen sich selbst prüft, ist grün und trotzdem unerreichbar.
//
// Nachgebaut ist genau das, was der Hub trifft:
//   * ein POST auf die URL aus dem Archiv, `content-type: application/json`,
//     Token in `x-docker-host-registration`, Frist je Aufruf;
//   * Rumpf mit `agentVersion`, `listenHost`, `listenPort`, `readOnly`;
//   * ausgewertet wird ausschließlich `response.ok` — der Rumpf der Antwort
//     wird bei Erfolg nicht gelesen;
//   * `4xx` ist endgültig, außer 408, 425 und 429; alles andere (5xx,
//     Netzfehler) wird mit Verdopplung wiederholt.
//
// NICHT nachgebaut: der von einer 429 genannte Termin (`Retry-After`), die
// Frist von 15 min, die harte Grenze von 60 min und der Marker im Dateisystem.
// Der Hub nennt keinen Termin und kennt die Fristen nicht; für den Testlauf
// treten kurze Wartezeiten und eine Höchstzahl an Versuchen an ihre Stelle.

export type SimulatorConfig = {
  // Die vollständige URL steht im Archiv; der Pfad ist eine Entscheidung des
  // Hubs und keine des Agenten.
  registrationUrl: string;
  registrationToken: string;
  agentVersion: string;
  listenHost: string;
  listenPort: number;
  readOnly: boolean;
};

export type SimulatorOptions = {
  fetchImpl?: typeof fetch;
  // Frist eines einzelnen Aufrufs. Beim Agenten 10 s.
  timeoutMs?: number;
  // Die Wartezeit vor dem zweiten Versuch; sie verdoppelt sich. Beim Agenten
  // 1 s bis 180 s — im Test einstellbar, weil ein Test, der Minuten wartet,
  // nicht gelaufen wird.
  firstWaitMs?: number;
  maxWaitMs?: number;
  // Tritt im Test an die Stelle der Frist von 15 Minuten.
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  // ⚠️ Wie beim Original: nie URL, Token oder Antwortrumpf. Der reine Status
  // darf heraus.
  log?: (message: string) => void;
};

export type SimulatorResult =
  | { outcome: "registered"; attempts: number }
  // Ein `4xx`, das keine Wiederholung verspricht: der Agent gibt auf und
  // schreibt keinen Marker.
  | { outcome: "rejected"; attempts: number; status: number }
  // Wiederholbar, aber das Budget ist alle.
  | { outcome: "exhausted"; attempts: number; lastStatus: number | null };

const RETRYABLE_4XX = new Set([408, 425, 429]);

const DEFAULTS = {
  timeoutMs: 10_000,
  firstWaitMs: 1_000,
  maxWaitMs: 180_000,
  maxAttempts: 12
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ein einziger Anmeldeversuch — die Anfrage, die der Hub sieht.
 *
 * Gibt den Status zurück und wirft nur bei einem Netzfehler. `response.ok` ist
 * die einzige Auswertung: bei Erfolg liest der Agent den Rumpf nicht.
 */
export async function attemptRegistration(
  config: SimulatorConfig,
  options: SimulatorOptions = {}
): Promise<{ ok: boolean; status: number }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(config.registrationUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-docker-host-registration": config.registrationToken
    },
    body: JSON.stringify({
      agentVersion: config.agentVersion,
      listenHost: config.listenHost,
      listenPort: config.listenPort,
      readOnly: config.readOnly
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULTS.timeoutMs)
  });
  return { ok: response.ok, status: response.status };
}

/**
 * Die Anmeldung mit Wiederholung — bis sie sitzt, endgültig abgelehnt ist oder
 * das Budget alle ist.
 */
export async function runAgentSimulator(
  config: SimulatorConfig,
  options: SimulatorOptions = {}
): Promise<SimulatorResult> {
  const firstWaitMs = options.firstWaitMs ?? DEFAULTS.firstWaitMs;
  const maxWaitMs = options.maxWaitMs ?? DEFAULTS.maxWaitMs;
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  const sleep = options.sleep ?? defaultSleep;
  let lastStatus: number | null = null;

  for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
    try {
      const { ok, status } = await attemptRegistration(config, options);
      lastStatus = status;
      if (ok) {
        options.log?.(`[simulator] angemeldet nach ${attempts} Versuch(en); das Token ist verbraucht.`);
        return { outcome: "registered", attempts };
      }
      if (status >= 400 && status < 500 && !RETRYABLE_4XX.has(status)) {
        // Endgültig: kein Zustand, den eine Wiederholung ändert — jede weitere
        // wäre nur eine weitere Preisgabe des Tokens.
        options.log?.(`[simulator] endgültig abgelehnt (HTTP ${status}) nach ${attempts} Versuch(en).`);
        return { outcome: "rejected", attempts, status };
      }
    } catch (error) {
      // Netzfehler sind wiederholbar: genau die Lage, für die es den Backoff
      // gibt — der Tunnel steht noch nicht.
      lastStatus = null;
      options.log?.(
        `[simulator] Anmeldung noch nicht möglich (${error instanceof Error ? error.name : "Fehler"}).`
      );
    }
    if (attempts < maxAttempts) {
      await sleep(Math.min(firstWaitMs * 2 ** (attempts - 1), maxWaitMs));
    }
  }

  options.log?.(`[simulator] aufgegeben nach ${maxAttempts} Versuchen (zuletzt ${lastStatus ?? "Netzfehler"}).`);
  return { outcome: "exhausted", attempts: maxAttempts, lastStatus };
}
