# Security and publication policy

## Trust boundaries

The hub and web interface do not mount docker.sock. Only the agent does; that
socket provides powerful Docker Engine access even when mounted read-only.
Agents independently check authentication, caller tier, allowlists, paths,
ownership and hardening constraints. Registration is a separate minimal
application with a one-time enrollment token. Remote agents use a tunnel;
the local agent is reached on the private Compose network.

The running hub belongs on a trusted network or behind a VPN. Public source
publication does not approve exposing the management API to the internet.
Agents must not publish their HTTP API on an untrusted network. Proxy login
support in the release target does not automatically change that boundary.

Unraid owns externally managed container definitions and templates. Permitted
runtime operations are separate from changes to those definitions; consistent
enforcement is tracked as a release requirement. Never infer authorization
from a user-supplied path, network label or forwarded header alone.

## Public information

Do not commit or attach actual passwords, keys, contact emails, hostnames,
domains, infrastructure addresses, network diagrams, routing configurations,
personal workstation paths or unredacted operational logs. This includes
issues, PR descriptions, examples, screenshots and release artifacts.
Use reserved example domains/addresses and synthetic records. Product network
defaults and network parsing fixtures are documented exceptions, not copies
of a private installation. Git metadata must use public noreply addresses.

Local staged-content and history checks complement an independent review.
Pattern scanners cannot recognize every private sentence or image. GitHub
secret scanning/push protection supplements them for supported credentials.

## Reporting vulnerabilities

Use this repository's private vulnerability reporting when enabled. Do not
open a public issue or publish a proof containing credentials or private
infrastructure. If reporting is unavailable, contact the owner privately
without posting sensitive details on the public issue tracker.

## Supported installation history

This public project starts with new installations. It does not import earlier
databases, allowlists or update-state files. Future releases preserve explicit
version/contract boundaries and document upgrade requirements. Image signature
verification trusts the configured repository identity, never an identity
selected by the image being verified. Unattended agent replacement requires
a separate decision; an update request is explicit.
