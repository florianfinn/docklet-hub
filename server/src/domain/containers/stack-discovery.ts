import { agentGet, AgentError, type AgentTarget, type RequestOptions } from "../../platform/agent-transport/protocol.js";

// Die Stack-Erhebung des Agenten — `GET /stacks`.
//
// ⚠️ DIESE DATEI HEISST NICHT `stacks.ts`. Unter `server/src/domain/containers/stacks.ts`
// liegt bereits die Gruppierung für die Übersicht (welcher Container zu
// welchem Projekt gehört und welche Farbe der Stack bekommt). Das hier ist
// etwas anderes: was der Agent auf der PLATTE gefunden hat — Verzeichnisse,
// Compose-Dateien und die Zuordnung ihrer Dienste zu laufenden Containern.
// Zwei Dateien gleichen Namens für Verschiedenes sind eine Falle für den
// nächsten Leser.
//
// Von hier kommt der COMPOSE-ANKER des Registry-Abgleichs. `GET /host-containers`
// nennt je Container nur Projekt- und Servicenamen aus den Labels; `projectDir`
// und `composeFileName` stehen ausschließlich hier (gemessen am 2026-09-07 an
// `florianfinn/dashboard-docker-agent`@6ffc3c8, v0.19.1, `src/stacks.ts:48`).

/** Ein Dienst eines Stacks, verbunden mit dem Container, der ihn ausführt. */
export type DiscoveredStackService = {
  serviceName: string;
  containerName: string;
  containerId: string;
  status: string;
  image: string;
};

/**
 * Ein Stack, wie die Erhebung ihn gefunden hat.
 *
 * `filePresent` sagt, ob die Compose-Datei im Verzeichnis tatsächlich liegt.
 * ⚠️ Der Registry-Abgleich benutzt sie NICHT als Filter: der Anker nennt, wo
 * die Datei hingehört, und ob sie heute da ist, ist eine Frage für den
 * Augenblick der Compose-Aktion. Ein Anker, den der Hub deswegen wegließe,
 * sähe für den Agenten aus wie ein Container ganz ohne Compose.
 */
export type DiscoveredStackEntry = {
  projectDir: string;
  projectName: string;
  composeFileName: string;
  management: string;
  filePresent: boolean;
  services: DiscoveredStackService[];
};

/**
 * Ein Befund der Erhebung: ein Stack oder Container, der KEINEN vollständigen
 * Anker ergibt, mit dem Grund.
 *
 * ⚠️ Die Gründe sind freie Zeichenketten und keine Aufzählung. Gemessen kommen
 * heute vier vor (v0.19.1, `src/stacks.ts`): Container ohne Compose-Labels,
 * Container ohne Verzeichnis, Stack außerhalb des Basispfads, Verzeichnis
 * ohne Container. Ein fünfter, den ein neuerer Arm meldet, darf die Liste
 * nicht umwerfen: die Befunde erklären eine Lücke, sie erzeugen keine — und
 * dieser Hub vergleicht sie gegen nichts.
 *
 * ⚠️ Die Schlüssel selbst stehen hier bewusst NICHT wörtlich: einer davon
 * schreibt „außerhalb" in ASCII-Umschreibung, und der Umlaut-Wächter dieses
 * Repos (web/tests/german-umlauts.test.mjs) fällt darüber. Sie gehören der
 * Gegenseite; wer sie braucht, findet sie an der genannten Stelle.
 */
export type StackFinding = {
  kind: string;
  detail: string | null;
};

export type StackDiscovery = {
  stacks: DiscoveredStackEntry[];
  findings: StackFinding[];
};

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentError(`${what} ist kein Objekt.`);
  }
  return value as Record<string, unknown>;
}

function requiredText(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    throw new AgentError(`${what}: das Feld „${key}" fehlt oder ist leer.`);
  }
  return value;
}

function text(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function optionalText(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function parseService(value: unknown, what: string): DiscoveredStackService {
  const record = asRecord(value, what);
  return {
    // `serviceName` und `containerId` tragen den Anker; ohne sie bedeutet die
    // Zeile nichts, und ein leerer Dienstname machte den Anker beim Agenten
    // ungültig.
    serviceName: requiredText(record, "serviceName", what),
    containerId: requiredText(record, "containerId", what),
    // Der Rest ist Beiwerk für die Fehlersuche. Ein Dienst, der gerade nicht
    // läuft, hat keinen Container-Namen und kein Image — das ist kein Fehler.
    containerName: text(record, "containerName"),
    status: text(record, "status"),
    image: text(record, "image")
  };
}

function parseStack(value: unknown, what: string): DiscoveredStackEntry {
  const record = asRecord(value, what);
  const services = record.services;
  if (!Array.isArray(services)) {
    throw new AgentError(`${what}: das Feld „services" fehlt oder ist keine Liste.`);
  }
  return {
    projectDir: requiredText(record, "projectDir", what),
    composeFileName: requiredText(record, "composeFileName", what),
    // ⚠️ `projectName` wird hier NICHT erzwungen. Er ist im Registry-Vertrag
    // optional; fehlt er, lehnt der Agent nur die STACK-Aktionen ab, während
    // der Container selbst erlaubt bleibt. Ein Abbruch an dieser Stelle nähme
    // dem ganzen Host seine Allowlist wegen eines Feldes, das einen Teil
    // kostet.
    projectName: text(record, "projectName"),
    management: text(record, "management"),
    filePresent: record.filePresent === true,
    services: services.map((service, index) => parseService(service, `${what}, Dienst ${index + 1}`))
  };
}

function parseFinding(value: unknown): StackFinding | null {
  // Gekürzt statt abgebrochen: ein Befund erklärt eine Lücke, er erzeugt
  // keine. Eine Erhebung wegen eines unlesbaren Befunds ganz zu verwerfen
  // hieße, den Anker aller Stacks zu verlieren, die daneben in Ordnung sind.
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string" || kind === "") return null;
  return { kind, detail: optionalText(record, "detail") };
}

/**
 * Liest die Antwort des Agenten auf `GET /stacks`.
 *
 * Bricht bei einem unlesbaren STACK ab, kürzt aber bei einem unlesbaren
 * BEFUND: der Stack trägt den Anker, der Befund nur seine Begründung.
 */
export function parseStackDiscovery(body: unknown): StackDiscovery {
  const envelope = asRecord(body, "Die Antwort auf GET /stacks");
  const stacks = envelope.stacks;
  if (!Array.isArray(stacks)) {
    throw new AgentError(`Die Antwort auf GET /stacks trägt kein Feld „stacks" mit einer Liste.`);
  }
  // `findings` darf fehlen: es erklärt, was NICHT gefunden wurde, und ein Arm
  // ohne Befunde hat schlicht nichts zu erklären.
  const findings = Array.isArray(envelope.findings) ? envelope.findings : [];

  return {
    stacks: stacks.map((stack, index) => parseStack(stack, `Stack ${index + 1} in der Antwort auf GET /stacks`)),
    findings: findings.map(parseFinding).filter((finding): finding is StackFinding => finding !== null)
  };
}

/** Holt die Stack-Erhebung eines Hosts. */
export async function fetchStackDiscovery(
  target: AgentTarget,
  options: RequestOptions
): Promise<StackDiscovery> {
  return parseStackDiscovery(await agentGet(target, "/stacks", options));
}
