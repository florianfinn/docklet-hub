# docklet hub agent

The agent is the Docker-facing workspace of docklet hub. It mediates access
to a host's Docker engine; the hub and browser never mount the Docker socket.
This source snapshot supports new installations. A published, practically
accepted product release is tracked in the repository's issues and milestones.

## Installation

The root Compose stack builds a local agent from agent/Dockerfile. Follow
the root README for a source installation. Attached hosts can use the hub's
generated setup archive. Reference templates live under deploy/unraid and
deploy/remote-wireguard. Their registry installation path becomes usable
after the corresponding versioned images have been published.

Use the configured project base path and the real Docker socket group ID.
Keep secrets and runtime files outside Git. Each host has its own connection
and identity. Never expose the agent's Docker-facing API to the public internet.

## What the agent mediates

The code contains container and stack inventory, Docker operations, Compose
preview and applying, logs, shell, mounted-file access, metrics and an
agent self-update watcher. Capability checks, path boundaries, request
authentication and bounded streams belong at this boundary. Full product
orchestration, practical acceptance and the first public release are separate
milestone criteria; a route's presence is not evidence of their completion.

Native Unraid container definitions remain under Unraid ownership. The
target permits runtime start/stop/restart, application files, logs, shell,
metrics and game commands. Template edits, image updates, recreate and
removal must stay under the owning manager. Compose management extensions
must be distinguished from native Unraid templates.

## Verify the signature

After a release image exists, verify its immutable digest against the
release workflow identity before starting an update. Substitute a published
version and digest, never copy a private registry token into a command log:

~~~sh
docker run --rm ghcr.io/sigstore/cosign/cosign:v3.1.3 verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity 'https://github.com/florianfinn/docklet-hub/.github/workflows/release.yml@refs/tags/v<VERSION>' \
  'ghcr.io/florianfinn/docklet-hub-agent@sha256:<DIGEST>'
~~~

The watcher uses the same trusted repository and release-workflow identity.
Hub and agent release versions match. Each hub release declares the minimum
agent version; newer protocol requirements can raise it. Outdated agents
need a usable update path even when regular writes are unavailable.

## GHCR login

Public docklet hub images will not require a personal registry login. If
managed workloads pull private images, registry credentials belong in the
host's private Docker configuration, mounted read-only where required.
Do not include its contents in issues or support attachments.

## Rotating the secret

DOCKER_AGENT_SECRET is the primary shared request secret.
DOCKER_AGENT_SECRET_ALT supports a temporary transition window. Configure
the new and previous values as documented in the environment example,
switch the hub, then retire the previous value. Use independent random
values; keep both private. Tests verify rejection of invalid transition values.

## Development and maintenance

The agent shares the root pnpm lockfile and contract workspace. Node 24 is
required. Run the full local lint, test and build chain before a push;
GitHub PR checks and an independent review supplement it. The watcher
must not be run against a live host as part of ordinary tests.

The runtime uses zod and operating-system Docker/WireGuard tools. Image
scan and dependency-update PRs complement explicit release builds. The
runtime image removes package-management tooling that the service does not
need. Apache-2.0 covers this workspace; adopted notices remain intact.

## Data backups and restore

Updates can optionally back up selected eligible mounts in stop or live mode.
Live copies can be inconsistent; stopping the selected container does not stop
other writers of shared data. File copies do not guarantee database consistency.
Image rollback never restores data.

Complete runs are stored below `backups` in the agent data directory, or at
`DOCKER_AGENT_BACKUP_DIR` when set. Directories use mode `0700`, archives `0600`.
The latest three complete runs are retained per Compose project/service or
standalone container name, including after container replacement. Each copy
requires its estimated size plus the contract's fixed 1 GiB free-space reserve.
Unknown size or a failed copy prevents that container's exchange.

Restore is a separate previewed and confirmed job. It stops the container,
extracts selected archives and restores its prior runtime state. Cancellation
is possible only before extraction. Shared, ambiguous and protected sources
cannot be restored. Compose files, `.env` and protected subpaths are excluded.
Backups preserve regular files, directories and relative in-mount symlinks
without following them. Unsafe links and special files are skipped and recorded
with source, path and reason in private backup metadata. Visible restores create
safe symlinks last and copy internal hardlink data through pinned descriptors.
Archives using links as parent directories fail validation. Docker PUT restores
omit links and record them in private restore metadata because target descriptors
cannot be pinned. Contract 13 has no skip-count field. Visible sources use pinned descriptors,
other sources use the Docker archive API. Directory metadata, including the mount root, is restored after its children.
Mount roots use only their own descriptors and keep their inode; insufficient
permissions fail without a parent-path PUT. Invisible directory roots must
already match archived ownership and mode. Their PUT targets the mount itself
and excludes its root header. Metadata PUT for child entries is blocked whenever
a protected writable mount exists. Immediately before and after PUT, visible
parent paths are reopened without following links and compared to the pinned
component inodes. Existing directories must keep their expected inode; existing
regular files cannot use the PUT fallback because Docker replaces them.
Numeric owners and modes are verified; mismatches fail with
`restore-extract-failed` and a path in private `restore-failure.json`. A changed
path binding also records an incident. Docker resolves PUT paths independently;
a race remains after the last check, as with archive writes, and an incident
cannot undo an already completed write.
Unselected mounts never request archive streams during image previews or updates.
Image checks have a 60-second preview budget, followed by at most five seconds
for selected estimates (65 seconds total); the actual backup
still estimates selected archives and checks its free-space reserve.
Open data journals keep blocking updates, restores and healing after startup.
Failed resumes trigger recovery; another operation cannot replace pending state.

An interrupted data operation is recorded privately before stopping. On restart,
recovery restores the prior runtime state and reports an incident; it never
repeats extraction automatically. Failures keep the journal and block affected
operations until recovery succeeds.
