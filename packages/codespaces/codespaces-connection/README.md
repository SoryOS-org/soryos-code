---
description: "Codespaces environment connection lifecycle: provision, SSH bootstrap, remote DeepSeek Harness launch, endpoint discovery, and reconnection"
kind: "package-reference"
---

# @deepseek-ai/dsh-codespaces-connection

English | [中文](README.zh.md)

## Summary

`dsh-codespaces-connection` provides the Codespaces environment connection service (`ctx.codespacesConnection`): the full lifecycle from configuration to a connected remote workspace. It provisions the codespace, bootstraps SSH, launches the remote DeepSeek Harness, discovers the forwarded endpoint, and reconnects after a network loss without recreating the environment. The remote filesystem, terminal, and processes ride the existing SSH provider family mounted on the connection this service owns.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Compose this service with [`dsh-codespaces`](../codespaces/README.md) and [`dsh-codespaces-registry`](../codespaces-registry/README.md) in a profile that needs Codespaces support. The connection service orchestrates the complete flow:

```typescript
// Connect a workspace to its Codespaces environment
const target = await ctx.codespacesConnection.connect(workspaceId)
// target.url - the forwarded HTTPS URL of the remote web UI
// target.workspaceId - the workspace this target belongs to
// target.environment - 'codespaces'

// Reconnect after network loss
const reconnected = await ctx.codespacesConnection.reconnect(workspaceId)

// Disconnect (keeps codespace running)
await ctx.codespacesConnection.disconnect()

// Stop the codespace (filesystem survives, processes do not)
await ctx.codespacesConnection.stopCodespace(workspaceId)

// Delete the codespace and clear stored state (destructive and irreversible)
await ctx.codespacesConnection.deleteEnvironment(workspaceId)
```

### Lifecycle observation

Monitor the connection state through the `status` getter:

```typescript
const state = ctx.codespacesConnection.status
// 'none' | 'creating' | 'starting' | 'started' | 'bootstrapping' |
// 'harness-starting' | 'ready' | 'connected' | 'stopping' | 'stopped' | 'error' | 'reconnecting'
```

### Error handling

All failures throw `CodespaceConnectionError` with stable codes:

```typescript
import { CodespaceConnectionError } from '@deepseek-ai/dsh-codespaces-connection'

try {
  await ctx.codespacesConnection.connect(workspaceId)
} catch (error) {
  if (error instanceof CodespaceConnectionError) {
    switch (error.code) {
      case 'NO_ENVIRONMENT_CONFIGURED':
        // Workspace has no Codespaces environment configured
        break
      case 'CODESPACE_UNAVAILABLE':
        // Codespace is in a conflicting state
        break
      case 'CODESPACE_PROVISION_TIMEOUT':
        // Codespace did not become available within 15 minutes
        break
      case 'SSH_CONFIG_FAILED':
        // GitHub CLI produced no SSH host alias
        break
      case 'HELPER_DEPLOY_FAILED':
        // SSH helper digest mismatch
        break
      case 'HARNESS_LAUNCH_FAILED':
        // Remote harness did not start or print launch URL
        break
      case 'ENDPOINT_UNRESOLVED':
        // Could not resolve forwarded URL
        break
      case 'TRANSPORT':
        // SSH/SCP/gh command failures
        break
    }
  }
}
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service orchestrates the complete Codespaces connection flow:

### 1. Provision (if needed)
- Reads stored state from `ctx.codespacesRegistry`
- If no codespace exists, calls `ctx.codespaces.writeDevcontainer()` and `ctx.codespaces.create()`
- Saves the codespace name back to the registry

### 2. Wait for Availability
- Polls GitHub every 5 seconds for codespace state
- Times out after 15 minutes
- Accepts states: `queued`, `provisioning`, `available`
- Rejects states: `failed`, `deleted`

### 3. Bootstrap SSH
- Runs `gh codespace ssh --config` to get OpenSSH config
- Writes config to `~/.ssh/codespaces`
- Ensures user SSH config includes `Include ~/.ssh/codespaces`
- Parses first `Host` entry as the SSH host alias
- Deploys the SSH helper to the remote codespace via SCP
- Verifies helper digest matches local artifact
- Opens SSH connection via `ctx.ssh` with:
  - `host`: the SSH host alias
  - `node`: remote Node executable path
  - `helper`: remote helper path (`/home/node/.dsh/ssh-helper.js`)
  - `helperHash`: SHA-256 of local helper
  - `workspace`: remote workspace path

### 4. Start Remote Harness
- Spawns SSH process running: `cd /workspaces/<repo> && dsh web --port 3080 --no-open --host 127.0.0.1`
- Parses launch URL from stdout (pattern: `http://127.0.0.1:<port>/?token=<token>`)
- Extracts port and token from URL
- Times out after 60 seconds

### 5. Resolve Forwarded Endpoint
- Runs `gh codespace ports -c <name> --json remoteUrl,number` to find forwarded port
- Falls back to constructing URL from `GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN`
- Format: `https://<name>-<port>.githubpreview.dev` (or custom domain)

### 6. Persist and Return
- Saves complete state to registry (including workspaceUrl)
- Returns `RemoteWorkspaceTarget` with url, workspaceId, environment

### Reconnect Flow
- Re-reads codespace from GitHub
- If codespace is deleted (404), clears state and re-runs full connect flow
- Otherwise, disconnects existing connection and re-runs from bootstrap SSH

### Disconnect Flow
- Kills harness process with SIGTERM
- Closes SSH connection
- Clears internal state
- Does NOT stop or delete the codespace

### Dependencies

- `ctx.github` - GitHub token resolution
- `ctx.codespaces` - Codespaces API service
- `ctx.codespacesRegistry` - Durable state storage
- `ctx.ssh` - SSH connection capability (mounted by this service)
- External commands: `gh`, `ssh`, `scp`

### Constants

- **HARNESS_PORT**: 3080
- **AVAILABILITY_POLL_MS**: 5000 (5 seconds)
- **AVAILABILITY_TIMEOUT_MS**: 900000 (15 minutes)
- **REMOTE_HELPER_PATH**: `/home/node/.dsh/ssh-helper.js`
- **SSH_CONFIG_PATH**: `~/.ssh/codespaces`

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Codespaces package](../codespaces/README.md) — the underlying GitHub Codespaces API service.
- [Codespaces registry package](../codespaces-registry/README.md) — durable per-workspace environment state.
- [SSH package](../../ssh/README.md) — the SSH capability family this service mounts.
- [Remote workspace types](../../api/remotes/README.md) — the `RemoteWorkspaceTarget` interface.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the remote workspace that this service connects.

#### KV Cache effect

None; this service orchestrates infrastructure.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Requires GitHub CLI (`gh`) to be installed and authenticated on the host machine.
- Requires `ssh` and `scp` commands to be available on the host.
- The SSH helper must be built and available locally for deployment.
- Reconnect does not automatically retry on transient failures; caller must handle.
- The forwarded endpoint discovery relies on GitHub's port forwarding; custom domains may require additional configuration.
- No automatic cleanup of stale codespaces; deletion is explicit and destructive.

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published. Lifecycle state is authoritative in GitHub; local state is a projection that may lag. The service enforces quiescence before state transitions and never mutates GitHub state directly.

</details>
