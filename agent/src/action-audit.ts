// Keep the failure key and combined evidence ahead of truncatable diagnostics.
export function actionAuditReason(delegation: ReadonlySet<string>, reason?: string, key = reason): string | undefined {
  const rules = [...new Set([...delegation].flatMap((note) =>
    note.replace(/^delegation-lock-allowed: /, "").split(",")))].sort().join(",");
  const evidence = rules ? `delegation-lock-allowed: ${rules}` : undefined;
  const diagnostic = reason && key && reason.startsWith(key) ? reason.slice(key.length).replace(/^: ?|^ /, "") : reason;
  return [key, evidence, diagnostic].filter(Boolean).join("; ") || undefined;
}
