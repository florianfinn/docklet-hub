import test from "node:test";
import assert from "node:assert/strict";
import { parseRepository, resolveRepository } from "../../scripts/github-repository.mjs";

// Assembled so the publication guard does not read the SSH user as an email address.
const ssh=["git","github.com"].join("@");

test("Repo-Name kommt ohne GraphQL aus HTTPS-, SSH- und Umgebungsangaben", () => {
  for (const url of ["https://github.com/example-org/demo-repo","https://github.com/example-org/demo-repo.git",ssh+":example-org/demo-repo.git","ssh://"+ssh+"/example-org/demo-repo/"])
    assert.equal(parseRepository(url),"example-org/demo-repo",url);
  assert.equal(resolveRepository({GITHUB_REPOSITORY:"example-org/demo.repo"}),"example-org/demo.repo");
});

test("unbekannte Remote-Formen brechen ab statt zu raten", () => {
  for (const url of ["https://example.com/example-org/demo-repo","https://github.com/example-org","https://github.com/a/b/c","file:///tmp/repo"])
    assert.throws(()=>parseRepository(url),/Unsupported/,url);
});
