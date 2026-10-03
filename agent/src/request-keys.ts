// TRANSITION (#418): read request keys under the new AND the old name.
//
// When the wire format was switched to English, the mapping table only covered
// the RESPONSE keys. The request side — query parameters and body fields —
// was in no table: the dashboard moved them along anyway
// (`docker-agent-client.ts` sends `share`, `path`, `plaintext`, `set`,
// `remove`), the agent kept reading `freigabe`, `pfad`, `klartext`, `setzen`,
// `entfernen`. Both sides compile on their own and are green: `tsc` does not
// see the wire, and a missing query parameter is not an exception but `null`.
// The agent treats that as "not given" — WebFTP answers empty or rejects,
// without an error appearing anywhere.
//
// Why COMPATIBLE and not a clean cut: the rollout order puts the new agent on
// all hosts FIRST, the dashboard follows afterwards. In this window an OLD
// dashboard calls a NEW agent. If the agent only read the English names,
// WebFTP would be broken on every host until the dashboard has caught up —
// again silently, again without an error message.
//
// Both names are READ, the new one takes precedence. ONLY the new one is
// WRITTEN or GENERATED; no new German key is created.
//
// This accommodation may disappear again as soon as a dashboard from this
// version on runs everywhere — from then on nobody sends the old names any
// more, and the fallback is dead code.

// The old and the new name of every request key that was renamed (#418).
// Since #272 the handlers do not read single keys any more: they parse the
// whole query or body against its schema in `contract/src/agent/`, and these
// two functions hand them the input with the old names already moved over.
export const QUERY_KEY_RENAMES: ReadonlyArray<readonly [key: string, legacyKey: string]> = [
  ["share", "freigabe"],
  ["path", "pfad"],
  ["plaintext", "klartext"]
];

export const BODY_KEY_RENAMES: ReadonlyArray<readonly [key: string, legacyKey: string]> = [
  ["set", "setzen"],
  ["remove", "entfernen"],
  ["path", "pfad"]
];

// ⚠️ The fallback decision hinges on `null`, not on the truthiness of the
// value. `?path=` (empty, valid: the share itself) yields `""` — with `||` the
// reader would take that as "missing" and, behind the back of a NEW dashboard,
// fall back to an old `freigabe=` that can be in the same URL. The new name
// wins as soon as it is SET, even when empty.
//
// The FIRST value of every parameter, as `URLSearchParams.get` returns it: a
// key given twice does not become a list the schema would have to refuse.
export function queryObject(url: URL): Record<string, string> {
  const query: Record<string, string> = {};
  for (const key of new Set(url.searchParams.keys())) query[key] = url.searchParams.get(key) ?? "";
  for (const [key, legacyKey] of QUERY_KEY_RENAMES) {
    const legacy = query[legacyKey];
    delete query[legacyKey];
    if (query[key] === undefined && legacy !== undefined) query[key] = legacy;
  }
  return query;
}

// ⚠️ Likewise in the body: only `undefined`/`null` count as "not sent".
// `set: {}` or `remove: []` from a new dashboard are VALUES — they must not
// fall back to `setzen`/`entfernen`, otherwise a request would mix the two
// versions and write values the caller had deleted.
export function bodyWithLegacyKeys(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  const result: Record<string, unknown> = { ...body };
  for (const [key, legacyKey] of BODY_KEY_RENAMES) {
    const legacy = result[legacyKey];
    delete result[legacyKey];
    if ((result[key] === undefined || result[key] === null) && legacy !== undefined) result[key] = legacy;
  }
  return result;
}

// TRANSITION (v0.18.0): seven environment keys have become English. They are
// in the hosts' `docker-compose.yml`; a one-sided rename would let `env.X`
// silently fall to `undefined`. Hence the new name is read, and where it is
// missing, the old one. `legacyEnvKeysInUse` names at startup what still
// needs to be switched over.
export const LEGACY_ENV_KEYS: ReadonlyArray<readonly [key: string, legacyKey: string]> = [
  ["DOCKER_AGENT_SELF_UPDATE_DIR", "DOCKER_AGENT_SELBSTUPDATE_DIR"],
  ["DOCKER_AGENT_WATCHER_TICK_MS", "DOCKER_AGENT_WATCHER_TAKT_MS"],
  ["DOCKER_AGENT_WATCHER_START_DEADLINE_MS", "DOCKER_AGENT_WATCHER_STARTFRIST_MS"],
  ["DOCKER_AGENT_SIGNATURE_ISSUER", "DOCKER_AGENT_SIGNATUR_ISSUER"],
  ["DOCKER_AGENT_SIGNATURE_IDENTITY", "DOCKER_AGENT_SIGNATUR_IDENTITAET"],
  ["DOCKER_AGENT_DOCKERCFG_HOST_PATH", "DOCKER_AGENT_DOCKERCFG_HOST_PFAD"],
  ["DOCKER_AGENT_WATCHER_CHECK_TICK_MS", "DOCKER_AGENT_WATCHER_PRUEFTAKT_MS"]
];

export function envWithLegacyName(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const pair = LEGACY_ENV_KEYS.find(([candidate]) => candidate === key);
  if (!pair) throw new Error(`no legacy name registered for ${key}`);
  const value = env[key];
  return value !== undefined ? value : env[pair[1]];
}

// Which old names the environment still carries — for a line in the startup
// log, so that the operator knows what they can switch over in their compose
// file.
export function legacyEnvKeysInUse(env: NodeJS.ProcessEnv): string[] {
  return LEGACY_ENV_KEYS.filter(([key, legacyKey]) => env[key] === undefined && env[legacyKey] !== undefined).map(
    ([, legacyKey]) => legacyKey
  );
}
