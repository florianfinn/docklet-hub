import { execFileSync } from "node:child_process";

// Git for the throwaway repositories some guards build in a temporary
// directory (#286).
//
// ⚠️ THE ENVIRONMENT IS STRIPPED OF EVERY `GIT_*` VARIABLE. Inside a Git hook,
// Git hands its own repository to the hook through `GIT_DIR` and friends, and
// `pnpm run test` inherits them from `.githooks/pre-push`. A `git init` with
// `cwd` set to a temporary directory then re-initialised THIS repository
// instead: measured on 2026-10-02, a push from a worktree left
// `core.bare = true` in the shared `.git/config`, and every checkout and
// worktree answered "fatal: this operation must be run in a work tree" until
// it was set back by hand. `cwd` alone does not isolate Git; only the
// environment does.

/** `process.env` (or `base`) without any `GIT_*` variable. */
export function scratchGitEnvironment(base = process.env) {
  return Object.fromEntries(Object.entries(base).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
}

/**
 * Runs Git in a throwaway repository: no inherited repository, no user hook,
 * no commit signing. Returns stdout.
 */
export function scratchGit(cwd, args) {
  return execFileSync("git", ["-c", "core.hooksPath=", "-c", "commit.gpgSign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: scratchGitEnvironment()
  });
}
