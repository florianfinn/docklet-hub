# Contributing

Use Node 24 and pnpm 11. The binding rules are in [AGENTS.md](AGENTS.md).
Identifiers, filenames, protocol values and new code comments are English;
commit messages and design documents are German. Public entry documents and
agent/operator setup instructions are English. UI text belongs in language files.

## Before publishing

Only public, synthetic data belongs here. Do not publish credentials,
personal email addresses, real infrastructure addresses, private routes,
workstation paths, runtime configuration, logs or screenshots with such data.
Use your GitHub noreply email for commits. Report scanner findings without
copying their values into public issues.
Do not add AI authorship or maintainer claims, or AI co-author trailers,
to source, documentation, commits, issues or pull requests. Commits and pull
requests may note AI assistance as plain text without an email address, such
as `Assisted-by: Claude Code`. Commit authors and committers are people with
their noreply address.
Preserve actual third-party license and provenance notices.

```sh
pnpm install --frozen-lockfile
git config core.hooksPath .githooks
git add <reviewed-files>
pnpm run lint
pnpm run test
pnpm run build
```

Git hooks inspect the staged content and commit metadata before publication.
The publication guard intentionally reports paths and categories, not values.
GitHub checks run additionally; they cannot undo a leak after a public push.
Text-only changes as defined by scripts/change-scope.mjs (only .md outside
executed paths, or the root LICENSE or NOTICE) skip install, lint, the full
suite and build in pre-push and checks; publication, commit and prose tests
still run. pre-push compares against origin/main, so branches of a feature
branch take the full chain locally.

## Features and reviews

Develop a feature on codex/feature-<name>. Task branches open pull requests
against that branch. Integrate the complete feature with one final PR to main.
Every PR needs an independent agent review before merging. The reviewer must
not have implemented it and reviews the actual head against the actual base.
Changed code or integration bases require another review.

Record a real review with scripts/record-agent-review.mjs; see
[review workflow](docs/design/review-workflow.md). It posts the evidence, and
the agent-review workflow sets the status after checking it against the current
PR. Required checks enforce a recorded review status and automated checks. Posting a status is an attestation
by a trusted maintainer, not an automatic proof of reviewer independence.
Merge only through scripts/merge-reviewed-pr.mjs with the current private
review report and UTF-8 merge payload. It verifies the newest successful
Actions run for exactly the reviewed integration and rechecks the PR SHAs.

Open issues only for feature work, product or architecture decisions and
findings that are not fixed in the current session. Small self-contained
fixes, maintenance, dependency updates and rule or documentation changes go
straight to a pull request without an issue or milestone. Feature and release
issues state scope, dependencies and acceptance criteria and belong to
feature/intermediate milestones; release:first-public joins the release scope.
Practical release acceptance is distinct from implementation completion.

## Code and protocol

Keep files below 1,000 lines; adopted files must be split when imported.
Keep provenance headers and license notices. Tests run without real services.
Keep comments short and focused on current contracts, constraints or subtle
behavior, usually one to three lines. Do not narrate obvious code or embed
change history, past fixes, previous names or discussions of rejected alternatives.
Use Git and issues for change history, and indexed design documents for detailed
rationale when it remains useful. Apply this when editing existing code.
Preserve license and provenance notices and required tool directives.

Shared API and agent schemas live in contract/. Protocol breaks change the
contract version; necessary agent changes raise MIN_AGENT_VERSION.
The hub and agent share one release version. Future supported versions retain
an explicit update path, although earlier projects are not imported.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting.
