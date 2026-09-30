---
description: "The dsh-codespaces bundle: GitHub Codespaces environment services over dsh-base, plus the isolated agent preset mounting the SSH remote provider family"
kind: "package-bundle"
---

# @deepseek-ai/dsh-codespaces

English | [中文](README.zh.md)

## Summary

The `dsh-codespaces` bundle adds GitHub Codespaces environment support to `dsh-base`. It provides the complete Codespaces lifecycle — authorization, codespace management, connection, SSH bootstrap, and remote harness launch — plus an isolated agent preset that mounts the SSH remote provider family for filesystem, subprocess, and terminal operations inside a connected codespace.

You do not compose this bundle directly; it is designed to be added on top of `dsh-base` in a profile that needs Codespaces support. The bundle is a **patch layer** that inserts the required services; the actual remote providers are mounted dynamically by `ctx.codespacesConnection` at connect time.

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

Add this bundle to a custom profile built on `dsh-base`:

```json
{
  "name": "my-codespaces-profile",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-codespaces"
      ]
    }
  }
}
```

Or install it into an existing profile:

```bash
dsh plugin --profile my-profile add @deepseek-ai/dsh-codespaces
```

### What you get

Out of the box, a profile with this bundle provides:

1. **GitHub Authorization** (`ctx.github`) - OAuth device flow + PAT support for GitHub API access
2. **Codespaces API Service** (`ctx.codespaces`) - Full lifecycle over GitHub REST API
3. **Codespaces Registry** (`ctx.codespacesRegistry`) - Durable per-workspace environment state
4. **Codespaces Connection** (`ctx.codespacesConnection`) - Complete connection lifecycle service
5. **Codespaces Controller** (`ctx.remote.codespaces`) - Browser-facing API namespace
6. **Codespaces Agent Preset** - Isolated preset mounting SSH remote providers

### Using Codespaces

Once the bundle is installed:

1. **Authorize GitHub** - Configure GitHub credentials with `codespaces` scope
2. **Configure Workspace** - Select repository, branch, and machine type
3. **Connect** - The service provisions the codespace, bootstraps SSH, and launches the remote harness
4. **Use** - The model can now use filesystem, subprocess, and terminal tools against the remote workspace

### Agent preset selection

The bundle includes a Codespaces agent preset (`presets/codespaces.patch.yml`) that automatically mounts the SSH remote providers when a workspace has a Codespaces environment configured. The preset:

- Creates an isolated group (`codespaces-group`) with `workspace: true` isolation
- Mounts: `fs-ssh`, `subprocess-ssh`, `bash-local`, `terminal-bash`, `sandbox-policy`, `sandbox-ssh`
- Configures `sandbox-policy` with `workspaceRoot: '/workspaces'`

The preset is applied when the workspace state has `kind: 'codespaces'`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle is a **static patch document** composed of two patch files:

### 1. Main bundle patch (`cordis.patch.yml`)

Inserts the following rows **after** `dsh-base`'s insert:

```yaml
# GitHub authorization
- id: github-auth
  name: '@deepseek-ai/dsh-github-auth'

# Codespaces API service
- id: codespaces
  name: '@deepseek-ai/dsh-codespaces'

# Durable state
- id: codespaces-registry
  name: '@deepseek-ai/dsh-codespaces-registry'

# Connection lifecycle
- id: codespaces-connection
  name: '@deepseek-ai/dsh-codespaces-connection'

# Browser API
- id: codespaces-controller
  name: '@deepseek-ai/dsh-api-codespaces-controller'
```

### 2. Agent preset patch (`presets/codespaces.patch.yml`)

Inserts the Codespaces agent preset:

```yaml
- insert:
    - id: preset-codespaces
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: codespaces
        name: GitHub Codespaces
        description: Execute inside a GitHub Codespaces environment...
        order: 20
        plugins:
          # SSH remote providers in isolated group
          - id: codespaces-group
            name: cordis:group
            group: true
            isolate:
              workspace: true
            config: [...]
```

### Composition order

The bundle is designed to be layered **after** `dsh-base`:
1. `dsh-base` provides the core services (sessions, tools, etc.)
2. This bundle adds Codespaces-specific services
3. The preset adds the SSH remote providers in an isolated realm

### Why isolation?

The SSH remote providers (`fs-ssh`, `subprocess-ssh`, `sandbox-ssh`) are mounted in an **isolated group** with `workspace: true` isolation. This means:

- They only apply to agents created with the Codespaces preset
- They do not affect the host's local filesystem/subprocess
- The `SshConnection` is mounted by `ctx.codespacesConnection` and inherited through realm inheritance
- The isolation prevents remote providers from interfering with local operations

### Remote provider family

The preset mounts:
- `fs-ssh` - Remote filesystem over SSH
- `subprocess-ssh` - Remote subprocess over SSH
- `bash-local` - Bash executor (runs on remote via SSH connection)
- `terminal-bash` - Persistent terminal (runs on remote via SSH connection)
- `sandbox-policy` - Sandbox policy with workspace root at `/workspaces`
- `sandbox-ssh` - Sandbox provider for SSH

Note: The actual `SshConnection` is **not** in the preset — it is mounted dynamically by `ctx.codespacesConnection.connect()` and inherited by the isolated group through Cordis realm inheritance.

### Token and credential security

- GitHub tokens are resolved per-call via `ctx.github` and **never** stored in the preset or exposed to the model
- SSH credentials are managed by the OpenSSH agent and `gh codespace ssh --config`
- The remote harness runs under the codespace's `node` user with restricted permissions

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Codespaces package](../../codespaces/codespaces/README.md) — the GitHub Codespaces API service.
- [Codespaces connection package](../../codespaces/codespaces-connection/README.md) — the connection lifecycle service.
- [Codespaces registry package](../../codespaces/codespaces-registry/README.md) — the durable state service.
- [Codespaces controller package](../../api/codespaces-controller/README.md) — the browser API surface.
- [Base bundle](../base/README.md) — the shared core this bundle extends.
- [Profile plugin bundles note](../../../.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.md) — the profile and bundle composition design.

<a id="model-experience"></a>
## Model Experience

None, as this bundle is a patch layer only.

#### KV Cache effect

None; this bundle provides infrastructure.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only one codespace can be active per workspace at a time.
- The preset assumes the codespace uses Node 22 and has the harness installed globally.
- SSH provider configuration assumes `gh codespace ssh --config` output format.
- The workspace root is hardcoded to `/workspaces` in the sandbox policy.
- No automatic fallback to local providers if codespace connection fails.

<details>
<summary>Working context for maintainers — click to expand</summary>

The bundle is a **static patch-list carrier**: each inserted row's package owns that row's invariants. The bundle owns no mutable relation to check; there is no invariant companion.

The preset is designed for use with `ctx.codespacesConnection`. Do not mount the SSH remote providers directly without the connection service.

</details>
