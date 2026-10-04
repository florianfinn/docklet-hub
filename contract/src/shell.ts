// Characters that need no quoting in POSIX sh. `=` and `~` are always quoted:
// bash expands `~` after `=` even in an argument. A leading `-` is quoted so
// the value at least looks like one.
const PLAIN_WORD = /^[A-Za-z0-9_@%+:,./][A-Za-z0-9_@%+:,./-]*$/;

/**
 * One argument for a POSIX sh command line that the operator copies.
 *
 * Plain paths stay as they are; anything else goes into single quotes, with
 * `'` written as `'\''`. Inside single quotes sh expands nothing, so the
 * command receives the value unchanged as one argument.
 *
 * ⚠️ Quoting does not stop a command from reading `-x` as an option. Callers
 * pass values that cannot start with `-` (absolute paths, endpoint hosts).
 */
export function quoteShellArgument(value: string): string {
  if (PLAIN_WORD.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
