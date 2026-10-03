# Unraid agent reference

This is a reference for a new agent installation. The versioned image path
is usable after that release image has been published. For the initial source
snapshot use the root README's local-build instructions or a hub-generated
setup archive.

Unraid can use its native WireGuard tunnel. No additional tunnel container
is required. Copy .env.example to a private .env, configure the secret,
socket group ID, bind address and project base path, then validate Compose.
Select an actually published pinned image version and verify its signature
before starting it; see [agent installation and verification](../../README.md).

The agent port must remain bound to the trusted connection address.
Native Unraid templates remain the authority for container definitions,
updates, recreation and removal. Runtime actions and application-file access
follow capability checks. This reference does not authorize replacing native
templates with competing Compose definitions.

For Compose-managed projects, use the configured base path matching Docker's
com.docker.compose.project.working_dir label. Pool and user-share paths can
refer to the same files but are different path strings. Inspect the label
and resolve mismatches deliberately; never move or delete application data
as an automatic correction. Secret rotation uses the transition window
described in the agent README.
