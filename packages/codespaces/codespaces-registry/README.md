---
description: "Durable per-workspace Codespaces environment state: the configuration and the provisioned codespace identity survive application restarts"
kind: "package-reference"
---

# @deepseek-ai/dsh-codespaces-registry

English | [中文](README.zh.md)

## Summary

`dsh-codespaces-registry` provides the durable Codespaces environment state service (`ctx.codespacesRegistry`): per-workspace storage for the Codespaces configuration and provisioned codespace identity. The state survives application restarts so a reconnect finds the same codespace instead of creating a second one. The service uses a storage domain table keyed by workspace id, with one `environments` table storing `CodespacesWorkspaceState` records.

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

Compose this service in any profile that uses Codespaces. The registry stores configuration and provisioned state per workspace:

```typescript
import type { CodespacesWorkspaceState } from '@deepseek-ai/dsh-codespaces-registry'

// Read the stored state for a workspace
const state = await ctx.codespacesRegistry.read(workspaceId)
// state is CodespacesWorkspaceState | undefined

// Save the complete state for a workspace
await ctx.codespacesRegistry.save(workspaceId, {
  kind: 'codespaces',
  repository: 'owner/name',
  branch: 'main',
  codespaceName: 'monalisa-hot-potato-vrpqrxxrx7x2rxx',
  workspaceUrl: new URL('https://github.com/codespaces/...'),
})

// Remove the stored state for a workspace (e.g., after deletion)
await ctx.codespacesRegistry.remove(workspaceId)
```

### State shape

The `CodespacesWorkspaceState` interface:

```typescript
{
  // Discriminant
  kind: 'codespaces',
  
  // Configuration (set before provision)
  repository: string,          // 'owner/name'
  branch?: string,            // Git ref
  machine?: string,           // Machine type
  devcontainerPath?: string,  // Devcontainer path
  idleTimeoutMinutes?: number,
  retentionPeriodMinutes?: number,
  location?: string,          // Azure region
  displayName?: string,
  
  // Provisioned identity (set after creation)
  codespaceName?: string,     // GitHub-assigned codespace name
  workspaceUrl?: URL,         // Forwarded harness URL
}
```

### Typical workflow

```typescript
// 1. User configures Codespaces for a workspace
const partial: CodespacesWorkspaceState = {
  kind: 'codespaces',
  repository: 'octocat/hello-world',
  branch: 'main',
  machine: 'basicLinux32gb',
}
await ctx.codespacesRegistry.save(workspaceId, partial)

// 2. Connection service reads state and provisions
const state = await ctx.codespacesRegistry.read(workspaceId)
// state.codespaceName is undefined, so provision is needed

// 3. After provision, connection service saves codespaceName and workspaceUrl
await ctx.codespacesRegistry.save(workspaceId, {
  ...state,
  codespaceName: 'my-codespace-name',
  workspaceUrl: new URL('https://...'),
})

// 4. On reconnect, connection service re-reads and reuses existing codespace
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service uses the storage domain system for durable state:

### Storage domain specification

```typescript
export const codespacesDomainSpec = defineDomain({
  name: 'codespaces',
  version: 1,
  tables: {
    environments: domainTable<WorkspaceId, CodespacesWorkspaceState>(codespacesWorkspaceState)
  },
})
```

### Schema validation

The `codespacesWorkspaceState` Zod schema enforces:
- `kind: 'codespaces'` (discriminant)
- `repository`: required, non-empty string (format: `owner/name`)
- All other fields: optional with specific validation
  - `branch`: non-empty string
  - `machine`: non-empty string
  - `devcontainerPath`: non-empty string
  - `idleTimeoutMinutes`: positive integer
  - `retentionPeriodMinutes`: integer between 0 and 43200 (30 days)
  - `location`: non-empty string
  - `displayName`: non-empty string
  - `codespaceName`: non-empty string (set after provision)
  - `workspaceUrl`: valid URL (set after connection)

### Storage operations

- **read**: Opens the domain, reads from `environments` table, returns `undefined` if not found
- **save**: Opens the domain, writes complete state to `environments` table (replaces entire record)
- **remove**: Opens the domain, deletes entry from `environments` table

### Dependencies

- `ctx.storageDomain` - Storage domain service for opening domains
- `@deepseek-ai/dsh-storage-domain` - Domain table utilities
- `zod` - Schema validation

### Table structure

The `environments` table maps `WorkspaceId` → `CodespacesWorkspaceState`. Each workspace has at most one Codespaces environment record.

### State evolution

The state evolves monotonically:
1. Configuration only (no `codespaceName` or `workspaceUrl`)
2. After provision: `codespaceName` added
3. After connection: `workspaceUrl` added
4. After stop: `workspaceUrl` removed
5. After deletion: entire record removed

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Codespaces package](../codespaces/README.md) — the GitHub Codespaces API service.
- [Codespaces connection package](../codespaces-connection/README.md) — the lifecycle service that uses this registry.
- [Storage domain package](../../storage/domain/README.md) — the underlying storage domain system.
- [Workspace package](../../workspace/README.md) — workspace identity and management.

<a id="model-experience"></a>
## Model Experience

None, as this package provides durable storage for Codespaces configuration only.

#### KV Cache effect

None; this service manages storage and makes no model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- State is stored per workspace; there is no global Codespaces configuration.
- The schema enforces a single Codespaces environment per workspace; multiple environments would require a different design.
- Record replacement is atomic; partial updates require read-modify-write by the caller.
- No migration support for schema changes; schema changes require a new domain version.
- No automatic cleanup of stale records; deletion is explicit.

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published. The storage domain service enforces data integrity; this registry owns only the schema and table access pattern.

</details>
