import type { SelfHealingCause, SelfHealingLog } from "contract";
import type { RawInspect } from "./engine-model.js";
import type { RegistryEntry } from "./registry.js";
import { verifiedComposeContextForLogs } from "./log-compose-context.js";
import { secretsFromEnvFile } from "./env-file.js";
import { envPlaintextOf, redactKnownSecrets } from "./redact.js";

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
    return { cause: safeCause, logs: { available: true, lines: lines.slice(-50) } };
  } catch { return { cause: safeCause, logs: { available: false, reason: "logs-unavailable" } }; }
}
