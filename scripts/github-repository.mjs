import { execFileSync } from "node:child_process";

// REST-only callers: `gh repo view` needs GraphQL, which some sessions cannot reach.
export function parseRepository(url) {
  const match=/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  if(!match)throw new Error("Unsupported GitHub remote URL");
  return match[1];
}

export function resolveRepository(env=process.env) {
  if(env.GITHUB_REPOSITORY)return parseRepository("https://github.com/"+env.GITHUB_REPOSITORY);
  return parseRepository(execFileSync("git",["remote","get-url","origin"],{encoding:"utf8"}));
}
