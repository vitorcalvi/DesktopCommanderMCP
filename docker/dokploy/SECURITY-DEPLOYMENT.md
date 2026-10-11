# Desktop Commander: security deployment notes

This security branch intentionally changes the **default** Dokploy container to a
workspace-only execution environment.

## Secure default

- No Docker daemon socket, host home, or Dokploy configuration bind mounts.
- A non-root `node` user runs the application.
- The startup script overwrites the persisted allowed-directory list with
  `/workspace` by default, including for existing configuration volumes.
- Cloudflare Access login requires a non-empty `CF_ACCESS_ALLOWED_EMAILS`
  allowlist. The independent operator bearer token still works.
- The service publishes only `127.0.0.1:8766` on the Docker host; an
  authenticated tunnel/proxy must be configured separately.

## Before switching a running service

1. Back up the named configuration and workspace volumes.
2. Configure `CF_ACCESS_ALLOWED_EMAILS` explicitly and verify operator-token
   recovery before restarting. A missing Access allowlist intentionally fails
   Access authentication rather than accepting all Access users.
3. Review persistent-volume ownership. The runtime UID/GID is now 1000:1000,
   so an existing root-owned named volume may require an administrator to
   correct permissions first.
4. Existing host filesystem management commands will stop working. This is
   intentional: a command-execution endpoint with the Docker socket can
   otherwise control the host. Review each desired host capability before
   re-enabling anything.

For an explicitly approved additional workspace volume, add the least
privileged bind mount through Dokploy and set
`DESKTOP_COMMANDER_ALLOWED_DIRECTORIES` to a comma-separated set of exact
absolute paths. **Do not** mount `/var/run/docker.sock` into the general MCP
execution container. Use a narrowly scoped Docker API proxy or a separately
authenticated operator service for container operations.

This is a configuration proposal; it is not a live deployment.
