---
description: "GitHub Codespaces lifecycle service over the official REST API: create, get, list, start, stop, remove, plus repository and branch validation"
kind: "package-reference"
---

# @deepseek-ai/dsh-codespaces

English | [中文](README.zh.md)

## Summary

`dsh-codespaces` provides the GitHub Codespaces lifecycle service (`ctx.codespaces`): a typed seam over the official REST API for creating, reading, listing, starting, stopping, and removing codespaces. Every operation validates its inputs against GitHub — repository and ref must exist and be accessible before creation — and every failure carries a structured `CodespaceError` with a stable machine-routable code. The GitHub token is resolved per call through `ctx.github` and never leaves the host process.

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

Compose this service in a `dsh` profile that needs GitHub Codespaces support. The service injects `ctx.github` for token resolution; ensure the GitHub provider is configured with the `codespaces` scope before use.

### Basic usage

```typescript
// Create a codespace
const codespace = await ctx.codespaces.create({
  repository: 'owner/name',
  branch: 'main',
  machine: 'basicLinux32gb',
})

// List all codespaces
const all = await ctx.codespaces.list()

// Get a specific codespace
const specific = await ctx.codespaces.get(codespace.name)

// Start a stopped codespace
await ctx.codespaces.start(codespace.name)

// Stop a running codespace
await ctx.codespaces.stop(codespace.name)

// Delete a codespace (destructive)
await ctx.codespaces.remove(codespace.name)
```

### Configuration flow helpers

```typescript
// List repositories the user can create codespaces in
const repos = await ctx.codespaces.listRepositories()

// List branches of a repository
const branches = await ctx.codespaces.listBranches('owner/name')

// List available machine types for a repository
const machines = await ctx.codespaces.listMachines('owner/name')
```

### Devcontainer management

The service writes and reads the SoryCode devcontainer configuration:

```typescript
// Write the SoryCode devcontainer to a repository
await ctx.codespaces.writeDevcontainer('owner/name')

// Read the existing devcontainer from a repository
const content = await ctx.codespaces.readDevcontainer('owner/name')
```

The devcontainer specifies Node 22 (the harness runtime requirement), SSH server feature, port 3080 forwarding, and pins the harness version.

### Error handling

All operations throw `CodespaceError` on failure. Route on the `code` field, not message content:

```typescript
import { CodespaceError } from '@deepseek-ai/dsh-codespaces'

try {
  await ctx.codespaces.create({ repository: 'owner/missing' })
} catch (error) {
  if (error instanceof CodespaceError) {
    switch (error.code) {
      case 'CODESPACE_AUTH':
        // No or invalid GitHub credential
        break
      case 'CODESPACE_INVALID_REPOSITORY':
        // Repository does not exist or is not accessible
        break
      case 'CODESPACE_INVALID_REF':
        // Branch/tag/commit does not exist
        break
      case 'CODESPACE_QUOTA':
        // Account exceeded Codespaces quota
        break
      case 'CODESPACE_FORBIDDEN':
        // Account lacks Codespaces permission
        break
      case 'CODESPACE_NOT_FOUND':
        // Codespace does not exist
        break
      case 'CODESPACE_API':
      case 'CODESPACE_UNAVAILABLE':
        // API or codespace state errors
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

The service wraps the GitHub REST API with typed schemas and structured error handling. Each method:

1. Resolves the GitHub token via `ctx.github.resolveToken()`
2. Validates inputs (repository format, existence, ref existence)
3. Makes the API request with required headers (`Authorization`, `Accept`, `X-GitHub-API-Version`, `User-Agent`)
4. Validates the response with Zod schemas
5. Projects the response onto public types

### Required GitHub scopes

The service requires the `codespaces` OAuth scope. Configure this when authorizing GitHub.

### API headers

- `Authorization: Bearer <token>`
- `Accept: application/vnd.github+json`
- `X-GitHub-API-Version: 2026-03-10`
- `User-Agent: deepseek-harness/<version>`

### Devcontainer content

The written devcontainer JSON includes:
- Node 22 image (`mcr.microsoft.com/devcontainers/javascript-node:22`)
- SSH server feature
- Port 3080 forwarding with private visibility
- `npm install -g @deepseek-ai/dsh@<version>` post-create command
- `node` remote user

This ensures the codespace has the correct runtime and automatically starts the harness on port 3080.

### Token security

The GitHub token is resolved per-call and never stored, logged, or exposed to the model. It remains in the host process memory only.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Codespaces connection package](../codespaces-connection/README.md) — lifecycle from provision to connected remote workspace.
- [Codespaces registry package](../codespaces-registry/README.md) — durable per-workspace environment state.
- [GitHub auth package](../../github-auth/README.md) — token resolution service.
- [SSH package](../../ssh/README.md) — the SSH capability family used for remote connections.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the codespaces connection and registry packages that use this service.

#### KV Cache effect

None; this service makes no model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Repository and ref validation requires network access; offline operation is not supported.
- The service assumes the GitHub REST API endpoint; self-hosted GitHub instances require configuration via `config.apiBase`.
- Request timeouts are bounded (default 30 seconds); long-running operations may fail on slow networks.
- Pagination is not implemented for list operations; repositories with more than 100 repos/branches may return incomplete results.

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published. Wire validation through the GitHub API and Zod schema validation enforce the observable obligations.

</details>
