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

## Features and reviews

Develop a feature on codex/feature-<name>. Task branches open pull requests
against that branch. Integrate the complete feature with one final PR to main.
Every PR needs an independent agent review before merging. The reviewer must
not have implemented it and reviews the actual head against the actual base.
Changed code or integration bases require another review.

Record a real review with scripts/record-agent-review.mjs; see
[review workflow](docs/design/review-workflow.md). Required checks enforce a
recorded review status and automated checks. Posting a status is an attestation
by a trusted maintainer, not an automatic proof of reviewer independence.

Use fresh issues with explicit scope, dependencies and acceptance criteria.
Issues belong to feature/intermediate milestones; release:first-public joins
the release scope. Decisions have their own issues. Practical release
acceptance is distinct from implementation completion.

## Code and protocol

Keep files below 1,000 lines; adopted files must be split when imported.
Keep provenance headers and license notices. Tests run without real services.
Shared API and agent schemas live in contract/. Protocol breaks change the
contract version; necessary agent changes raise MIN_AGENT_VERSION.
The hub and agent share one release version. Future supported versions retain
an explicit update path, although earlier projects are not imported.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting.
