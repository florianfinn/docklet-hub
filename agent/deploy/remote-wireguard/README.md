# Remote agent with WireGuard sidecar

This reference connects a new host through a WireGuard sidecar. The registry
installation path becomes usable after the selected versioned image has
been published. Use the root README for a local source build.

The hub-generated setup archive supplies per-host configuration and a
one-time registration token. This template contains no real secrets or keys.
Manual setup requires private .env and wg0.conf files with the values listed
in .env.example. Protect both files with mode 600 and validate Compose before
starting. Keep the agent reachable only through the trusted connection.

Agent and sidecar use the same pinned image. Verify its immutable digest
against the release-workflow identity before starting it; see
[agent signature verification](../../README.md#verify-the-signature).
Published public images will not require GHCR login. Credentials for private
workload images remain in private host configuration.

Registration status and protocol values come from the shared contract.
Failed or interrupted setup must be reported without publishing tokens,
keys, live endpoints or routing details. Secret rotation uses the transition
window described in the agent README.
