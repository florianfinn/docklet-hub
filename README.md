# docklet hub

Docker stacks, hosts and consoles in one place.

docklet hub is a self-hosted Docker management hub with an agent for each
attached host. Hub, web interface, shared protocol and agent live in this
monorepo. The hub itself never mounts the Docker socket.

This is a development source snapshot, not the first accepted product release.
Milestones and issues track that release. Proxy management, game consoles,
full update orchestration, self-healing and notifications are release goals;
their presence in the design documents is not a claim that they work already.
Only new installations are supported; databases and registrations from
earlier projects are not imported.

## Start from source

Requires Docker Compose on a Linux host. No published docklet hub image is
assumed for this initial snapshot. Build locally:

```sh
sh scripts/bootstrap.sh
docker compose pull postgres
docker compose build
docker compose up -d --pull never
curl -s http://127.0.0.1:8080/health
```

Bootstrap generates a local .env with random secrets and the Docker group ID.
It preserves existing values. Keep that file and all runtime data private.
The stack contains the hub, PostgreSQL, a local agent and a WireGuard sidecar.
The web interface defaults to http://127.0.0.1:8080. The first registered
account becomes the administrator. Keep the running hub on a trusted network
or behind a VPN; public source does not make public runtime exposure safe.

Configuration is documented in [.env.example](.env.example). Attached hosts
are configured from the hub; the deploy templates are reference material.
Image references can be overridden. Published image installation and the
practical release acceptance are tracked separately.

## Administrator recovery

With trusted access to the running hub and its database, inspect the recovery
tool before using it:

```sh
docker compose exec hub node server/dist/platform/auth/break-glass.js --help
```

Recovery output can contain private account data. Keep it private.

## Development

Node 24, pnpm 11. Four workspaces: contract, server, web and agent.

```sh
pnpm install --frozen-lockfile
git config core.hooksPath .githooks
pnpm run lint
pnpm run test
pnpm run build
```

The same checks run for pull requests. Local checks and an independent agent
review are required before integration. See [CONTRIBUTING.md](CONTRIBUTING.md)
and [AGENTS.md](AGENTS.md) for the workflow.

## Planning and security

The [design index](docs/design/README.md) explains the target and decisions
(German). GitHub issues and milestones carry work status. Do not publish real
operator emails, credentials, network topology, hostnames, routes or logs in
code, examples, issues or attachments. Use synthetic reproductions.

See [SECURITY.md](SECURITY.md) for trust boundaries and private reporting.
Hub and agent are licensed under Apache-2.0; adopted component notices remain.
