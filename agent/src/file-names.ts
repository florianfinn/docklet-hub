import { ENV_FILE_NAME } from "./env-file.js";
const BLOCKED_FILES = new Set([
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml"
]);

export function isBlockedName(name: string): boolean {
  return (
    name === ENV_FILE_NAME ||
    name.startsWith(`${ENV_FILE_NAME}.`) ||
    BLOCKED_FILES.has(name.toLowerCase())
  );
}
