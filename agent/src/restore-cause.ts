// Only identifier-like tokens are returned; free text from Docker or the file system never reaches the audit log.
const token = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_.-]{1,48}$/.test(value) ? value : null;
export function restoreCause(error: unknown): string {
  const parts: string[] = [];
  for (let current = error, depth = 0; current instanceof Error && depth < 3; current = current.cause, depth++) {
    const { code, status } = current as { code?: unknown; status?: unknown };
    parts.push([current.constructor.name, token(code) ?? token(current.message), typeof status === "number" ? String(status) : null].filter(Boolean).join(":"));
  }
  return parts.join(" < ") || "unknown";
}
