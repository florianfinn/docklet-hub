import type { SelfHealingCause, SelfHealingLog } from "contract";
import type { RawInspect } from "./engine-model.js";
import type { RegistryEntry } from "./registry.js";
import { verifiedComposeContextForLogs } from "./log-compose-context.js";
import { secretsFromEnvFile } from "./env-file.js";
import { envPlaintextOf, redactKnownSecrets } from "./redact.js";

export const INCIDENT_LOG_LINE_LIMIT = 500;
export const INCIDENT_LOG_BYTE_LIMIT = 16 * 1024;

function boundedLines(lines: string[]): string[] {
  const result: string[] = [];
  let remaining = INCIDENT_LOG_BYTE_LIMIT;
  for (const line of lines.slice(-50).reverse()) {
    const clipped: string[] = [];
    let bytes = result.length > 0 ? 1 : 0;
    for (const character of Array.from(line).slice(0, INCIDENT_LOG_LINE_LIMIT)) {
      const size = Buffer.byteLength(character, "utf8");
      if (bytes + size > remaining) break;
      clipped.push(character); bytes += size;
    }
    if (bytes > remaining) break;
    result.push(clipped.join("")); remaining -= bytes;
    if (remaining === 0) break;
  }
  return result.reverse();
}

export async function healingEvidence(
  container: RawInspect, cause: SelfHealingCause, entry: RegistryEntry | null, basePath: string,
  logs: (id: string, tail: number, tty: boolean) => Promise<Buffer>,
  envSecrets: (directory: string) => string[] = secretsFromEnvFile
): Promise<{ logs: SelfHealingLog; cause: SelfHealingCause }> {
  let secrets: string[];
  try {
    const context = verifiedComposeContextForLogs(entry, container.Config?.Labels ?? undefined, basePath);
    secrets = [...Object.values(envPlaintextOf(container.Config?.Env)), ...(context ? envSecrets(context.projectDir) : [])];
  } catch {
    return { logs: { available: false, reason: "redaction-unavailable" }, cause: { ...cause, engineError: null } };
  }
  const safeCause = { ...cause, engineError: cause.engineError === null ? null : redactKnownSecrets(cause.engineError, secrets) };
  try {
    const buffer = await logs(container.Id, 50, container.Config?.Tty === true);
    const text = redactKnownSecrets(buffer.toString("utf8"), secrets).replace(/\r\n/g, "\n");
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return { cause: safeCause, logs: { available: true, lines: boundedLines(lines) } };
  } catch { return { cause: safeCause, logs: { available: false, reason: "logs-unavailable" } }; }
}
