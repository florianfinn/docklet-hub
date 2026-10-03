import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { scratchGit } from "./scratch-git.mjs";

// Guards for `scratch-git.mjs` (#286): the guards that build a throwaway
// repository must not reach the repository of a Git hook that started them.
// Measured on 2026-10-02: under `.githooks/pre-push`, `git init` in a temporary
// directory re-initialised this repository through the inherited `GIT_DIR`
// and left `core.bare = true` in the shared `.git/config`.

const TESTS = fileURLToPath(new URL("./", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("unter einem geerbten GIT_DIR bleiben die Wächter in ihrem Wegwerf-Repo", () => {
  // A decoy stands in for the hook's repository: the children get its
  // `GIT_DIR`, as `pnpm run test` does under `pre-push`.
  const decoy = mkdtempSync(join(tmpdir(), "scratch-git-decoy-"));
  try {
    scratchGit(decoy, ["init", "-q"]);
    const gitDir = join(decoy, ".git");
    const configBefore = readFileSync(join(gitDir, "config"), "utf8");

    const environment = { ...process.env, GIT_DIR: gitDir };
    // Node's test runner context is private to this process (see
    // `commit-messages-history.test.mjs`).
    delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      ["--test", "--test-reporter=tap", "web/tests/german-umlauts.test.mjs", "web/tests/commit-messages-history.test.mjs"],
      { cwd: ROOT, encoding: "utf8", timeout: 120_000, env: environment }
    );
    if (result.error) throw result.error;
    const output = result.stdout + result.stderr;

    assert.equal(readFileSync(join(gitDir, "config"), "utf8"), configBefore, "the decoy's config was rewritten");
    assert.equal(scratchGit(decoy, ["ls-files"]), "", "files were staged into the decoy");
    assert.equal(result.status, 0, `the guards failed under an inherited GIT_DIR:\n${output.slice(-3000)}`);
  } finally {
    rmSync(decoy, { recursive: true, force: true });
  }
});

test("jeder Wächter, der ein Repo anlegt, geht über scratch-git.mjs", () => {
  // A new guard with its own `git init` or `git clone` would bring the leak
  // back. Matched on the argument list as it is written in this directory.
  const offenders = readdirSync(TESTS)
    .filter((name) => /\.test\.(mjs|tsx)$/.test(name) && name !== "scratch-git.test.mjs")
    .filter((name) => {
      const text = readFileSync(join(TESTS, name), "utf8");
      return /\[\s*"(init|clone)"/.test(text) && !text.includes('from "./scratch-git.mjs"');
    });
  assert.deepEqual(offenders, [], "these guards create a repository without scratch-git.mjs");
});
